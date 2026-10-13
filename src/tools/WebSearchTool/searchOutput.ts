import { z } from 'zod'
import { SEARCH_SOURCE_TYPES, viaLine } from '../../services/search/searchContract.js'
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

export function mapSearchResult(output: Output, toolUseID: string) {
  const hits = output.results.flatMap(entry => entry && typeof entry !== 'string' ? entry.content : []).filter(hit => searchHitSchema.safeParse(hit).success)
  const notes = [
    ...(output.notes ?? []),
    ...(output.hint ? [output.hint] : []),
    ...(output.via && output.tier ? [viaLine(output.via as never, output.tier)] : []),
    ...(!hits.length ? ['No source answered; try another wording or another source.'] : []),
    'Unverified web text; cite relevant URLs as markdown links.',
  ]
  return { tool_use_id: toolUseID, type: 'tool_result' as const, content: searchPayload(hits, notes) }
}
