import { normaliseHits, type SearchHit } from './searchContract.js'

export const SEARCH_PAYLOAD_TOKEN_CEILING = 2000
export const searchTokenUpperBound = (text: string): number => Buffer.byteLength(text, 'utf8')

export function searchPayload(hits: readonly SearchHit[], notes: readonly string[] = []): string {
  const payload = { hits: [] as SearchHit[], notes: [] as string[] }
  const fits = (): boolean => searchTokenUpperBound(JSON.stringify(payload)) < SEARCH_PAYLOAD_TOKEN_CEILING
  for (const hit of normaliseHits(hits)) {
    payload.hits.push({ ...hit })
    if (!fits()) {
      payload.hits[payload.hits.length - 1] = { ...hit, snippet: '' }
      if (!fits()) payload.hits.pop()
    }
  }
  for (const note of notes) {
    payload.notes.push(note)
    if (!fits()) payload.notes.pop()
  }
  return JSON.stringify(payload)
}
