export type { ApiMessage } from '../types'
export type { AskUserRequest, AskUserQuestionItem } from '../question-types'
export interface ChatImageAttachment {
  data: string
  media_type: string
}
export interface PendingMessage {
  content: string
  images: ChatImageAttachment[]
}
export interface ContextGauge {
  numTurns: number
  contextTokens: number // last API call's input_tokens ≈ current context size
  contextWindow: number // model's context window limit
}

/**
 * Full per-turn stats an agent emits on session.ended (the live wire shape):
 * the context gauge plus the turn's token/cost figures. The token figures ride
 * along in the synchronous chat response but are NOT the source of truth for
 * usage accounting — that is the workspace usage ledger. Only the ContextGauge
 * subset is persisted on the session.
 */
export interface TurnStats extends ContextGauge {
  costUsd: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface SessionDrafts {
  get(workspaceId: string, sessionId: string | undefined): string
  clear(workspaceId: string, sessionId: string | undefined): void
  migrate(workspaceId: string, from: string | undefined, to: string): void
}
export interface SessionToolResults {
  dispatch(event: {
    toolName: string
    toolInput: Record<string, unknown>
    toolOutput: string
    isError: boolean
    callId: string
    workspaceId: string
  }): void
  destroy(): void
}
