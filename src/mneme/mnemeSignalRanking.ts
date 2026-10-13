import type { SignalCandidate } from './mnemeRerank.js'
import { preservePinnedOrder, signalRanking } from './mnemeRerank.js'

export function fuseSignalRanking(
  rankings: string[][],
  scored: readonly SignalCandidate[],
  dir: string,
  fuseRankings: (rankings: string[][]) => string[],
): string[] {
  const baseline = fuseRankings(rankings)
  const eligible = new Set(baseline)
  const learned = signalRanking(scored.filter(hit => eligible.has(hit.id)), dir)
  if (learned === null) return baseline
  const pinned = new Set(scored.filter(hit => hit.features.pinned).map(hit => hit.id))
  const byId = new Map(scored.map(hit => [hit.id, hit]))
  const preference = new Map(learned.map((id, index) => [id, index]))
  const tied = rankings.map(ranking => {
    const groups = new Map<string, number[]>()
    ranking.forEach((id, index) => {
      const hit = byId.get(id)
      if (!hit || pinned.has(id) || !preference.has(id)) return
      const key = JSON.stringify([hit.score ?? hit.features.bm25 * hit.features.recency, hit.features.useCount ?? 0])
      const slots = groups.get(key) ?? []
      slots.push(index)
      groups.set(key, slots)
    })
    const order = [...ranking]
    for (const slots of groups.values()) {
      const ids = slots.map(index => ranking[index]!).sort((a, b) => preference.get(a)! - preference.get(b)!)
      slots.forEach((index, i) => { order[index] = ids[i]! })
    }
    return order
  })
  return preservePinnedOrder(baseline, fuseRankings([...tied, learned]), pinned)
}
