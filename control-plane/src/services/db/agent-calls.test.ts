import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('./pool', () => ({ pool: { query }, generateId: () => 'new-call' }))
import {
  consumeAgentCall,
  listStaleRunningAgentCalls,
  markAgentCallsDelivered,
  releaseAgentCallDelivery,
  takeDeliverableAgentCalls,
} from './agent-calls'
beforeEach(() => query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }))
describe('AgentCall database boundaries', () => {
  it('fences leased updates with a unique delivery owner', async () => {
    await takeDeliverableAgentCalls('parent', 120, 'lease-1')
    expect(query.mock.calls[0][0]).toContain('delivery_lease_token = $3')
    expect(query.mock.calls[0][1]).toEqual(['parent', 120, 'lease-1'])
    await releaseAgentCallDelivery(['call'], 'lease-1')
    expect(query.mock.calls[1][0]).toContain('delivery_lease_token = $2')
  })
  it('does not consume a result another replica is delivering', async () => {
    await consumeAgentCall('child', 'parent')
    expect(query.mock.calls[0][0]).toContain('delivery_lease_expires_at <= now()')
  })
  it('acknowledges a question snapshot without consuming a concurrent final result', async () => {
    await markAgentCallsDelivered(['call'], 'lease-1', ['call'])
    expect(query.mock.calls[0][0]).toContain('id = ANY($3)')
    expect(query.mock.calls[0][0]).toContain('delivery_lease_token = $2')
    expect(query.mock.calls[0][1]).toEqual([['call'], 'lease-1', ['call']])
  })
  it('does not infer a completed call from a parked question', async () => {
    await listStaleRunningAgentCalls(120, 200)
    expect(query.mock.calls[0][0]).toContain('c.input_requested_at IS NULL')
  })
})
