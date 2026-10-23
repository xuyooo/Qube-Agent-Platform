// Data contract between the platform composer preset and whatever reaches the
// platform API — the platform's own web app, or a third-party backend that
// proxies a pinned workspace.

/** A workspace slash command as the platform lists it. */
interface QapWorkspaceCommand {
  name: string
  type: 'plain' | 'struct'
  content: string
  /** Set when the command is backed by a prompt-library entry. */
  prompt_id?: string | null
  /** Resolved prompt-library text; takes precedence over `content` when present. */
  prompt_content?: string | null
  /** Template command the user turned off: listed for management, never offered. */
  disabled?: boolean
}

/** An agent (workspace) the current user may address with `@agent/…`. */
export interface QapCallableAgent {
  id: string
  slug: string
  name: string
  owner: string
  /** True for the user's own agents, addressed by bare slug; others use `owner/slug`. */
  is_own: boolean
}

/** One entry of a workspace directory listing. */
export interface QapDirEntry {
  name: string
  path_type: 'Dir' | 'File' | 'SymLink' | 'SymlinkDir'
}

export interface QapTranscribeOptions {
  /** BCP-47 language hint for the speech recognizer. */
  language?: string
  /** Free-text context (names, jargon) that biases recognition. */
  hint?: string
}

/**
 * What the preset needs from the platform. Every method is optional: a source
 * whose method is missing is simply left out, so an app can implement only
 * what it exposes.
 */
export interface QapComposerClient {
  /** The workspace's slash commands (`GET /workspaces/:id/commands`). */
  listCommands?: () => Promise<QapWorkspaceCommand[]>
  /** Agents the user can call (`GET /workspaces/callable`). */
  listCallableAgents?: () => Promise<QapCallableAgent[]>
  /**
   * Entries under a workspace directory (`GET /workspaces/:id/agent/dirs`).
   * `dir` is workspace-relative without a leading slash (`''` is the root). A
   * non-empty `query` asks for a recursive name search within `dir`.
   */
  listDir?: (dir: string, query: string, signal?: AbortSignal) => Promise<QapDirEntry[]>
  /** Speech to text (`POST /asr/transcribe`). Reject with a user-facing message (empty falls back to a generic one). */
  transcribe?: (audio: Blob, options?: QapTranscribeOptions) => Promise<string>
}
