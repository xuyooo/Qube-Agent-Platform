import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  updateSessionActivity: vi.fn(),
  transitionSessionStatus: vi.fn(),
  updateSessionStats: vi.fn(),
  insertAgentCall: vi.fn(),
  countOpenAgentCalls: vi.fn(),
  getLatestAgentCall: vi.fn(),
  consumeAgentCall: vi.fn(),
  addMessage: vi.fn(),
  insertUserMessageBlocks: vi.fn(),
  insertEvent: vi.fn(),
  upsertEvent: vi.fn(),
  updateMessageContent: vi.fn(),
  getWorkspace: vi.fn(),
  getWorkspaceConfig: vi.fn(),
  resolveWorkspaceBySlug: vi.fn(),
  resolveDeliveryTarget: vi.fn(),
  settleSessionTurn: vi.fn(),
  noteSessionInputRequested: vi.fn(),
}))
vi.mock('../../services/db/sessions', () => mocks)
vi.mock('../../services/db/agent-calls', () => mocks)
vi.mock('../../services/db/messages', () => mocks)
vi.mock('../../services/db/workspaces', () => mocks)
vi.mock('../../services/chat/agent-call-delivery', () => mocks)
vi.mock('../../services/chat/executeChat', () => ({ executeChat: vi.fn() }))
vi.mock('../../services/chat/session-turn', () => ({
  adoptSessionTurn: async () => ({ release: async () => {} }),
  claimSessionTurn: vi.fn(),
}))
vi.mock('../../lib/session-token', () => ({
  mintToken: async () => 'token',
  bindSession: async () => {},
}))
vi.mock('../../lib/workspace-address', () => ({ resolveAgentAddress: () => 'http://test-agent' }))
vi.mock('../../lib/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sse')>()
  return {
    ...actual,
    isDraining: () => false,
    createBroadcastPlugin: () => ({ name: 'test-broadcast' }),
    setupActiveStream: () => ({ activeStream: {}, getActiveKey: () => '', setActiveKey: () => {} }),
  }
})
import { registerAgentTools } from './agent'
let invoke: (input: {
  slug: string
  prompt: string
  mode: 'foreground' | 'background'
}) => Promise<{ content: { text: string }[] }>
beforeEach(() => {
  vi.resetAllMocks()
  registerAgentTools(
    {
      registerTool: (name: string, _spec: unknown, handler: typeof invoke) => {
        if (name === 'call_agent') invoke = handler
      },
    } as unknown as McpServer,
    'caller',
    null,
    'parent',
  )
  mocks.getWorkspace.mockResolvedValue({ id: 'caller', user_id: 'u' })
  mocks.resolveWorkspaceBySlug.mockResolvedValue({ id: 'target', status: 'running' })
  mocks.resolveDeliveryTarget.mockResolvedValue({ parentSessionId: 'parent', callerUserId: 'u' })
  mocks.countOpenAgentCalls.mockResolvedValue(0)
  mocks.addMessage.mockResolvedValue({ id: 'm1' })
  mocks.getWorkspaceConfig.mockResolvedValue({})
})
afterEach(() => vi.unstubAllGlobals())
function stream(reason = 'completed') {
  const events = [
    { type: 'session.started', session_id: 'child' },
    { type: 'session.ended', reason },
  ]
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
  )
}
describe('call_agent durable handoff', () => {
  it('waits for the call row before promising automatic delivery', async () => {
    stream()
    let release!: () => void
    mocks.insertAgentCall.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    let returned = false
    const result = invoke({ slug: 'target', prompt: 'work', mode: 'background' }).then((value) => {
      returned = true
      return value
    })
    await vi.waitFor(() => expect(mocks.insertAgentCall).toHaveBeenCalledTimes(1))
    expect(returned).toBe(false)
    release()
    expect(JSON.parse((await result).content[0].text)).toMatchObject({
      session_id: 'child',
      delivery: 'automatic',
    })
  })
  it('does not promise automatic delivery after persistence fails', async () => {
    stream()
    mocks.insertAgentCall.mockRejectedValue(new Error('database unavailable'))
    expect(
      (await invoke({ slug: 'target', prompt: 'work', mode: 'background' })).content[0].text,
    ).toContain('not confirmed')
  })
  it('reports a failed foreground turn as failed', async () => {
    stream('error')
    const result = await invoke({ slug: 'target', prompt: 'work', mode: 'foreground' })
    expect(JSON.parse(result.content[0].text).status).toBe('failed')
  })
})
