import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCall } from '../db/agent-calls'

const calls = vi.hoisted(() => ({
  countAgentCallDeliveries: vi.fn(),
  countOpenAgentCalls: vi.fn(),
  dropAgentCallDelivery: vi.fn(),
  endAgentCalls: vi.fn(),
  failAgentCallDelivery: vi.fn(),
  hasRunningCallAsChild: vi.fn(),
  listParentsWithDeliverableCalls: vi.fn(),
  listStaleRunningAgentCalls: vi.fn(),
  markAgentCallInputRequested: vi.fn(),
  markAgentCallsDelivered: vi.fn(),
  releaseAgentCallDelivery: vi.fn(),
  recordAgentCallTurnCompleted: vi.fn(),
  renewAgentCallDelivery: vi.fn().mockResolvedValue(undefined),
  takeDeliverableAgentCalls: vi.fn(),
}))
vi.mock('../db/agent-calls', () => calls)

const access = vi.hoisted(() => ({ canAccessWorkspace: vi.fn(), getUser: vi.fn() }))
vi.mock('../../lib/workspace-access', () => access)
vi.mock('../db/users', () => access)
const sessions = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../db/sessions', () => sessions)
const workspaces = vi.hoisted(() => ({ getWorkspace: vi.fn() }))
vi.mock('../db/workspaces', () => workspaces)
const messages = vi.hoisted(() => ({ getLastAssistantMessage: vi.fn() }))
vi.mock('../db/messages', () => messages)
// Stands in for chat dispatch, which the module is handed rather than imports.
const startTurn = vi.fn()
const sse = vi.hoisted(() => ({ isDraining: vi.fn() }))
vi.mock('../../lib/sse', () => sse)

const {
  deliverAgentCallResults,
  noteSessionInputRequested,
  resolveDeliveryTarget,
  settleSessionTurn,
  sweepAgentCalls,
} = await import('./agent-call-delivery')

function call(over: Partial<AgentCall> = {}): AgentCall {
  return {
    id: 'c1',
    parent_session_id: 'parent',
    parent_workspace_id: 'ws-parent',
    child_session_id: 'child',
    child_workspace_id: 'ws-child',
    caller_user_id: 'u1',
    status: 'ended',
    error: null,
    result_text: 'looks good',
    delivery: 'pending',
    delivery_note: null,
    delivery_attempts: 0,
    input_requested_at: null,
    input_notified_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    ...over,
  }
}

function sseResponse(): Response {
  return new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

function jsonResponse(status: number): Response {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  access.canAccessWorkspace.mockResolvedValue(true)
  access.getUser.mockResolvedValue({ role: 'user' })
  sse.isDraining.mockReturnValue(false)
  calls.countAgentCallDeliveries.mockResolvedValue(0)
  calls.countOpenAgentCalls.mockResolvedValue(0)
  calls.endAgentCalls.mockResolvedValue([])
  calls.failAgentCallDelivery.mockResolvedValue(undefined)
  calls.hasRunningCallAsChild.mockResolvedValue(false)
  calls.markAgentCallInputRequested.mockResolvedValue([])
  calls.takeDeliverableAgentCalls.mockResolvedValue([])
  sessions.getSession.mockResolvedValue({
    id: 'parent',
    workspace_id: 'ws-parent',
    status: 'active',
    source: 'web',
    caller_user_id: 'u1',
  })
  workspaces.getWorkspace.mockImplementation(async (id: string) => ({
    id,
    name: id === 'ws-child' ? 'Reviewer' : 'Main',
    slug: id === 'ws-child' ? 'reviewer' : null,
  }))
  messages.getLastAssistantMessage.mockResolvedValue({ content: 'looks good' })
  startTurn.mockResolvedValue(sseResponse())
})

describe('which sessions take deliveries', () => {
  it.each(['web', 'api'])('a %s session does', async (source) => {
    sessions.getSession.mockResolvedValue({
      workspace_id: 'ws-parent',
      source,
      caller_user_id: 'u1',
    })
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toEqual({
      parentSessionId: 'parent',
      callerUserId: 'u1',
    })
  })

  it.each(['schedule', 'slack', 'wecom', 'webhook', 'batch', 'manual'])(
    'a %s session does not: its consumer reads one turn',
    async (source) => {
      sessions.getSession.mockResolvedValue({ workspace_id: 'ws-parent', source })
      expect(await resolveDeliveryTarget('parent', 'ws-parent')).toBeNull()
    },
  )

  it('a session an agent called does only while that call is tracked', async () => {
    sessions.getSession.mockResolvedValue({
      workspace_id: 'ws-parent',
      source: 'agent',
      caller_user_id: null,
    })
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toBeNull()

    calls.hasRunningCallAsChild.mockResolvedValue(true)
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toEqual({
      parentSessionId: 'parent',
      callerUserId: null,
    })
  })

  it('no session, an unknown session, or another workspace’s session does not', async () => {
    expect(await resolveDeliveryTarget(null, 'ws-parent')).toBeNull()

    sessions.getSession.mockResolvedValue(null)
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toBeNull()

    sessions.getSession.mockResolvedValue({ workspace_id: 'ws-other', source: 'web' })
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toBeNull()
  })

  it('stops once the session has been woken too many times', async () => {
    calls.countAgentCallDeliveries.mockResolvedValue(50)
    expect(await resolveDeliveryTarget('parent', 'ws-parent')).toBeNull()
  })
})

describe('settling a turn', () => {
  it('closes the call that ran it and posts to the caller, then to itself', async () => {
    calls.endAgentCalls.mockResolvedValue([call()])

    await settleSessionTurn('child', { reason: 'completed' }, startTurn)

    expect(calls.endAgentCalls).toHaveBeenCalledWith('child', 'ended', null)
    expect(calls.takeDeliverableAgentCalls.mock.calls.map((c) => c[0])).toEqual(['parent', 'child'])
  })

  it('keeps the call running while the session waits on calls of its own', async () => {
    calls.countOpenAgentCalls.mockResolvedValue(2)

    await settleSessionTurn('child', { reason: 'completed' }, startTurn)

    expect(calls.endAgentCalls).not.toHaveBeenCalled()
  })

  it('records a turn that did not complete as failed, whatever it was waiting on', async () => {
    calls.countOpenAgentCalls.mockResolvedValue(2)

    await settleSessionTurn('child', { reason: 'error', error: 'model overloaded' }, startTurn)
    expect(calls.endAgentCalls).toHaveBeenLastCalledWith('child', 'failed', 'model overloaded')

    await settleSessionTurn('child', { reason: null }, startTurn)
    expect(calls.endAgentCalls).toHaveBeenLastCalledWith(
      'child',
      'failed',
      'turn ended with reason=stream lost',
    )
  })

  it('tells the caller when the session parks on a question', async () => {
    calls.markAgentCallInputRequested.mockResolvedValue([call({ status: 'running' })])

    await noteSessionInputRequested('child', startTurn)

    expect(calls.takeDeliverableAgentCalls).toHaveBeenCalledWith(
      'parent',
      expect.any(Number),
      expect.any(String),
    )
  })
})

describe('delivering results', () => {
  it('does nothing when no result is ready', async () => {
    await deliverAgentCallResults('parent', startTurn)

    expect(startTurn).not.toHaveBeenCalled()
    expect(sessions.getSession).not.toHaveBeenCalled()
  })

  it('does not start a turn on a replica that is shutting down', async () => {
    sse.isDraining.mockReturnValue(true)
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])

    await deliverAgentCallResults('parent', startTurn)

    expect(calls.takeDeliverableAgentCalls).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('posts every ready result as one turn in the calling session', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([
      call({ id: 'c1', child_session_id: 's1' }),
      call({ id: 'c2', child_session_id: 's2', status: 'failed', error: 'model overloaded' }),
    ])
    // Both finished calls still count as open until the post succeeds.
    calls.countOpenAgentCalls.mockResolvedValue(3)

    await deliverAgentCallResults('parent', startTurn)

    expect(startTurn).toHaveBeenCalledTimes(1)
    const opts = startTurn.mock.calls[0][0]
    expect(opts.sessionId).toBe('parent')
    expect(opts.callerUserId).toBe('u1')
    expect(opts.message).toContain('written by the platform, not by the user')
    expect(opts.message).toContain('Reviewer (@agent/reviewer) — session_id s1 — ended\nlooks good')
    expect(opts.message).toContain('session_id s2 — failed\nError: model overloaded')
    expect(opts.message).toContain('1 more call(s) from this session are still running')
    expect(calls.markAgentCallsDelivered).toHaveBeenCalledWith(
      ['c1', 'c2'],
      calls.takeDeliverableAgentCalls.mock.calls[0][2],
      [],
    )
  })

  it('says so when nothing else is outstanding', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    calls.countOpenAgentCalls.mockResolvedValue(1)

    await deliverAgentCallResults('parent', startTurn)

    expect(startTurn.mock.calls[0][0].message).toContain(
      'No calls from this session are still running.',
    )
  })

  it('reports a parked call without closing it or reading a reply', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([
      call({ status: 'running', input_requested_at: '2026-01-01T00:00:00Z' }),
    ])

    await deliverAgentCallResults('parent', startTurn)

    expect(startTurn.mock.calls[0][0].message).toContain('waiting for user input')
    expect(messages.getLastAssistantMessage).not.toHaveBeenCalled()
  })

  it('cuts a long reply and points at the full one', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    calls.takeDeliverableAgentCalls.mockResolvedValue([call({ result_text: 'x'.repeat(20_000) })])

    await deliverAgentCallResults('parent', startTurn)

    const { message } = startTurn.mock.calls[0][0]
    expect(message.length).toBeLessThan(17_000)
    expect(message).toContain('read the full reply with get_agent_result')
  })

  it('keeps the results for later when the calling session is mid-turn', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    startTurn.mockResolvedValue(jsonResponse(409))

    await deliverAgentCallResults('parent', startTurn)

    expect(calls.releaseAgentCallDelivery).toHaveBeenCalledWith(
      ['c1'],
      calls.takeDeliverableAgentCalls.mock.calls[0][2],
    )
    expect(calls.markAgentCallsDelivered).not.toHaveBeenCalled()
    expect(calls.failAgentCallDelivery).not.toHaveBeenCalled()
  })

  it('counts a failed post as an attempt and leaves the retry to the lease', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    startTurn.mockResolvedValue(jsonResponse(503))

    await deliverAgentCallResults('parent', startTurn)

    expect(calls.failAgentCallDelivery).toHaveBeenCalledWith(
      ['c1'],
      expect.any(Number),
      'chat dispatch returned 503',
      expect.any(String),
    )
    expect(calls.releaseAgentCallDelivery).not.toHaveBeenCalled()

    startTurn.mockRejectedValue(new Error('connection reset'))
    await deliverAgentCallResults('parent', startTurn)
    expect(calls.failAgentCallDelivery).toHaveBeenLastCalledWith(
      ['c1'],
      expect.any(Number),
      'connection reset',
      expect.any(String),
    )
  })

  it.each([
    ['deleted', null, 'calling session was deleted'],
    ['archived', { status: 'archived', workspace_id: 'ws-parent' }, 'calling session is archived'],
  ])('drops results whose calling session is %s', async (_label, session, note) => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    sessions.getSession.mockResolvedValue(session)

    await deliverAgentCallResults('parent', startTurn)

    expect(calls.dropAgentCallDelivery).toHaveBeenCalledWith(['c1'], note, expect.any(String))
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('drops results whose calling workspace is gone', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    workspaces.getWorkspace.mockResolvedValue(null)

    await deliverAgentCallResults('parent', startTurn)

    expect(calls.dropAgentCallDelivery).toHaveBeenCalledWith(
      ['c1'],
      'calling workspace was deleted',
      expect.any(String),
    )
  })
})

describe('recovery', () => {
  it('retries ready calls and fails an orphan conservatively', async () => {
    calls.listStaleRunningAgentCalls.mockResolvedValue([
      { child_session_id: 'orphan', session_gone: false },
    ])
    calls.listParentsWithDeliverableCalls.mockResolvedValue(['parent'])
    await sweepAgentCalls(startTurn)
    expect(calls.endAgentCalls).toHaveBeenCalledWith(
      'orphan',
      'failed',
      'the called turn ended without a recorded outcome',
    )
    expect(calls.takeDeliverableAgentCalls).toHaveBeenCalledWith('parent', 120, expect.any(String))
  })
  it('recovers deletion and does not launch overlapping sweeps', async () => {
    let resolve!: (value: unknown[]) => void
    calls.listStaleRunningAgentCalls.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    calls.listParentsWithDeliverableCalls.mockResolvedValue([])
    const first = sweepAgentCalls(startTurn)
    await sweepAgentCalls(startTurn)
    expect(calls.listStaleRunningAgentCalls).toHaveBeenCalledTimes(1)
    resolve([{ child_session_id: 'deleted', session_gone: true }])
    await first
    expect(calls.endAgentCalls).toHaveBeenCalledWith(
      'deleted',
      'failed',
      'the called session was deleted',
    )
  })
  it('keeps a final result pending when acknowledging an earlier question snapshot', async () => {
    calls.takeDeliverableAgentCalls.mockResolvedValue([
      call({ status: 'running', input_requested_at: 'now' }),
    ])
    await deliverAgentCallResults('parent', startTurn)
    expect(calls.markAgentCallsDelivered).toHaveBeenCalledWith(['c1'], expect.any(String), ['c1'])
  })
})

it('drops delivery after workspace sharing is revoked', async () => {
  calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
  access.canAccessWorkspace.mockResolvedValue(false)
  await deliverAgentCallResults('parent', startTurn)
  expect(startTurn).not.toHaveBeenCalled()
  expect(calls.dropAgentCallDelivery).toHaveBeenCalledWith(
    ['c1'],
    'caller no longer has workspace access',
    expect.any(String),
  )
})

it('recovers a completed nested turn whose delivery acknowledgement arrived late', async () => {
  calls.listStaleRunningAgentCalls.mockResolvedValue([
    { child_session_id: 'child', session_gone: false, turn_completed: true },
  ])
  calls.listParentsWithDeliverableCalls.mockResolvedValue([])
  await sweepAgentCalls(startTurn)
  expect(calls.endAgentCalls).toHaveBeenCalledWith('child', 'ended', null)
})

it('renews a slow dispatch lease and stops renewing after acknowledgement', async () => {
  vi.useFakeTimers()
  try {
    calls.takeDeliverableAgentCalls.mockResolvedValue([call()])
    let finish!: (response: Response) => void
    startTurn.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const delivery = deliverAgentCallResults('parent', startTurn)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(startTurn).toHaveBeenCalledTimes(1)
    const token = calls.takeDeliverableAgentCalls.mock.calls[0][2]
    expect(calls.renewAgentCallDelivery).toHaveBeenCalledWith(['c1'], token, 120)
    finish(sseResponse())
    await delivery
    calls.renewAgentCallDelivery.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.renewAgentCallDelivery).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
