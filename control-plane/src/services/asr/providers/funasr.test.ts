import { afterEach, describe, expect, it, vi } from 'vitest'
import { REGISTRY } from '../registry'
import funasr from './funasr'

afterEach(() => vi.unstubAllGlobals())
const audio = Buffer.from('wav')
function response(data: unknown) {
  const fetcher = vi.fn().mockResolvedValue(Response.json(data))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('FunASR provider', () => {
  it('registers and requires a password or API key', () => {
    expect(REGISTRY.funasr).toBe(funasr)
    expect(funasr.configSchema.safeParse({}).success).toBe(false)
    expect(funasr.configSchema.safeParse({ api_key: '' }).success).toBe(false)
    expect(funasr.configSchema.safeParse({ base_url: 'invalid', password: 'p' }).success).toBe(
      false,
    )
  })
  it('sends Basic auth, normalized WAV, language and hotwords to the native endpoint', async () => {
    const fetcher = response({
      segments: [{ text: ' one ' }, {}, { text: 'two' }],
      duration: 1.2346,
    })
    const provider = funasr.create(
      funasr.configSchema.parse({ base_url: 'https://asr.example/', password: 'p' }),
    )
    expect(await provider.transcribe({ audio, language: 'zh', hint: 'QAP, agent' })).toEqual({
      text: 'one\ntwo',
      language: 'zh',
      duration_ms: 1235,
    })
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://asr.example/asr')
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('funasr:p').toString('base64')}`)
    const form = init.body as FormData
    expect(form.get('language')).toBe('中文')
    expect(form.get('hotwords')).toBe('QAP, agent')
    expect(form.get('timestamp')).toBe('false')
    const file = form.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(file.type).toBe('audio/wav')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio)
  })
  it('prefers Bearer API key when both credentials are configured', async () => {
    const fetcher = response({ text: 'hello', segments: [], duration: 0 })
    const provider = funasr.create(funasr.configSchema.parse({ api_key: 'key', password: 'p' }))
    expect(await provider.transcribe({ audio })).toEqual({
      text: 'hello',
      language: undefined,
      duration_ms: 0,
    })
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer key')
  })
  it.each(['auto', 'unknown'])('omits unrecognized/automatic language %s', async (language) => {
    const fetcher = response({ text: 'hello' })
    await funasr
      .create(funasr.configSchema.parse({ api_key: 'key' }))
      .transcribe({ audio, language })
    expect((fetcher.mock.calls[0][1].body as FormData).has('language')).toBe(false)
  })
  it('surfaces HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))
    await expect(
      funasr.create(funasr.configSchema.parse({ api_key: 'key' })).transcribe({ audio }),
    ).rejects.toThrow('funasr transcribe failed: 503 unavailable')
  })
})
