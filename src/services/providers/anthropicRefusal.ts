export interface AnthropicWindowObservation {
  account: string
  observedAtMs: number
  resetsAtMs?: number
  lapsesAtMs?: number
}

function clockWords(ms: number): string {
  const { formatClock } = require('../../utils/cockpit/quota.js') as typeof import('../../utils/cockpit/quota.js')
  return formatClock(ms)
}

export function anthropicWindowWords(seen?: AnthropicWindowObservation): string {
  if (seen === undefined) return 'the Anthropic usage window is reached — the reset time is not known'
  const head = `the Anthropic usage window is reached for ${seen.account}, seen at ${clockWords(seen.observedAtMs)}`
  if (seen.resetsAtMs !== undefined) return `${head} — resets at ${clockWords(seen.resetsAtMs)}`
  if (seen.lapsesAtMs !== undefined) {
    return `${head} — no reset time was given; delegated work is refused until ${clockWords(seen.lapsesAtMs)}`
  }
  return head
}
