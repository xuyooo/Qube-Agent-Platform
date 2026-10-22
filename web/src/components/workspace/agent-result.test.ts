import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  callAgentRenderer,
  getAgentResultRenderer,
} from '../../../../internal/ui-sdk/src/tool-renderers/mcp/agent'
import type { ToolCall } from '../../../../internal/ui-sdk/src/types'
function tool(status: string, text?: string, error?: string): ToolCall {
  return {
    id: 't1',
    name: 'get_agent_result',
    input: { session_id: 's1' },
    result: JSON.stringify({ status, session_id: 's1', text, error }),
  }
}
describe('AgentCall result presentation', () => {
  it('shows a failed call and its error without a success badge', () => {
    const html = renderToStaticMarkup(
      callAgentRenderer.renderResult(tool('failed', 'partial', 'model failed')),
    )
    expect(html).toContain('failed')
    expect(html).toContain('model failed')
    expect(html).toContain('partial')
    expect(html).not.toContain('>done<')
  })
  it('shows structured get_agent_result replies as readable text', () => {
    const html = renderToStaticMarkup(
      getAgentResultRenderer.renderResult(tool('ended', 'final reply')),
    )
    expect(html).toContain('final reply')
    expect(html).not.toContain('&quot;status&quot;')
  })
  it('distinguishes a human question from running work', () => {
    const html = renderToStaticMarkup(getAgentResultRenderer.renderResult(tool('needs_input')))
    expect(html).toContain('needs input')
    expect(html).not.toContain('>done<')
  })
})
