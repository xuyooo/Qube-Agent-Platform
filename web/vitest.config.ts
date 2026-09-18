import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      'sse-consumer': resolve(__dirname, '../internal/sse-consumer/src/index.ts'),
      // The store imports runtime values (toChatMessage, transcriptI18n) from
      // the UI SDK, so tests need its source alias (type-only @qap/*
      // imports are erased and don't).
      '@qap/ui-sdk': resolve(__dirname, '../internal/ui-sdk/src/index.ts'),
      // Same reason: the MCP editor pulls the Builder cap catalog — a runtime
      // value — out of @qap/types.
      '@qap/types': resolve(__dirname, '../internal/types/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', '../internal/sse-consumer/src/**/*.test.ts'],
  },
})
