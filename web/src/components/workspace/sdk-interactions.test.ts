import {
  AskUserQuestionPanel,
  ToolCallGroup,
  WaitingOnAgentsNotice,
  transcriptI18n,
} from '@qap/ui-sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
describe('shared interaction presentation', () => {
  it.each(['en-US', 'zh-CN'])(
    'renders standalone question and waiting strings in %s',
    async (locale) => {
      await transcriptI18n.changeLanguage(locale)
      const question = renderToStaticMarkup(
        createElement(AskUserQuestionPanel, {
          request: {
            requestId: 'q',
            questions: [
              {
                question: 'Pick',
                header: '',
                multiSelect: true,
                options: [{ label: 'A', description: '' }],
              },
            ],
          },
          onRespond: vi.fn(),
        }),
      )
      expect(question).toContain('aria-pressed="false"')
      expect(question).not.toContain('components.askUserQuestion')
      expect(
        renderToStaticMarkup(createElement(WaitingOnAgentsNotice, { count: 2 })),
      ).not.toContain('components.workspaceChat')
    },
  )
  it('retains the raw error and only softens earlier failures', () => {
    const failed = {
      id: 'bad',
      name: 'unknown',
      input: {},
      result: 'original failure',
      isError: true,
    }
    const later = { id: 'next', name: 'unknown', input: {}, result: 'ok' }
    const html = renderToStaticMarkup(
      createElement(ToolCallGroup, { tools: [failed, later], foldKey: 'm', expandAll: true }),
    )
    expect(html).toContain('bg-muted-foreground/60')
    expect(failed.isError).toBe(true)
    expect(failed.result).toBe('original failure')
    const last = renderToStaticMarkup(
      createElement(ToolCallGroup, { tools: [failed], foldKey: 'last', expandAll: true }),
    )
    expect(last).toContain('bg-destructive')
  })
})
