import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BrowserProvider } from 'neu-browser-mcp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../services/db/shares', () => ({ getPlatformToken: vi.fn(async () => 'owner-token') }))
vi.mock('../../services/db/workspaces', () => ({
  getWorkspace: vi.fn(async () => ({ user_id: 'owner' })),
}))
import { registerBrowserTools } from './browser'
import { configureBrowserProvider } from './browser-provider'
const session = {
  id: 'b1',
  status: 'running',
  createdAt: 'now',
  expiresAt: 'later',
  cdpUrl: 'https://browser/cdp?token=scoped',
  connectUrl: 'wss://browser/connect',
  liveViewUrl: null,
}
let provider: BrowserProvider
let handlers: Record<string, (args: any) => Promise<any>>
beforeEach(() => {
  handlers = {}
  provider = {
    name: 'test',
    capabilities: {
      metadata: true,
      httpCdp: true,
      liveView: true,
      timeout: { kind: 'absolute', defaultSeconds: 3600, maxSeconds: 86400 },
    },
    createSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => [session]),
    releaseSession: vi.fn(async () => {}),
    files: {
      defaultPath: '/downloads',
      list: vi.fn(async () => [{ path: '/downloads/a', size: 42 }]),
      downloadUrl: vi.fn(async () => 'https://browser/download'),
    },
  }
  registerBrowserTools(
    {
      registerTool: (name: string, _schema: unknown, handler: any) => {
        handlers[name] = handler
      },
    } as unknown as McpServer,
    'ws1',
    provider,
  )
})
describe('Browser provider adapter', () => {
  it('retains all five tools and the connection contract', async () => {
    expect(Object.keys(handlers)).toEqual([
      'create_browser',
      'list_browsers',
      'list_browser_files',
      'get_browser_file_url',
      'delete_browser',
    ])
    const result = await handlers.create_browser({ timeout_seconds: 90 })
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      browser_id: 'b1',
      status: 'running',
      expires_at: 'later',
      connect_url: 'wss://browser/connect',
      cdp_url: session.cdpUrl,
      live_view_url: null,
    })
    expect(provider.createSession).toHaveBeenCalledWith({
      timeoutSeconds: 90,
      metadata: { 'browser.workspace_id': 'ws1' },
    })
  })
  it('scopes listing and preserves list field names', async () => {
    const result = JSON.parse((await handlers.list_browsers({})).content[0].text)
    expect(result.items[0]).toMatchObject({
      id: 'b1',
      created_at: 'now',
      expires_at: 'later',
      endpoints: { cdp: 'https://browser/cdp', live_view: null },
    })
    expect(provider.listSessions).toHaveBeenCalledWith({
      metadata: { 'browser.workspace_id': 'ws1' },
    })
  })
  it.each(['delete_browser', 'list_browser_files', 'get_browser_file_url'])(
    'rejects a foreign ID for %s',
    async (name) => {
      vi.mocked(provider.listSessions).mockResolvedValue([])
      expect((await handlers[name]({ browser_id: 'foreign', path: '/downloads/a' })).isError).toBe(
        true,
      )
      expect(provider.releaseSession).not.toHaveBeenCalled()
      expect(provider.files!.list).not.toHaveBeenCalled()
    },
  )
  it('preserves file metadata and delete acknowledgement', async () => {
    expect(
      JSON.parse(
        (await handlers.get_browser_file_url({ browser_id: 'b1', path: '/downloads/a' })).content[0]
          .text,
      ),
    ).toMatchObject({
      ready: true,
      size: 42,
      path: '/downloads/a',
      url: 'https://browser/download',
    })
    expect((await handlers.delete_browser({ browser_id: 'b1' })).content[0].text).toBe(
      'Browser b1 deleted',
    )
  })
  it('does not manufacture download support or leak provider errors', async () => {
    provider.files!.downloadUrl = undefined
    expect((await handlers.get_browser_file_url({ browser_id: 'b1', path: '/a' })).isError).toBe(
      true,
    )
    vi.mocked(provider.createSession).mockRejectedValue(new Error('SECRET_API_KEY'))
    const result = await handlers.create_browser({})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('SECRET_API_KEY')
  })
  it('rejects unknown, unscoped and missing-secret configurations', () => {
    for (const backend of ['invalid', 'nap', 'hyperbrowser', 'kernel', 'browser-use'])
      expect(() => configureBrowserProvider({ BROWSER_BACKEND: backend })).toThrow()
    expect(configureBrowserProvider({})('ws1').name).toBe('nap')
    expect(
      configureBrowserProvider({ BROWSER_BACKEND: 'kernel', KERNEL_API_KEY: 'test' })('ws1').name,
    ).toBe('kernel')
    expect(() => configureBrowserProvider({ BROWSER_SERVICE_URL: 'file:///secret' })).toThrow()
  })
})
