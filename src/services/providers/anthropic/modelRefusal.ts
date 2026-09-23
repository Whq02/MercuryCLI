export type ModelRefusalKind = 'contract-floor' | 'tier' | 'not-served'

export interface ModelRefusal {
  id: string
  door: string
  kind: ModelRefusalKind
  words: string
  seenAtMs: number
}

export function standingModelRefusals(): readonly ModelRefusal[] {
  return []
}

export function modelRefusalWords(id: string): string | undefined {
  void id
  return undefined
}
