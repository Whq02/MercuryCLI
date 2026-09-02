
const DAY_MS = 86_400_000

export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / DAY_MS))
}

export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) return ''
  return `This memory was written ${days} days ago. A memory records an observation made at one moment, not the system's live state — claims about code behaviour and file-and-line citations may be outdated, and must be verified against the current code before being asserted as fact.`
}

export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (text === '') return ''
  return `<system-reminder>${text}</system-reminder>\n`
}
