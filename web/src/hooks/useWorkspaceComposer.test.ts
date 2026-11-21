import { api } from '@/lib/api/client'
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useWorkspaceComposer } from './useWorkspaceComposer'

vi.mock('@/lib/api/client', () => ({ api: { listCommands: vi.fn() } }))

it('awaits fresh command data instead of returning the invalidated cache', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const stale = { id: '1', name: 'old', type: 'plain', content: 'old payload', disabled: false }
  client.setQueryData(['commands', 'w'], [stale])
  await client.invalidateQueries({ queryKey: ['commands', 'w'] })
  let resolve!: (value: unknown) => void
  vi.mocked(api.listCommands).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  let preset!: ReturnType<typeof useWorkspaceComposer>
  function Host() {
    preset = useWorkspaceComposer('w', 'claude-code')
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Host))))
    let settled = false
    const loading = preset.loadCommands!().then((items) => {
      settled = true
      return items
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolve([{ ...stale, disabled: true }])
    expect(await loading).toEqual([])
    expect(api.listCommands).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    client.clear()
  }
})

it('offers installed skills and ranks skill-name matches ahead of description matches', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      skills: [
        { id: '1', name: 'guide', description: 'Brand conventions' },
        { id: '2', name: 'brand-check' },
        { id: '3', name: 'build' },
      ],
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient()
  const root = createRoot(document.createElement('div'))
  let preset!: ReturnType<typeof useWorkspaceComposer>
  function Host() {
    preset = useWorkspaceComposer('w', 'claude-code')
    return null
  }
  try {
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Host))))
    const trigger = preset.triggers.find((item) => item.id === 'qap-skill')!
    expect(trigger.pattern.test('@skill/Brand')).toBe(true)
    const items = await trigger.getItems('Brand', new AbortController().signal)
    expect(items.map((item) => item.insertText)).toEqual(['@skill/brand-check ', '@skill/guide '])
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/skills', { credentials: 'include' })
  } finally {
    act(() => root.unmount())
    client.clear()
    vi.unstubAllGlobals()
  }
})
