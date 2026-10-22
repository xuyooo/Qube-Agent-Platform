import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBody } from '../../../../internal/types/api'
import type { Workspace } from '../db/types'
const mocks = vi.hoisted(() => ({
  executeChat: vi.fn(),
  countOpenAgentCalls: vi.fn(),
  getMessages: vi.fn(),
}))
vi.mock('./executeChat', () => mocks)
vi.mock('../db/agent-calls', () => mocks)
vi.mock('../db/messages', () => mocks)
import { dispatchChatTurn } from './dispatchChatTurn'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.countOpenAgentCalls.mockResolvedValue(2)
  mocks.getMessages.mockResolvedValue([])
})
function response() {
  return new Response(
    [
      'event: session.started\ndata: {"type":"session.started","session_id":"s1"}\n\n',
      'event: session.ended\ndata: {"type":"session.ended","reason":"completed"}\n\n',
    ].join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
function run(mode: 'sync' | 'async' | 'stream') {
  return dispatchChatTurn({
    workspace: { id: 'ws' } as Workspace,
    body: { message: 'hi', source: 'api', mode } as ChatBody,
    acceptHeader: undefined,
    callerUserId: 'user',
  })
}
describe('AgentCall chat API contract', () => {
  it('reports pending calls instead of treating a completed turn as a completed session', async () => {
    mocks.executeChat.mockResolvedValue(response())
    expect(await (await run('sync')).json()).toMatchObject({
      session_id: 's1',
      pending_agent_calls: 2,
    })
  })
  it('keeps async dispatch detached and returns the session for polling', async () => {
    mocks.executeChat.mockResolvedValue(response())
    const result = await run('async')
    expect(result.status).toBe(202)
    expect(await result.json()).toMatchObject({ session_id: 's1', status: 'running' })
  })
  it('preserves the SSE response for stream clients', async () => {
    const stream = response()
    mocks.executeChat.mockResolvedValue(stream)
    expect(await run('stream')).toBe(stream)
  })
  it('preserves busy/error responses without pretending a result was delivered', async () => {
    const error = new Response('{"error":"busy"}', {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
    mocks.executeChat.mockResolvedValue(error)
    expect(await run('sync')).toBe(error)
    expect(mocks.countOpenAgentCalls).not.toHaveBeenCalled()
  })
})
