import { type BrowserProvider, createNapProvider, providerFromEnv } from 'neu-browser-mcp'
import { getPlatformToken } from '../../services/db/shares'
import { getWorkspace } from '../../services/db/workspaces'

export function configureBrowserProvider(
  env: NodeJS.ProcessEnv,
): (workspaceId: string) => BrowserProvider {
  const backend = env.BROWSER_BACKEND || 'qap'
  if (backend === 'qap') {
    const baseUrl = env.BROWSER_SERVICE_URL || 'http://qap-browser:3005'
    for (const value of [baseUrl, env.BROWSER_PUBLIC_URL].filter(Boolean)) {
      const url = new URL(value!)
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Browser URL must use HTTP(S)')
    }
    return (workspaceId) =>
      createNapProvider({
        baseUrl,
        publicBaseUrl: env.BROWSER_PUBLIC_URL || undefined,
        listResolveTimeoutMs: 8000,
        requestTimeoutMs: 15000,
        token: async () => {
          const workspace = await getWorkspace(workspaceId)
          if (!workspace) throw new Error('Workspace not found')
          const token = await getPlatformToken(workspace.user_id)
          if (!token) throw new Error('Workspace owner has no platform token')
          return token
        },
      })
  }
  // Only these fixed-version providers expose server-side tag filtering.
  if (!['kernel', 'browser-use'].includes(backend)) {
    throw new Error('Unsupported BROWSER_BACKEND; use qap, kernel or browser-use')
  }
  const provider = providerFromEnv({ ...env, NEU_BROWSER_BACKEND: backend })
  if (!provider.capabilities.metadata) throw new Error('Browser backend cannot isolate workspaces')
  return () => provider
}

// Imported by MCP startup: reject invalid configuration before serving requests.
export const browserProviderFor = configureBrowserProvider(process.env)
