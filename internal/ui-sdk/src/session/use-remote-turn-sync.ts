import { useEffect, useRef } from 'react'
/** Observe server-started turns without owning any server scheduling decision. */
export function useRemoteTurnSync({
  enabled = true,
  sessionId,
  sync,
  onSync,
  intervalMs = 5000,
}: {
  enabled?: boolean
  sessionId?: string
  sync: () => Promise<void>
  onSync?: () => void
  intervalMs?: number
}) {
  const latest = useRef({ sync, onSync })
  latest.current = { sync, onSync }
  useEffect(() => {
    if (!enabled || !sessionId) return
    let pending = false
    let disposed = false
    const check = async () => {
      if (document.visibilityState !== 'visible' || pending || disposed) return
      pending = true
      try {
        await latest.current.sync()
        if (!disposed) latest.current.onSync?.()
      } finally {
        pending = false
      }
    }
    const run = () => {
      void check().catch(() => {})
    }
    run()
    const timer = setInterval(run, intervalMs)
    document.addEventListener('visibilitychange', run)
    return () => {
      disposed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }, [enabled, sessionId, intervalMs])
}
