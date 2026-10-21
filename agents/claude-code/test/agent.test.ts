import { beforeEach, describe, expect, it, vi } from 'vitest'
const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)
vi.mock('../src/config.js', () => ({ CP_URL: '', WORKSPACE_DIR: '.', WORKSPACE_ID: '', applyProviderEnv: vi.fn(), cpAuthHeaders: () => ({}), getMaxTurns: () => 10, getUserMcpServers: () => ({}), loadRuntimeConfig: () => ({ model: 'test' }) }))
vi.mock('../src/web-tools.js', () => ({ jinaServer: {} }))
import { chat, interruptSession } from '../src/agent.js'
const result = { type: 'result', subtype: 'success', session_id: 's', num_turns: 1 }
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 's' }
const callbacks = () => ({ onMessage: vi.fn(), onError: vi.fn(), onComplete: vi.fn() })
beforeEach(() => vi.clearAllMocks())
describe('Claude input lifetime', () => {
  it('keeps permission input open after the first result until background agents become idle', async () => {
    let pending!: Promise<IteratorResult<unknown>>
    let closed = false
    sdk.query.mockImplementation(({ prompt, options }) => (async function* () {
      expect(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1')
      const input = prompt[Symbol.asyncIterator]()
      expect((await input.next()).done).toBe(false)
      pending = input.next().then((value: IteratorResult<unknown>) => { closed = true; return value })
      yield idle // startup idle must not release input
      yield result
      await new Promise(r => setTimeout(r, 0))
      expect(closed).toBe(false)
      expect(await options.canUseTool('Read', { path: 'a' }, { signal: new AbortController().signal })).toEqual({ behavior: 'allow', updatedInput: { path: 'a' } })
      yield result // background completion
      yield idle
      expect((await pending).done).toBe(true)
    })())
    const cb = callbacks()
    await chat('s', 'hi', undefined, cb)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onComplete).toHaveBeenCalledTimes(1)
    expect(closed).toBe(true)
  })
  it.each(['error', 'disconnect', 'interrupt'])('releases input on %s', async mode => {
    let pending!: Promise<IteratorResult<unknown>>
    sdk.query.mockImplementation(({ prompt, options }) => (async function* () {
      const input = prompt[Symbol.asyncIterator]()
      await input.next()
      pending = input.next()
      if (mode === 'interrupt') {
        expect(interruptSession('s')).toBe(true)
        expect(options.abortController.signal.aborted).toBe(true)
        throw new Error('aborted')
      }
      if (mode === 'error') throw new Error('SDK exited')
    })())
    const cb = callbacks()
    await chat('s', 'hi', undefined, cb)
    expect((await pending).done).toBe(true)
    expect(cb.onError).toHaveBeenCalledTimes(mode === 'error' ? 1 : 0)
    expect(interruptSession('s')).toBe(false)
  })
  it('supersedes the old turn without removing the new controller', async () => {
    let firstStarted!: () => void
    const started = new Promise<void>(r => { firstStarted = r })
    let oldInput!: Promise<IteratorResult<unknown>>
    sdk.query.mockImplementationOnce(({ prompt, options }) => (async function* () {
      const input = prompt[Symbol.asyncIterator]()
      await input.next(); oldInput = input.next(); firstStarted()
      await new Promise<void>(r => options.abortController.signal.addEventListener('abort', () => r(), {once:true}))
      throw new Error('aborted')
    })()).mockImplementationOnce(({prompt}) => (async function* () {
      const input = prompt[Symbol.asyncIterator](); await input.next()
      expect((await oldInput).done).toBe(true)
      expect(interruptSession('s')).toBe(true)
      throw new Error('aborted')
    })())
    const first = chat('s', 'one', undefined, callbacks())
    await started
    const cb = callbacks()
    await chat('s', 'two', undefined, cb)
    await first
    expect(cb.onError).not.toHaveBeenCalled()
  })
})
