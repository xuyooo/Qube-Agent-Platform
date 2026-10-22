import type { JobWithMetadata, PgBoss } from 'pg-boss'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('./db', () => ({}))
import type { JobData } from './handler'
import { configureAgentSessionQueue, registerLostJobWorker } from './lost-job'
function harness() {
  let worker: (jobs: JobWithMetadata<JobData>[]) => Promise<void>
  const queues = new Map<string, unknown>([['agent-session', {}]])
  const boss = {
    createQueue: vi.fn(async (name, options) => {
      if (!queues.has(name)) queues.set(name, options)
    }),
    updateQueue: vi.fn(async (name, options) => {
      queues.set(name, options)
    }),
    work: vi.fn(async (_name, _options, callback) => {
      worker = callback
    }),
  } as unknown as PgBoss
  return {
    boss,
    queues,
    run: (job: JobWithMetadata<JobData>) => worker([job]),
  }
}
function job(reason: unknown = { value: { message: 'job heartbeat timeout' } }, type = 'wecom') {
  return {
    id: 'job1',
    output: reason,
    data: {
      workspace_id: 'ws1',
      prompt: 'PRIVATE_PROMPT',
      service_token: 'SECRET_TOKEN',
      trigger: {
        type,
        payload: {
          connector_id: 'c1',
          route_id: 'r1',
          reply_context: { thread_id: 't1' },
          images: ['PRIVATE_IMAGE'],
        },
      },
    },
  } as unknown as JobWithMetadata<JobData>
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('lost job notifications', () => {
  it.each(['job heartbeat timeout', 'job timed out'])(
    'notifies monitor failure %s',
    async (reason) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
      vi.stubGlobal('fetch', fetcher)
      const h = harness()
      await registerLostJobWorker(h.boss)
      await h.run(job({ value: { message: reason } }))
      const body = JSON.parse(fetcher.mock.calls[0][1].body)
      expect(body).toMatchObject({
        route_id: 'r1',
        reply_to: { thread_id: 't1' },
      })
      expect(body.text).toContain('Please retry')
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE|SECRET/)
    },
  )
  it.each(['slack', 'wecom'])('routes %s through the connector', async (type) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''))
    vi.stubGlobal('fetch', fetcher)
    const h = harness()
    await registerLostJobWorker(h.boss)
    await h.run(job(undefined, type))
    expect(fetcher.mock.calls[0][0]).toContain('/connectors/c1/send')
  })
  it('skips normal failures, success, manual and missing coordinates', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const h = harness()
    await registerLostJobWorker(h.boss)
    await h.run(job(null))
    await h.run(job({ message: 'job timed out' }))
    await h.run(job(undefined, 'manual'))
    const missing = job()
    missing.data.trigger.payload = {}
    await h.run(missing)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('retains monitor classification across failed delivery and worker restart', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('SECRET_TOKEN', { status: 503 }))
      .mockResolvedValueOnce(new Response(''))
    vi.stubGlobal('fetch', fetcher)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness()
    await registerLostJobWorker(h.boss)
    const failed = await h.run(job()).catch((error) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(JSON.stringify(failed)).not.toContain('SECRET')
    await registerLostJobWorker(h.boss)
    await h.run(job(JSON.parse(JSON.stringify(failed))))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET')
  })
  it('updates an existing queue and remains idempotent', async () => {
    const h = harness()
    await configureAgentSessionQueue(h.boss, 'agent-session', {
      retryLimit: 0,
    })
    await configureAgentSessionQueue(h.boss, 'agent-session', {
      retryLimit: 0,
    })
    expect(h.queues.size).toBe(2)
    expect(h.queues.get('agent-session')).toMatchObject({
      deadLetter: 'agent-session-dead-letter',
      retryLimit: 0,
    })
    expect(h.queues.get('agent-session-dead-letter')).toMatchObject({
      retryLimit: 2,
    })
  })
})
