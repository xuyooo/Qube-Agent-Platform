import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../../lib/types'
const db = vi.hoisted(() => ({
  getSession: vi.fn(),
  getWorkspace: vi.fn(),
  canAccessWorkspace: vi.fn(),
  countOpenAgentCalls: vi.fn(),
  query: vi.fn(),
}))
vi.mock('../../services/db/sessions', () => db)
vi.mock('../../services/db/workspaces', () => db)
vi.mock('../../lib/workspace-access', () => db)
vi.mock('../../services/db/agent-calls', () => db)
vi.mock('../../services/db/pool', () => ({ pool: db, generateId: () => 'id' }))
import sessions from './sessions'
const app = new OpenAPIHono<AppEnv>()
app.use('*', async (c, next) => {
  c.set('user', { sub: 'user', role: 'user' } as never)
  await next()
})
app.route('/', sessions)
beforeEach(() => {
  vi.resetAllMocks()
  db.getWorkspace.mockResolvedValue({ id: 'ws' })
  db.canAccessWorkspace.mockResolvedValue(true)
  db.getSession.mockResolvedValue({
    id: 's',
    workspace_id: 'ws',
    chat_status: 'idle',
    status: 'active',
    name: 'session',
    last_active_at: '2026-10-21T00:00:00Z',
  })
  db.query.mockResolvedValue({ rows: [] })
  db.countOpenAgentCalls.mockResolvedValue(2)
})
describe('session polling contract and authorization', () => {
  it('reports idle sessions with outstanding calls', async () => {
    const result = await app.request('/ws/sessions/s')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ chat_status: 'idle', pending_agent_calls: 2 })
  })
  it('does not reveal calls after workspace access is revoked', async () => {
    db.canAccessWorkspace.mockResolvedValue(false)
    expect((await app.request('/ws/sessions/s')).status).toBe(404)
    expect(db.countOpenAgentCalls).not.toHaveBeenCalled()
  })
  it('rejects a session belonging to another workspace', async () => {
    db.getSession.mockResolvedValue({ id: 's', workspace_id: 'foreign' })
    expect((await app.request('/ws/sessions/s')).status).toBe(404)
    expect(db.countOpenAgentCalls).not.toHaveBeenCalled()
  })
})
