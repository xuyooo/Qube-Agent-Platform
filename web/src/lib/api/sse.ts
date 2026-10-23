import { i18n } from '@/lib/i18n'
import { createSessionSSEClient } from '@qap/ui-sdk'
export type { UniversalItem } from '@qap/ui-sdk'
const client = createSessionSSEClient({
  apiUrl: '/api',
  proxyUrl: '/_proxy',
  credentials: 'include',
  translate: (key) => i18n.t(key),
})
export const { createAgentChat, createCPReconnectStream } = client
