import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ComponentProps, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
// @vitest-environment jsdom
import { RouteForm } from './IntegrationPage'
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' } }) }))
vi.mock('@/components/workspace/PromptField', () => ({ PromptField: () => null }))
vi.mock('@/docs/route-prompt-presets/_load', () => ({ listPromptPresets: () => [] }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))

it.each(['meta.title', ''])('round-trips array filters with optional itemField %s', (itemField) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const client = new QueryClient()
  const container = document.createElement('div')
  const root = createRoot(container)
  const onSubmit = vi.fn()
  const filter = {
    field: 'body.labels',
    op: 'array_contains',
    value: 'bug',
    ...(itemField ? { itemField } : {}),
  }
  const props = {
    initial: {
      id: 'r',
      connector_id: 'c',
      workspace_id: 'w',
      external_id: 'hook',
      name: 'route',
      config: { filters: [filter] },
    },
    connectors: [{ id: 'c', type: 'webhook', user_id: 'u', name: 'Webhook' }],
    workspaces: [],
    onSubmit,
    onCancel: vi.fn(),
    loading: false,
  } as unknown as ComponentProps<typeof RouteForm>
  try {
    act(() =>
      root.render(createElement(QueryClientProvider, { client }, createElement(RouteForm, props))),
    )
    const input = container.querySelector(
      'input[aria-label="components.integration.route.filters.itemField"]',
    ) as HTMLInputElement
    expect(input.value).toBe(itemField)
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit.mock.calls[0][0].config.filters).toEqual([filter])
    act(() =>
      Simulate.change(input, { target: { value: ' details.name ' } } as unknown as Parameters<
        typeof Simulate.change
      >[1]),
    )
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit.mock.calls[1][0].config.filters[0].itemField).toBe('details.name')
  } finally {
    act(() => root.unmount())
    client.clear()
  }
})
