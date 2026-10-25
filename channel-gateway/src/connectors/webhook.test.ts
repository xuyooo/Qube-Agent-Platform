import { describe, expect, it } from 'vitest'
import { matchFilters } from './webhook'

const baseCtx = { query: {}, headers: {}, method: 'POST', path: '/hook' }

describe('matchFilters — array_contains', () => {
  const labels = [
    { id: 1, title: 'bug', color: '#f00' },
    { id: 2, title: 'zh-review', color: '#0f0' },
  ]

  it('matches when an array element has the target itemField value', () => {
    const ctx = { ...baseCtx, body: { labels } }
    const filters = [
      {
        field: 'body.labels',
        op: 'array_contains' as const,
        itemField: 'title',
        value: 'zh-review',
      },
    ]

    expect(matchFilters(filters, ctx)).toBe(true)
  })

  it('does not match when no element has the target itemField value', () => {
    const ctx = { ...baseCtx, body: { labels } }
    const filters = [
      {
        field: 'body.labels',
        op: 'array_contains' as const,
        itemField: 'title',
        value: 'needs-triage',
      },
    ]

    expect(matchFilters(filters, ctx)).toBe(false)
  })

  it('matches primitive array elements directly when itemField is omitted', () => {
    const ctx = { ...baseCtx, body: { tags: ['a', 'b', 'c'] } }
    const filters = [{ field: 'body.tags', op: 'array_contains' as const, value: 'b' }]

    expect(matchFilters(filters, ctx)).toBe(true)
  })

  it('does not match when the field resolves to a non-array', () => {
    const ctx = { ...baseCtx, body: { labels: 'not-an-array' } }
    const filters = [
      {
        field: 'body.labels',
        op: 'array_contains' as const,
        itemField: 'title',
        value: 'zh-review',
      },
    ]

    expect(matchFilters(filters, ctx)).toBe(false)
  })

  it('is unaffected by element order', () => {
    const ctx = { ...baseCtx, body: { labels: [...labels].reverse() } }
    const filters = [
      {
        field: 'body.labels',
        op: 'array_contains' as const,
        itemField: 'title',
        value: 'zh-review',
      },
    ]

    expect(matchFilters(filters, ctx)).toBe(true)
  })
})

describe('array filter boundaries and existing operations', () => {
  it.each([[], null, undefined, 42, {}])('does not match empty/non-array fields %j', (tags) => {
    expect(
      matchFilters([{ field: 'body.tags', op: 'array_contains', value: 'x' }], {
        ...baseCtx,
        body: { tags },
      }),
    ).toBe(false)
  })
  it('resolves nested item fields and tolerates null elements', () => {
    expect(
      matchFilters(
        [{ field: 'body.tags', op: 'array_contains', itemField: 'meta.name', value: 'bug' }],
        { ...baseCtx, body: { tags: [null, {}, { meta: { name: 'bug' } }] } },
      ),
    ).toBe(true)
  })
  it('retains string comparison and AND semantics', () => {
    const ctx = { ...baseCtx, body: { tags: [1, 2], state: 'open' } }
    expect(
      matchFilters(
        [
          { field: 'body.tags', op: 'array_contains', value: '2' },
          { field: 'body.state', op: 'eq', value: 'open' },
        ],
        ctx,
      ),
    ).toBe(true)
    expect(
      matchFilters(
        [
          { field: 'body.tags', op: 'array_contains', value: '2' },
          { field: 'body.state', op: 'eq', value: 'closed' },
        ],
        ctx,
      ),
    ).toBe(false)
    expect(
      matchFilters(
        [
          { field: 'method', op: 'in', value: ['POST'] },
          { field: 'body.state', op: 'neq', value: 'closed' },
          { field: 'body.state', op: 'contains', value: 'pen' },
          { field: 'body.missing', op: 'exists', value: false },
        ],
        ctx,
      ),
    ).toBe(true)
  })
})
