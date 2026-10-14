import { z } from 'zod'
import { SEARCH_SOURCE_TYPES, searchBackendLabel, viaLine } from '../../services/search/searchContract.js'
import { searchPayload } from '../../services/search/searchPayload.js'

const searchHitSchema = z.strictObject({
  title: z.string().describe('Title of the search hit'),
  url: z.string().describe('URL of the search hit'),
  snippet: z.string().describe("The source's excerpt, empty when absent"),
  source_type: z.enum(SEARCH_SOURCE_TYPES).describe('The source that supplied this hit'),
})
const searchResultSchema = z.object({
  tool_use_id: z.string().describe('Id of the search this hit group belongs to'),
  content: z.array(searchHitSchema).describe('Search hits with their source'),
})
export type SearchResult = z.infer<typeof searchResultSchema>
export const outputSchema = z.object({
  query: z.string(),
  results: z.array(z.union([searchResultSchema, z.string()])),
  durationSeconds: z.number(),
  via: z.string().optional(),
  tier: z.enum(['native', 'keyed', 'keyless']).optional(),
  notes: z.array(z.string()).optional(),
  hint: z.string().optional(),
  cached: z.boolean().optional(),
})
export type Output = z.infer<typeof outputSchema>

export const PROVIDER_ANSWER_MAX_CHARS = 2400

export function providerAnswerNote(output: Output): string | null {
  if (output.tier !== 'native') return null
  const answer = output.results.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(entry => entry !== '').join('\n')
  if (answer === '') return null
  const shown = answer.length > PROVIDER_ANSWER_MAX_CHARS ? `${answer.slice(0, PROVIDER_ANSWER_MAX_CHARS - 1)}…` : answer
  return `${searchBackendLabel(output.via as never)} answer, the provider's own words, unverified${answer.length > PROVIDER_ANSWER_MAX_CHARS ? ` (cut at ${PROVIDER_ANSWER_MAX_CHARS.toLocaleString('en-US')} characters)` : ''}: ${shown}`
}

export function mapSearchResult(output: Output, toolUseID: string) {
  const hits = output.results.flatMap(entry => entry && typeof entry !== 'string' ? entry.content : []).filter(hit => searchHitSchema.safeParse(hit).success)
  const answer = providerAnswerNote(output)
  const reserved = [
    ...(output.via && output.tier ? [viaLine(output.via as never, output.tier)] : []),
    ...(!hits.length && answer === null ? ['No source answered; try another wording or another source.'] : []),
    'Unverified web text; cite relevant URLs as markdown links.',
    ...(answer === null ? [] : [answer]),
  ]
  const notes = [...(output.notes ?? []), ...(output.hint ? [output.hint] : [])]
  return { tool_use_id: toolUseID, type: 'tool_result' as const, content: searchPayload(hits, notes, reserved) }
}
