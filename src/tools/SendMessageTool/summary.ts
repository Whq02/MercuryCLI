export const DERIVED_SUMMARY_MAX_CHARS = 120

export function derivedMessageSummary(text: string): string | undefined {
  const firstLine = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .find(line => line !== '')
  if (firstLine === undefined) return undefined
  if (firstLine.length <= DERIVED_SUMMARY_MAX_CHARS) return firstLine
  const head = firstLine.slice(0, DERIVED_SUMMARY_MAX_CHARS - 1)
  const atWord = head.lastIndexOf(' ')
  const kept = atWord >= Math.floor(DERIVED_SUMMARY_MAX_CHARS / 2) ? head.slice(0, atWord) : head
  return `${kept.replace(/[\s,;:—-]+$/, '')}…`
}

export function plainMessageSummary(given: string | undefined, text: string): string | undefined {
  const trimmed = given?.trim() ?? ''
  return trimmed !== '' ? trimmed : derivedMessageSummary(text)
}
