import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({
  getSession: vi.fn(),
  sessionHasLiveTurn: vi.fn(),
  getLatestAgentCall: vi.fn(),
  consumeAgentCall: vi.fn(),
  getLastAssistantMessage: vi.fn(),
}))
vi.mock('../../services/db/sessions', () => db)
vi.mock('../../services/db/agent-calls', () => db)
vi.mock('../../services/db/messages', () => db)
vi.mock('../../services/chat/executeChat', () => ({ executeChat: vi.fn() }))
vi.mock('../../services/chat/agent-call-delivery', () => ({}))
import { registerAgentTools } from './agent'
const handlers = new Map<
  string,
  (input: { session_id: string }) => Promise<{ content: { text: string }[] }>
>()
beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  registerAgentTools(
    {
      registerTool: (name: string, _config: unknown, handler: never) => handlers.set(name, handler),
    } as unknown as McpServer,
    'caller',
    null,
    'parent',
  )
  db.getLatestAgentCall.mockResolvedValue(null)
  db.sessionHasLiveTurn.mockResolvedValue(false)
  db.getLastAssistantMessage.mockResolvedValue({ content: 'private answer' })
})
async function result() {
  return (await handlers.get('get_agent_result')!({ session_id: 'child' })).content[0].text
}
describe('agent result access and status', () => {
  it('rejects a foreign session without reading its messages', async () => {
    db.getSession.mockResolvedValue({ workspace_id: 'foreign', caller_workspace_id: 'other' })
    expect(await result()).toContain('not accessible')
    expect(db.getLastAssistantMessage).not.toHaveBeenCalled()
  })
  it('does not expose an interim message while the child is running', async () => {
    db.getSession.mockResolvedValue({
      workspace_id: 'target',
      caller_workspace_id: 'caller',
      chat_status: 'agent',
    })
    db.sessionHasLiveTurn.mockResolvedValue(true)
    expect(JSON.parse(await result())).toMatchObject({ status: 'running' })
    expect(db.getLastAssistantMessage).not.toHaveBeenCalled()
  })
  it('allows the invoking workspace to read and consume its completed call', async () => {
    db.getSession.mockResolvedValue({ workspace_id: 'target', caller_workspace_id: 'caller' })
    db.getLatestAgentCall.mockResolvedValue({ status: 'ended', result_text: 'private answer' })
    expect(JSON.parse(await result())).toMatchObject({ status: 'ended', text: 'private answer' })
    expect(db.consumeAgentCall).toHaveBeenCalledWith('child', 'parent')
  })
  it('reports needs_input without consuming the open call', async () => {
    db.getSession.mockResolvedValue({ workspace_id: 'target', caller_workspace_id: 'caller' })
    db.getLatestAgentCall.mockResolvedValue({ status: 'running', input_requested_at: 'now' })
    expect(JSON.parse(await result()).status).toBe('needs_input')
    expect(db.consumeAgentCall).not.toHaveBeenCalled()
  })
})
