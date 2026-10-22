import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ query: vi.fn(), next: 0 }))
vi.mock('./pool', () => ({
  pool: { query: bridge.query },
  generateId: () => `call-${++bridge.next}`,
}))
import {
  consumeAgentCall,
  countOpenAgentCalls,
  endAgentCalls,
  failAgentCallDelivery,
  insertAgentCall,
  listStaleRunningAgentCalls,
  markAgentCallInputRequested,
  markAgentCallsDelivered,
  recordAgentCallTurnCompleted,
  releaseAgentCallDelivery,
  resetAgentCallTurnOutcome,
  takeDeliverableAgentCalls,
} from './agent-calls'
let pg: PGlite
const migration = readFileSync('migrations/148_agent_calls.sql', 'utf8')
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`CREATE TABLE sessions (id text PRIMARY KEY, chat_status text DEFAULT 'idle', turn_claim text, turn_claim_expires_at timestamptz);
    CREATE TABLE messages (session_id text, role text, content text, created_at timestamptz DEFAULT now());`)
  await pg.exec(`BEGIN;${migration}ROLLBACK;`)
  expect(
    (
      await pg.query<{ name: string | null }>(
        "SELECT to_regclass('public.agent_calls')::text AS name",
      )
    ).rows[0].name,
  ).toBeNull()
  await pg.exec(migration)
  bridge.query.mockImplementation(async (sql: string, args: unknown[]) => {
    const result = await pg.query(sql, args)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  })
}, 30_000)
afterAll(async () => {
  await pg?.close()
})
beforeEach(async () => {
  await pg.exec(
    "TRUNCATE agent_calls, sessions, messages; INSERT INTO sessions(id) VALUES ('parent'),('child');",
  )
  await insertAgentCall({
    parentSessionId: 'parent',
    parentWorkspaceId: 'wp',
    childSessionId: 'child',
    childWorkspaceId: 'wc',
    callerUserId: 'u',
  })
})
async function finish() {
  await pg.exec("INSERT INTO messages VALUES ('child','assistant','original result',now());")
  await endAgentCalls('child', 'ended', null)
}
describe('AgentCall migration and SQL on embedded PostgreSQL', () => {
  it('applies repeatedly without deleting calls or adding Kanban fields', async () => {
    await pg.exec(migration)
    expect(await countOpenAgentCalls('parent')).toBe(1)
    const columns = await pg.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='agent_calls'",
    )
    expect(columns.rows.map((x) => x.column_name).join(',')).not.toMatch(/board|task/)
    await expect(pg.exec("UPDATE agent_calls SET status='invalid'")).rejects.toThrow()
  })
  it('snapshots a completed reply even when the child continues', async () => {
    await finish()
    await pg.exec(
      "INSERT INTO messages VALUES ('child','assistant','unrelated later reply',now()+interval '1 second');",
    )
    const calls = await takeDeliverableAgentCalls('parent', 120, 'owner')
    expect(calls[0].result_text).toBe('original result')
  })
  it('leases once and fences an expired owner after another replica claims it', async () => {
    await finish()
    const [a, b] = await Promise.all([
      takeDeliverableAgentCalls('parent', 120, 'a'),
      takeDeliverableAgentCalls('parent', 120, 'b'),
    ])
    expect(a.length + b.length).toBe(1)
    const id = [...a, ...b][0].id
    await pg.exec("UPDATE agent_calls SET delivery_lease_expires_at=now()-interval '1 second'")
    expect(await takeDeliverableAgentCalls('parent', 120, 'new')).toHaveLength(1)
    await markAgentCallsDelivered([id], a.length ? 'a' : 'b', [])
    expect(await countOpenAgentCalls('parent')).toBe(1)
    await markAgentCallsDelivered([id], 'new', [])
    expect(await countOpenAgentCalls('parent')).toBe(0)
  })
  it('acknowledges a question snapshot without swallowing a racing final result', async () => {
    await markAgentCallInputRequested('child')
    const [call] = await takeDeliverableAgentCalls('parent', 120, 'question')
    await finish()
    await markAgentCallsDelivered([call.id], 'question', [call.id])
    expect(await countOpenAgentCalls('parent')).toBe(1)
    const [final] = await takeDeliverableAgentCalls('parent', 120, 'final')
    expect(final.result_text).toBe('original result')
    await markAgentCallsDelivered([final.id], 'final', [])
    expect(await countOpenAgentCalls('parent')).toBe(0)
  })
  it('consumes only an unleased finished result', async () => {
    await finish()
    const [call] = await takeDeliverableAgentCalls('parent', 120, 'owner')
    expect(await consumeAgentCall('child', 'parent')).toBe(false)
    await releaseAgentCallDelivery([call.id], 'owner')
    expect(await consumeAgentCall('child', 'parent')).toBe(true)
    expect(await takeDeliverableAgentCalls('parent', 120, 'another')).toEqual([])
  })
  it('bounds retries and leaves a terminal diagnostic', async () => {
    await finish()
    const [call] = await takeDeliverableAgentCalls('parent', 120, 'owner')
    await failAgentCallDelivery([call.id], 2, 'unavailable', 'owner')
    await failAgentCallDelivery([call.id], 2, 'unavailable', 'owner')
    const result = await pg.query<{ delivery: string; delivery_attempts: number }>(
      'SELECT * FROM agent_calls',
    )
    expect(result.rows[0]).toMatchObject({ delivery: 'dropped', delivery_attempts: 2 })
    expect(await countOpenAgentCalls('parent')).toBe(0)
  })
  it('excludes a parked question but detects deleted and idle orphan children', async () => {
    await pg.exec("UPDATE agent_calls SET created_at=now()-interval '5 minutes'")
    expect(await listStaleRunningAgentCalls(120, 200)).toEqual([
      { child_session_id: 'child', session_gone: false, turn_completed: false },
    ])
    await markAgentCallInputRequested('child')
    expect(await listStaleRunningAgentCalls(120, 200)).toEqual([])
    await pg.exec("DELETE FROM sessions WHERE id='child'")
    expect(await listStaleRunningAgentCalls(120, 200)).toEqual([
      { child_session_id: 'child', session_gone: true, turn_completed: false },
    ])
  })
})

it('remembers a completed nested turn but clears it before a continuation', async () => {
  await pg.exec("UPDATE agent_calls SET created_at=now()-interval '5 minutes'")
  await recordAgentCallTurnCompleted('child')
  expect((await listStaleRunningAgentCalls(120, 200))[0].turn_completed).toBe(true)
  await resetAgentCallTurnOutcome('child')
  expect((await listStaleRunningAgentCalls(120, 200))[0].turn_completed).toBe(false)
})
