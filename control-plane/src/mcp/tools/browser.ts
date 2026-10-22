import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BrowserProvider, BrowserSession } from 'neu-browser-mcp'
import { z } from 'zod'
import { browserProviderFor } from './browser-provider'
import { errorResult, jsonResult, textResult } from './shared'

function connection(session: BrowserSession) {
  return {
    cdp_url: session.cdpUrl,
    connect_url: session.connectUrl,
    connect_command: session.connectUrl
      ? `agent-browser connect ${JSON.stringify(session.connectUrl)}`
      : null,
    live_view_url: session.liveViewUrl,
  }
}
function endpoint(url: string | null) {
  if (!url) return null
  const result = new URL(url)
  result.searchParams.delete('token')
  return result.toString()
}

export function registerBrowserTools(
  server: McpServer,
  workspaceId: string,
  provider: BrowserProvider = browserProviderFor(workspaceId),
) {
  const metadata = { 'browser.workspace_id': workspaceId }
  async function requireOwned(id: string) {
    const visible = await provider.listSessions({ metadata, connectInfo: false })
    if (!visible.some((session) => session.id === id))
      throw new Error('Browser is not in this workspace')
  }
  function guarded(action: () => Promise<ReturnType<typeof textResult>>) {
    // Backend HTTP errors can contain API keys. Never echo their response bodies.
    return action().catch(() =>
      errorResult('Browser operation failed or browser is not accessible in this workspace.'),
    )
  }
  server.registerTool(
    'create_browser',
    {
      title: 'Create Browser',
      description:
        'Create a browser in this workspace. Returns browser_id, status, expires_at, cdp_url, connect_url, connect_command and live_view_url. Unsupported connection fields are null. Timeout uses the configured provider lifetime policy.',
      inputSchema: z.object({
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(provider.capabilities.timeout.maxSeconds)
          .optional(),
      }),
    },
    ({ timeout_seconds }) =>
      guarded(async () => {
        const session = await provider.createSession({ timeoutSeconds: timeout_seconds, metadata })
        return jsonResult({
          browser_id: session.id,
          status: session.status,
          expires_at: session.expiresAt,
          ...connection(session),
          ...(!session.connectUrl
            ? { warning: 'Browser connection not ready; call list_browsers before connecting.' }
            : {}),
        })
      }),
  )
  server.registerTool(
    'list_browsers',
    {
      title: 'List Browsers',
      description: 'List browsers visible to this workspace with their connection information.',
      inputSchema: z.object({}),
    },
    () =>
      guarded(async () =>
        jsonResult({
          items: (await provider.listSessions({ metadata })).map((session) => ({
            id: session.id,
            status: session.status,
            created_at: session.createdAt,
            expires_at: session.expiresAt,
            endpoints: { cdp: endpoint(session.cdpUrl), live_view: endpoint(session.liveViewUrl) },
            ...connection(session),
          })),
        }),
      ),
  )
  server.registerTool(
    'list_browser_files',
    {
      title: 'List Browser Files',
      description:
        'List files in a browser belonging to this workspace. Default directory: /downloads. File access depends on the backend.',
      inputSchema: z.object({
        browser_id: z.string(),
        path: z.string().optional(),
        pattern: z.string().optional(),
      }),
    },
    ({ browser_id, path, pattern }) =>
      guarded(async () => {
        await requireOwned(browser_id)
        if (!provider.files)
          return errorResult('This browser backend does not support file listing.')
        return jsonResult({
          files: await provider.files.list(browser_id, path ?? '/downloads', pattern),
        })
      }),
  )
  server.registerTool(
    'get_browser_file_url',
    {
      title: 'Get Browser File Download URL',
      description:
        'Get a credential-free download URL where the backend supports it. Unsupported backends return an MCP error.',
      inputSchema: z.object({ browser_id: z.string(), path: z.string() }),
    },
    ({ browser_id, path }) =>
      guarded(async () => {
        await requireOwned(browser_id)
        if (!provider.files?.downloadUrl)
          return errorResult('This browser backend cannot issue file download URLs.')
        const lastSlash = path.lastIndexOf('/')
        const files = await provider.files.list(
          browser_id,
          lastSlash > 0 ? path.slice(0, lastSlash) : '/',
          path.slice(lastSlash + 1),
        )
        const file = files.find((item) => item.path === path)
        if (!file) return jsonResult({ ready: false, path })
        return jsonResult({
          ready: true,
          url: await provider.files.downloadUrl(browser_id, path),
          path,
          size: file.size,
          modified_at: file.modifiedAt,
        })
      }),
  )
  server.registerTool(
    'delete_browser',
    {
      title: 'Delete Browser',
      description: 'Destroy a browser belonging to this workspace.',
      inputSchema: z.object({ browser_id: z.string() }),
    },
    ({ browser_id }) =>
      guarded(async () => {
        await requireOwned(browser_id)
        await provider.releaseSession(browser_id)
        return textResult(`Browser ${browser_id} deleted`)
      }),
  )
}
