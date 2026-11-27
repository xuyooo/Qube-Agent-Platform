import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getReflectWindow } from '../../lib/session-token'
import { getMessages } from '../../services/db/messages'
import { getSession, listSessions } from '../../services/db/sessions'
import { getWorkspace } from '../../services/db/workspaces'
import { eligibleReflectStore } from '../../services/reflect'
import { errorResult, textResult } from './shared'

const GET_ACTIVITY_DIGEST_MAX_SESSIONS = 10

/**
 * The only MCP tools registered for a Reflect turn (see mcp/tools.ts) —
 * everything else (bash, browser, sandbox, other MCP servers) a normal
 * workspace turn gets is deliberately withheld. `list_recent_activity`
 * decides its own bounded time window from the store's checkpoint so the
 * agent never has to compute or pass a timestamp itself.
 *
 * `sessionId` is null on a request that arrives before cp has bound the
 * turn's session to its token (see registerTools). Listing tools needs no
 * session; a call that needs one reports it rather than guessing a window.
 */
export function registerReflectTools(
  server: McpServer,
  workspaceId: string,
  storeId: string,
  sessionId: string | null,
) {
  const window = async () => {
    if (!sessionId) return null
    const workspace = await getWorkspace(workspaceId)
    if (!workspace || !(await eligibleReflectStore(workspaceId, workspace.user_id, storeId)))
      return null
    return getReflectWindow(workspaceId, sessionId, storeId)
  }
  server.registerTool(
    'list_recent_activity',
    {
      title: "List this workspace's sessions in this Reflect pass's window",
      description:
        'List sessions oldest first in the saved Reflect window. Use next_offset until it is null, then read relevant sessions with get_activity_digest.',
      inputSchema: z.object({
        limit: z.number().int().positive().max(200).optional().describe('Default 50.'),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async ({ limit, offset = 0 }) => {
      const bounds = await window()
      if (!bounds) return errorResult('Reflect session or store is unavailable')
      const { since, until } = bounds
      const { items, total } = await listSessions(workspaceId, {
        activeAfter: since,
        activeBefore: until,
        order: 'asc', // oldest first: work through backlog chronologically
        excludeSources: ['schedule'], // exclude Reflect's own runs and other scheduled agents
        limit: limit ?? 50,
        offset,
      })

      const nextOffset =
        items.length && offset + items.length < total ? offset + items.length : null
      const header = `Window: ${since} to ${until} (next_offset: ${nextOffset ?? 'null'})`
      const lines = items.map((s) => {
        const preview = s.preview ? s.preview.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
        return `${s.id} | "${s.name || '(untitled)'}" | ${s.message_count}m | ${s.last_active_at}${preview ? `\n  ${preview}` : ''}`
      })
      return textResult(`${header}\n\n${lines.join('\n')}`)
    },
  )

  server.registerTool(
    'get_activity_digest',
    {
      title: 'Read the full text of specific sessions',
      description: `Full user/assistant text for up to ${GET_ACTIVITY_DIGEST_MAX_SESSIONS} sessions from \`list_recent_activity\`, concatenated inline. Tool calls, tool results, and thinking are stripped — only the conversational text. Batch related sessions in one call rather than calling once per id.`,
      inputSchema: z.object({
        session_ids: z
          .array(z.string())
          .min(1)
          .max(GET_ACTIVITY_DIGEST_MAX_SESSIONS)
          .describe(
            `Session ids from \`list_recent_activity\`. Up to ${GET_ACTIVITY_DIGEST_MAX_SESSIONS} per call.`,
          ),
      }),
    },
    async ({ session_ids }) => {
      const bounds = await window()
      if (!bounds) return errorResult('Reflect session or store is unavailable')
      const sessions = await Promise.all(session_ids.map((id) => getSession(id)))
      if (
        sessions.some(
          (session) =>
            !session ||
            session.workspace_id !== workspaceId ||
            session.source === 'schedule' ||
            new Date(session.last_active_at).getTime() < Date.parse(bounds.since) ||
            new Date(session.last_active_at).getTime() >= Date.parse(bounds.until),
        )
      )
        return errorResult('Session is outside the Reflect activity window')
      const sections = await Promise.all(
        session_ids.map(async (id) => {
          const messages = await getMessages(workspaceId, id)
          if (messages.length === 0) {
            return `--- session ${id} ---\n(no messages found in this workspace)`
          }
          const body = messages
            .filter(
              (m) =>
                (m.role === 'user' || m.role === 'assistant') &&
                new Date(m.created_at).getTime() < Date.parse(bounds.until),
            )
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n\n')
          return `--- session ${id} ---\n${body}`
        }),
      )
      return textResult(sections.join('\n\n'))
    },
  )
}
