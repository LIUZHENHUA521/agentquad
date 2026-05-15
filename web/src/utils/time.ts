export function formatRelativeShort(ms: number): string {
  const safe = Math.max(1000, ms)
  if (safe < 60_000) return `${Math.floor(safe / 1000)}s`
  if (safe < 3_600_000) return `${Math.floor(safe / 60_000)}m`
  if (safe < 86_400_000) return `${Math.floor(safe / 3_600_000)}h`
  return `${Math.floor(safe / 86_400_000)}d`
}
