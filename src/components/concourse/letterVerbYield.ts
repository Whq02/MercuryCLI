export function letterVerbsYield(facts: {
  armedSessionId: string | null
  selectedSessionId: string | null
  liveDraftLength: number
}): boolean {
  if (facts.liveDraftLength > 0) return true
  return facts.armedSessionId !== null && facts.armedSessionId === facts.selectedSessionId
}
