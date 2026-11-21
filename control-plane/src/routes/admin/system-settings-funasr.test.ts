import { expect, it, vi } from 'vitest'
import { getSettings } from '../../services/db/system-settings'
import settings from './system-settings'
vi.mock('../../services/db/system-settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))
it('lists FunASR and redacts both credential fields from admin responses', async () => {
  vi.mocked(getSettings).mockResolvedValue({
    asr_active_provider: 'funasr',
    titlegen_active_provider: null,
    branding_short_name: null,
    branding_full_name: null,
    branding_logo_data: null,
    branding_logo_mime: null,
    asr_providers: {
      funasr: {
        base_url: 'https://asr.example',
        username: 'funasr',
        password: 'secret-pass',
        api_key: 'secret-key',
      },
    },
    titlegen_providers: {},
  })
  const res = await settings.request('/')
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data.asr_available_providers).toContain('funasr')
  expect(data.asr_providers.funasr).toEqual({ base_url: 'https://asr.example', username: 'funasr' })
})
