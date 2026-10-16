import type { SignalCandidate } from './mnemeRerank.js'
import { preservePinnedOrder, signalRanking } from './mnemeRerank.js'

interface ExtraOrdering {
  order: string[]
  tieKey: (id: string) => string | null
}

export function fuseSignalRanking(
  rankings: string[][],
  scored: readonly SignalCandidate[],
  dir: string,
  fuseRankings: (rankings: string[][]) => string[],
  extra: readonly ExtraOrdering[] = [],
  refineUntrained?: (order: string[]) => string[],
): string[] {
  const baseline = fuseRankings([...rankings, ...extra.map(e => e.order)])
  const eligible = new Set(baseline)
  const learned = signalRanking(scored.filter(hit => eligible.has(hit.id)), dir)
  if (learned === null) return refineUntrained?.(baseline) ?? baseline
  const pinned = new Set(scored.filter(hit => hit.features.pinned).map(hit => hit.id))
  const byId = new Map(scored.map(hit => [hit.id, hit]))
  const preference = new Map(learned.map((id, index) => [id, index]))
  const scoreKey = (id: string): string | null => {
    const hit = byId.get(id)
    return !hit || pinned.has(id) || !preference.has(id) ? null
      : JSON.stringify([hit.score ?? hit.features.bm25 * hit.features.recency, hit.features.useCount ?? 0])
  }
  const resortTies = (ranking: readonly string[], keyOf: (id: string) => string | null): string[] => {
    const order = [...ranking]
    const tieKey = (id: string): string | null => (pinned.has(id) || !preference.has(id) ? null : keyOf(id))
    for (let start = 0; start < order.length;) {
      const key = tieKey(order[start]!)
      let end = start + 1
      if (key !== null) {
        while (end < order.length && tieKey(order[end]!) === key) end++
        const ids = order.slice(start, end).sort((a, b) => preference.get(a)! - preference.get(b)!)
        order.splice(start, end - start, ...ids)
      }
      start = end
    }
    return order
  }
  const tied = [...rankings.map(ranking => resortTies(ranking, scoreKey)), ...extra.map(e => resortTies(e.order, e.tieKey))]
  return preservePinnedOrder(baseline, fuseRankings([...tied, learned]), pinned)
}
