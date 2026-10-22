import { useTranslation } from 'react-i18next'
import { transcriptI18n } from '../i18n'
export function WaitingOnAgentsNotice({ count }: { count: number }) {
  const { t } = useTranslation(undefined, { i18n: transcriptI18n })
  return (
    <div className="flex items-center justify-center gap-1.5 px-3 pb-1 text-tiny text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-info" />
      <span>{t('components.workspaceChat.waitingOnAgents', { count })}</span>
    </div>
  )
}

