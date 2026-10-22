import { describe, expect, it } from 'vitest'
import type { UniversalEvent } from '../../../internal/types/events'
import { MAX_TOOL_OUTPUT_BYTES, capToolResultEvent } from './truncate-tool-output'

function toolResultEvent(output: string): UniversalEvent {
  return {
    type: 'item.completed',
    timestamp: 1,
    session_id: 's1',
    item: {
      item_id: 'i1',
      kind: 'tool_result',
      role: 'tool',
      status: 'completed',
      content: [{ type: 'tool_result', call_id: 'c1', output, is_error: false }],
    },
  }
}

describe('capToolResultEvent', () => {
  it('returns the raw data untouched for an output within the cap', () => {
    const evt = toolResultEvent('ok')
    const raw = JSON.stringify(evt)
    expect(capToolResultEvent(evt, raw)).toBe(raw)
  })

  it('returns the raw data untouched for non-tool_result events', () => {
    const evt: UniversalEvent = {
      type: 'item.completed',
      timestamp: 1,
      item: {
        item_id: 'i2',
        kind: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'text', text: 'x'.repeat(MAX_TOOL_OUTPUT_BYTES * 2) }],
      },
    }
    const raw = JSON.stringify(evt)
    expect(capToolResultEvent(evt, raw)).toBe(raw)
  })

  it('caps an oversized output and keeps the rest of the event', () => {
    const evt = toolResultEvent('日志'.repeat(MAX_TOOL_OUTPUT_BYTES))
    const capped = JSON.parse(capToolResultEvent(evt, JSON.stringify(evt))) as UniversalEvent
    const part = capped.item?.content[0]
    expect(Buffer.byteLength(part?.output ?? '', 'utf8')).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 200)
    expect(part?.output).toContain('[truncated by cp:')
    expect(part?.call_id).toBe('c1')
    expect(capped.session_id).toBe('s1')
    expect(capped.item?.item_id).toBe('i1')
  })
})

// Boundary coverage shared with persistence semantics.
describe('broadcast boundaries', () => {
  it.each([31 * 1024, 32 * 1024, 64 * 1024, 10 * 1024 * 1024])(
    'caps only oversized outputs (%i bytes)',
    (size) => {
      const evt = toolResultEvent('x'.repeat(size))
      const raw = JSON.stringify(evt)
      const result = capToolResultEvent(evt, raw)
      if (size <= MAX_TOOL_OUTPUT_BYTES) expect(result).toBe(raw)
      else {
        expect(result.length).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 500)
        expect(JSON.parse(result).item.content[0].output).toContain('[truncated by cp:')
      }
    },
  )
  it('keeps small errors and NUL untouched, sanitizes capped multi-part content without mutation', () => {
    const evt = toolResultEvent('bad\0')
    evt.item!.content[0].is_error = true
    const raw = JSON.stringify(evt)
    expect(capToolResultEvent(evt, raw)).toBe(raw)
    evt.item!.content.push({ type: 'tool_result', call_id: 'c2', output: '中'.repeat(20000) })
    const result = JSON.parse(capToolResultEvent(evt, JSON.stringify(evt)))
    expect(result.item.content[0]).toMatchObject({
      call_id: 'c1',
      is_error: true,
      output: 'bad\uFFFD',
    })
    expect(result.item.content[1].output).not.toContain('\uFFFD')
    expect(evt.item!.content[0].output).toBe('bad\0')
  })
})
