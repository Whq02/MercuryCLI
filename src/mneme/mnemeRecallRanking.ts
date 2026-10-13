import { fuseRankings, scoreCandidates, type LookupCandidate, type RankingOptions as LookupRankingOptions } from './mnemeLookup.js'
import { usageOf } from './mnemeUsage.js'

type RankingOptions = LookupRankingOptions & { dir?: string }

export function fuseRecallRankings(query: string, pool: readonly LookupCandidate[], grepIds: readonly string[], opts: RankingOptions = {}): string[] {
  const scoredPool = opts.usage ? pool.map(candidate => ({ ...candidate, useCount: candidate.seq !== undefined ? usageOf(candidate.seq, opts.usage!).count : candidate.useCount })) : pool
  const scored = scoreCandidates(query, scoredPool, opts.now).filter(hit => !opts.exclude?.has(hit.id))
  const lexical = scored.filter(hit => hit.features.discriminating)
    .sort((a, b) => b.score - a.score || b.features.useCount - a.features.useCount || (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER))
  const grep = [...new Set(grepIds)].filter(id => !opts.exclude?.has(id))
  return fuseRankings([grep, lexical.map(hit => hit.id)])
}
