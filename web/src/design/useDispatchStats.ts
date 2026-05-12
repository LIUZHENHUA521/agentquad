import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'

export interface DispatchStats {
  /** Sessions currently running OR thinking */
  activeCount: number
  /** Sessions waiting for user confirmation */
  pendingCount: number
  /** Aggregate input + output tokens used today (rough estimate) */
  tokenSum: number
  /** Display string for tokenSum (e.g. "24.5k") */
  tokenSumLabel: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)

  return useMemo(() => {
    let activeCount = 0
    let pendingCount = 0
    // tokenSum: LiveSession does NOT carry token totals as of M2.
    // Always returns 0 until M3 wires a richer source (server-pushed or aggregated).
    const tokenSum = 0
    sessions.forEach((session) => {
      if (session.status === 'running') activeCount += 1
      if (session.status === 'pending_confirm') pendingCount += 1
    })
    return { activeCount, pendingCount, tokenSum, tokenSumLabel: formatTokens(tokenSum) }
  }, [sessions])
}
