import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeStreams, createInterceptedSSEResponse, setupActiveStream } from './sse'

afterEach(() => {
  for (const stream of activeStreams.values()) {
    if (stream.heartbeatTimer) clearInterval(stream.heartbeatTimer)
  }
  activeStreams.clear()
})

// A turn that takes a session over leaves the earlier turn's stream open: that
// stream ends when the agent closes it, which can be much later or never.
// Whatever the earlier turn holds for the session has to be given up at the
// takeover, not at the end of its stream.
describe('setupActiveStream replacement', () => {
  it('does not settle the replacement turn when the old stream eventually closes', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const afterTurn = vi.fn()
    const onTurnEnd = vi.fn()
    const onSessionSettled = vi.fn()
    createInterceptedSSEResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
      {
        workspaceId: 'ws1',
        existingSessionId: 's1',
        userMessageText: null,
        onSessionSettled,
        onTurnEnd,
        turnHooks: { afterTurn, onInputRequested: vi.fn() },
      },
    )
    const replacement = setupActiveStream('ws1', 's1').activeStream
    upstream.close()
    await vi.waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1))
    expect(onSessionSettled).toHaveBeenCalledTimes(1)
    expect(afterTurn).not.toHaveBeenCalled()
    expect(activeStreams.get('ws1:s1')).toBe(replacement)
  })

  it('tells the stream it replaces', () => {
    const first = setupActiveStream('ws1', 's1').activeStream
    first.onReplaced = vi.fn()

    const second = setupActiveStream('ws1', 's1').activeStream

    expect(first.onReplaced).toHaveBeenCalledTimes(1)
    expect(first.done).toBe(true)
    expect(activeStreams.get('ws1:s1')).toBe(second)
  })

  it('leaves streams of other sessions alone', () => {
    const other = setupActiveStream('ws1', 's2').activeStream
    other.onReplaced = vi.fn()

    setupActiveStream('ws1', 's1')

    expect(other.onReplaced).not.toHaveBeenCalled()
    expect(other.done).toBe(false)
  })

  it('settles the session of an intercepted turn that is replaced', async () => {
    const onSessionSettled = vi.fn()
    // An agent stream that stays open and silent, like a turn whose agent
    // side has moved on to the turn that replaced it.
    const silent = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
    createInterceptedSSEResponse(silent, {
      workspaceId: 'ws1',
      userMessageText: null,
      existingSessionId: 's1',
      onSessionSettled,
      turnHooks: { afterTurn: vi.fn(), onInputRequested: vi.fn() },
    })
    expect(onSessionSettled).not.toHaveBeenCalled()

    setupActiveStream('ws1', 's1')

    expect(onSessionSettled).toHaveBeenCalledTimes(1)
  })
})
