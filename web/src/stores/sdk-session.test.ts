import { describe, expect, it, vi } from 'vitest'
import { createSessionSSEClient } from '../../../internal/ui-sdk/src/session/sse'
import { createAgentSessionStore, type AgentSessionDeps, type SSEHandlers } from '../../../internal/ui-sdk/src/session/agent-session-store'
const response = (id: string) => new Response('data: ' + JSON.stringify({ type: 'session.started', session_id: id }) + '\n\ndata: ' + JSON.stringify({ type: 'session.ended', session_id: id, reason: 'completed' }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
function dependencies(): AgentSessionDeps {
 return {
  api: { getWorkspaceMessages: vi.fn(async () => []), getSession: vi.fn(async () => ({ chat_status: 'idle', pending_message: null, pending_agent_calls: 2, last_active_at: '1' })), setPendingMessage: vi.fn(async () => {}), clearPendingMessage: vi.fn(async () => {}), getPendingQuestion: vi.fn(async () => null), respondToQuestion: vi.fn(async () => {}), interruptSession: vi.fn(async () => ({ success: true })), deleteSession: vi.fn(async () => {}) },
  sse: { createAgentChat: vi.fn(), createCPReconnectStream: vi.fn() },
  effects: { onSessionCreated: vi.fn(), onTurnComplete: vi.fn(), invalidateSessions: vi.fn(), invalidateWorkspaces: vi.fn() },
 }
}
describe('independent SDK sessions', () => {
 it('isolates endpoint, headers and cookies for SSE clients and supports a custom endpoint', async () => {
   const fetchA = vi.fn(async () => response('a')), fetchB = vi.fn(async () => response('b'))
   const a = createSessionSSEClient({ apiUrl: 'https://a/api', proxyUrl: 'https://a/proxy', fetch: fetchA, credentials: 'omit', getHeaders: () => ({ Authorization: 'Bearer A' }) })
   const b = createSessionSSEClient({ apiUrl: 'https://b/api', proxyUrl: 'https://b/proxy', fetch: fetchB, credentials: 'include', getHeaders: () => ({ Authorization: 'Bearer B' }) })
   const endA = vi.fn(), endB = vi.fn()
   a.createAgentChat('w', '', 'a', { onSessionEnded: endA }, undefined, [{ data: 'image', media_type: 'image/png' }])
   b.createAgentChat('w', 'b', 'b', { onSessionEnded: endB, chatEndpoint: 'https://b/custom' })
   await vi.waitFor(() => { expect(endA).toHaveBeenCalledOnce(); expect(endB).toHaveBeenCalledOnce() })
   const [url, init] = (fetchA.mock.calls as unknown as [string, RequestInit][])[0]
   expect(url).toBe('https://a/api/workspaces/w/chat'); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer A'); expect(init.credentials).toBe('omit'); expect(JSON.parse(init.body as string).images).toHaveLength(1)
   expect((fetchB.mock.calls as unknown as [string, RequestInit][])[0][0]).toBe('https://b/custom')
 })
 it('suppresses a late failure after abort', async () => {
   let finish!: (r: Response) => void
   const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
   const client = createSessionSSEClient({ apiUrl: '/api', proxyUrl: '/proxy', fetch })
   const abort = new AbortController(), onError = vi.fn()
   client.createAgentChat('w', 'hello', 's', { onError }, abort.signal)
   await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); abort.abort(); finish(new Response('{"error":"late"}', { status: 500 }))
   await new Promise(resolve => setTimeout(resolve, 20)); expect(onError).not.toHaveBeenCalled()
 })
 it('tracks waiting and follows a server-started turn without modifying another instance', async () => {
   const deps = dependencies(), otherDeps = dependencies()
   const a = createAgentSessionStore('w1', deps), b = createAgentSessionStore('w2', otherDeps)
   await a.getState().switchSession('parent'); await b.getState().switchSession('other')
   expect(a.getState().pendingAgentCalls).toBe(2)
   vi.mocked(deps.api.getSession).mockResolvedValue({ chat_status: 'agent', pending_message: null, pending_agent_calls: 0, last_active_at: '2' })
   await a.getState().syncRemoteTurn()
   expect(deps.sse.createCPReconnectStream).toHaveBeenCalledOnce(); expect(a.getState().pendingAgentCalls).toBe(0)
   expect(b.getState().activeSessionId).toBe('other'); expect(otherDeps.sse.createCPReconnectStream).not.toHaveBeenCalled()
   const callbacks = vi.mocked(deps.sse.createCPReconnectStream).mock.calls[0][1] as SSEHandlers
   await a.getState().switchSession('new')
   callbacks.onItemDelta?.('stale', { type: 'text', text: 'late old event' })
   expect(JSON.stringify(a.getState().messages)).not.toContain('late old event')
   a.getState().destroy(); b.getState().destroy()
 })
})
