/**
 * Dead-letter sink for agent-session jobs that pg-boss's monitor failed on its
 * own — a heartbeat timeout (the scheduler process died mid-job, e.g. OOM) or
 * an expiry. No handler is left running for those jobs, so nothing tells the
 * source channel the result is not coming; this worker sends that notice.
 *
 * Jobs the handler failed itself reach this queue too, but the handler already
 * replied with the error before throwing, so they are skipped here.
 *
 * Kept apart from the shared dead-letter worker: that one logs the full
 * payload, and agent-session payloads carry a service token and images.
 */
import type { JobWithMetadata, PgBoss } from 'pg-boss'
import { type JobData, sendReply } from './handler'

export const AGENT_SESSION_DEAD_LETTER_QUEUE = 'agent-session-dead-letter'

/** Failure messages pg-boss's monitor writes into a job's output. */
const MONITOR_FAILURES = new Set(['job heartbeat timeout', 'job timed out'])

const LOST_JOB_REPLY =
  'The service restarted while this job was running, so its result could not be delivered here. Please retry.'

/** Idempotently create the agent-session dead-letter queue. Must exist before
 *  the agent-session queue references it. */
export async function ensureLostJobQueue(boss: PgBoss): Promise<void> {
  const options = { retryLimit: 2, retentionSeconds: 7 * 24 * 3600 }
  await boss.createQueue(AGENT_SESSION_DEAD_LETTER_QUEUE, options)
  await boss.updateQueue(AGENT_SESSION_DEAD_LETTER_QUEUE, options)
}

export async function configureAgentSessionQueue(
  boss: PgBoss,
  name: string,
  options: Parameters<PgBoss['createQueue']>[1],
): Promise<void> {
  await ensureLostJobQueue(boss)
  const configured = {
    ...options,
    deadLetter: AGENT_SESSION_DEAD_LETTER_QUEUE,
  }
  await boss.createQueue(name, configured)
  await boss.updateQueue(name, configured)
}

function monitorFailure(output: unknown): string | null {
  const message = (output as { value?: { message?: unknown } } | null)?.value?.message
  return typeof message === 'string' && MONITOR_FAILURES.has(message) ? message : null
}

export async function registerLostJobWorker(boss: PgBoss): Promise<void> {
  await boss.work<JobData>(
    AGENT_SESSION_DEAD_LETTER_QUEUE,
    { localConcurrency: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<JobData>[]) => {
      for (const job of jobs) {
        const failure = monitorFailure(job.output)
        const trigger = job.data?.trigger
        if (!failure || !trigger || trigger.type === 'manual') continue
        const payload = trigger.payload as Record<string, unknown> | undefined
        if (!payload?.connector_id || !payload?.route_id) continue
        console.warn(
          `[LostJob] notifying source of lost job dlq_id=${job.id} workspace=${job.data.workspace_id} trigger=${trigger.type} reason="${failure}"`,
        )
        try {
          if (!(await sendReply(trigger, LOST_JOB_REPLY))) throw new Error('Delivery failed')
        } catch {
          // pg-boss replaces output with the delivery error on retry. Retain the
          // monitor classification without persisting provider errors or payloads.
          throw Object.assign(new Error('Lost-job notification delivery failed'), {
            value: { message: failure },
          })
        }
      }
    },
  )

  console.log('[LostJob] Agent-session dead-letter worker registered')
}
