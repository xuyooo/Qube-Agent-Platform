import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../lib/types'
import { canAccessWorkspace } from '../lib/workspace-access'
import { getPlatformToken } from '../services/db/shares'
import { getWorkspace } from '../services/db/workspaces'
import { getSandbox, runCommand } from '../services/sandbox'
import workspaceSandboxes from './workspace-sandboxes'

vi.mock('../lib/workspace-access', () => ({ canAccessWorkspace: vi.fn() }))
vi.mock('../services/db/shares', () => ({ getPlatformToken: vi.fn() }))
vi.mock('../services/db/workspaces', () => ({ getWorkspace: vi.fn() }))
vi.mock('../services/sandbox', () => ({ getSandbox: vi.fn(), runCommand: vi.fn() }))

const app = new OpenAPIHono<AppEnv>()
app.route('/', workspaceSandboxes)

function request() {
  return app.request('/w1/sandboxes/s1/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'printf hello', background: true }),
  })
}

describe('workspace sandbox command access', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getWorkspace).mockResolvedValue({ user_id: 'owner' } as never)
    vi.mocked(canAccessWorkspace).mockResolvedValue(true)
    vi.mocked(getPlatformToken).mockResolvedValue('test-owner-token')
  })

  it('rejects a caller without workspace access before calling the sandbox service', async () => {
    vi.mocked(canAccessWorkspace).mockResolvedValue(false)
    expect((await request()).status).toBe(404)
    expect(getPlatformToken).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects a sandbox tagged for another workspace even when the owner is the same', async () => {
    vi.mocked(getSandbox).mockResolvedValue({ metadata: { workspace_id: 'w2' } } as never)
    expect((await request()).status).toBe(404)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('passes valid work through to the sandbox service', async () => {
    vi.mocked(getSandbox).mockResolvedValue({ metadata: { workspace_id: 'w1' } } as never)
    vi.mocked(runCommand).mockResolvedValue({ command_id: 'cmd-1' } as never)
    const res = await request()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ command_id: 'cmd-1' })
    expect(runCommand).toHaveBeenCalledWith(
      'test-owner-token',
      's1',
      'printf hello',
      expect.objectContaining({ background: true }),
    )
  })
})
