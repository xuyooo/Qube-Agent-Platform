import { useSdkTranslation } from '../i18n'
export function WaitingOnAgentsNotice({ count, locale }: { count: number; locale?: string }) {
  const { t } = useSdkTranslation(locale)
  return (
    <div className="flex items-center justify-center gap-1.5 px-3 pb-1 text-tiny text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-info" />
      <span>{t('components.workspaceChat.waitingOnAgents', { count })}</span>
    </div>
  )
}
