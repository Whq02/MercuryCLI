import { normaliseHits, type SearchHit } from './searchContract.js'

export const SEARCH_PAYLOAD_TOKEN_CEILING = 2000
export const SEARCH_PAYLOAD_NOTES_TOKEN_CAP = 200
export const searchTokenEstimate = (text: string): number => Math.ceil(text.length / 4)

export function searchPayload(hits: readonly SearchHit[], notes: readonly string[] = [], reserved: readonly string[] = []): string {
  const kept = normaliseHits(hits)
  const others: string[] = []
  for (const note of notes) {
    others.push(note)
    if (searchTokenEstimate(JSON.stringify(others)) > SEARCH_PAYLOAD_NOTES_TOKEN_CAP) others.pop()
  }
  const render = (count: number): string => {
    const cut = count < kept.length ? [`${kept.length - count} of ${kept.length} hits withheld to keep this answer under about ${SEARCH_PAYLOAD_TOKEN_CEILING.toLocaleString('en-US')} tokens (characters/4)`] : []
    return JSON.stringify({ hits: kept.slice(0, count), notes: [...reserved, ...others, ...cut] })
  }
  let count = kept.length
  while (count > 0 && searchTokenEstimate(render(count)) >= SEARCH_PAYLOAD_TOKEN_CEILING) count--
  return render(count)
}
