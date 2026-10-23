import {
  type AgentSessionDeps,
  AskUserQuestionPanel,
  type ChatImageAttachment,
  Composer,
  Transcript,
  createAgentSessionStore,
  createSessionSSEClient,
} from '@qap/ui-sdk'
import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '@qap/ui-sdk/styles.css'
const sse = createSessionSSEClient({
  apiUrl: '/host-api',
  proxyUrl: '/host-proxy',
  fetch: async () =>
    new Response(
      [
        { type: 'session.started', session_id: 'host-session' },
        {
          type: 'item.started',
          item: {
            item_id: 'reply',
            kind: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        },
        {
          type: 'item.delta',
          item_id: 'reply',
          delta: { type: 'text', text: 'SDK standalone reply' },
        },
        { type: 'session.ended', session_id: 'host-session', reason: 'completed' },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
})
const deps: AgentSessionDeps = {
  api: {
    getWorkspaceMessages: async () => [],
    getSession: async () => ({
      chat_status: 'idle',
      pending_message: null,
      pending_agent_calls: 0,
    }),
    setPendingMessage: async () => {},
    clearPendingMessage: async () => {},
    getPendingQuestion: async () => null,
    respondToQuestion: async () => {},
    interruptSession: async () => ({ success: true }),
    deleteSession: async () => {},
  },
  sse,
  effects: {
    onSessionCreated() {},
    onTurnComplete() {},
    invalidateSessions() {},
    invalidateWorkspaces() {},
  },
}
const store = createAgentSessionStore('independent-host', deps)
function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [value, setValue] = useState('Hello from independent host')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [answer, setAnswer] = useState('')
  return (
    <main>
      <h1>Independent SDK host</h1>
      <Transcript messages={state.messages} locale="en-US" />
      <AskUserQuestionPanel
        request={{
          requestId: 'q',
          questions: [
            {
              question: 'Choose a mode',
              header: '',
              multiSelect: false,
              options: [{ label: 'Standard', description: 'Default' }],
            },
          ],
        }}
        onRespond={(answers) => setAnswer(answers['Choose a mode'])}
      />
      <output>{answer}</output>
      <Composer
        value={value}
        onChange={setValue}
        running={state.isLoading}
        onStop={state.stop}
        onSubmit={(text, attachments) => {
          state.sendMessage(text, attachments)
          setValue('')
          setImages([])
        }}
        attachments={{
          items: images,
          onAdd: (next) => setImages([...images, ...next]),
          onRemove: (i) => setImages(images.filter((_, j) => j !== i)),
        }}
        locale="en-US"
      />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
