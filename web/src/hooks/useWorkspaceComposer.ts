import { dirListUrl } from '@/lib/api/agent-files'
import { api } from '@/lib/api/client'
import { useQapComposer } from '@/lib/composer/preset'
import type { QapComposerClient, QapDirEntry } from '@/lib/composer/types'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { toast } from 'sonner'

export function useWorkspaceComposer(workspaceId: string, agentType: string) {
  const queryClient = useQueryClient()
  const client = useMemo<QapComposerClient>(
    () => ({
      listCommands: () =>
        queryClient.fetchQuery({
          queryKey: ['commands', workspaceId],
          queryFn: () => api.listCommands(workspaceId),
          staleTime: 0,
        }),
      listCallableAgents: () =>
        queryClient.ensureQueryData({
          queryKey: ['callable-agents'],
          queryFn: () => api.getCallableAgents(),
          revalidateIfStale: true,
        }),
      listDir: async (dir, query, signal) => {
        const response = await fetch(dirListUrl(workspaceId, dir || '/', query || undefined), {
          signal,
          credentials: 'include',
        })
        if (!response.ok) throw new Error('File listing failed')
        return ((await response.json()) as { entries: QapDirEntry[] }).entries
      },
      transcribe: async (audio) => {
        const form = new FormData()
        form.append('audio', audio, 'audio.webm')
        const response = await fetch('/api/asr/transcribe', {
          method: 'POST',
          body: form,
          credentials: 'include',
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Transcription failed')
        return data.text
      },
    }),
    [workspaceId, queryClient],
  )
  return useQapComposer({
    client,
    agentType,
    workspaceId,
    voice: { shortcut: true, onError: (message) => toast.error(message) },
  })
}
