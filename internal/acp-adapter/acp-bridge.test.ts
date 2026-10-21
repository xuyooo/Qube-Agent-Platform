import { afterEach, describe, expect, it, vi } from 'vitest'
const proc = vi.hoisted(() => ({ entries: [] as string[], stat: '', denied: false }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readdirSync: () => { if(proc.denied) throw new Error('denied'); return proc.entries }, readFileSync: () => proc.stat }))
import { AcpBridge, BridgeWorkerDiedError } from './acp-bridge'
afterEach(() => { vi.useRealTimers(); proc.entries=[]; proc.denied=false })
function harness() {
  const bridge = new AcpBridge({ program:'test', args:[], cwd:'.', runsTurnsInWorkerProcess:true })
  // Install a protocol transport without launching a model or external process.
  const internals = bridge as unknown as { child: unknown; connection: unknown; startWorkerWatch():void }
  const kill = vi.fn()
  internals.child = {pid:10, exitCode:null, signalCode:null, kill}
  internals.connection = {prompt: () => new Promise(() => {})}
  internals.startWorkerWatch()
  return {bridge,kill}
}
describe('worker loss', () => {
  it('fails an outstanding prompt after two missing checks and destroys the bridge', async () => {
    vi.useFakeTimers()
    const {bridge,kill} = harness()
    const result = bridge.prompt('s','hi').catch(error => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toBeInstanceOf(BridgeWorkerDiedError)
    expect(bridge.isAlive()).toBe(false)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not kill idle bridges or fail on an unreadable process table', async () => {
    vi.useFakeTimers()
    const {bridge,kill} = harness()
    await vi.advanceTimersByTimeAsync(30000)
    expect(kill).not.toHaveBeenCalled()
    proc.denied=true
    const result = bridge.prompt('s','hi').catch(error => error)
    await vi.advanceTimersByTimeAsync(30000)
    expect(kill).not.toHaveBeenCalled()
    bridge.destroy()
    expect(await result).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('resets the missing count when the worker reappears', async () => {
    vi.useFakeTimers()
    const {bridge,kill} = harness()
    const result = bridge.prompt('s','hi').catch(error => error)
    await vi.advanceTimersByTimeAsync(10000)
    proc.entries=['11']; proc.stat='11 (codex) S 10 0'
    await vi.advanceTimersByTimeAsync(10000)
    proc.entries=[]
    await vi.advanceTimersByTimeAsync(10000)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toBeInstanceOf(BridgeWorkerDiedError)
  })
})
