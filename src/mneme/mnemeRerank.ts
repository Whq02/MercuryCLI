import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { publishLibraryFile } from './mnemeLibrary.js'
import { readSignalLog, signalCounts, type SignalCounts, type SignalFeatures, type SignalTurn } from './mnemeSignal.js'

export const SIGNAL_FEATURE_NAMES = ['bias', 'bm25', 'recency', 'pinned', 'fact', 'ruling', 'pending', 'handoff', 'session', 'openRate', 'citeRate'] as const
export const SIGNAL_FIT_STEPS = 240

export interface SignalCandidate {
  id: string
  score?: number
  features: SignalFeatures & { useCount?: number }
}

export interface SignalWeights {
  version: 1
  digest: string
  samples: number
  features: readonly string[]
  weights: number[]
}

function vector(features: SignalFeatures, counts: SignalCounts = { offered: 0, opened: 0, cited: 0 }): number[] {
  return [
    1, Math.log1p(Math.max(0, features.bm25)), Math.max(0, Math.min(1, features.recency)), Number(features.pinned),
    ...(['fact', 'ruling', 'pending', 'handoff', 'session'] as const).map(kind => Number(features.kind === kind)),
    (counts.opened + 1) / (Math.max(counts.offered, counts.opened) + 2),
    (counts.cited + 1) / (counts.opened + 2),
  ]
}

function probability(weights: readonly number[], x: readonly number[]): number {
  const z = x.reduce((sum, value, i) => sum + value * weights[i]!, 0)
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

function digestOf(turns: readonly SignalTurn[]): string {
  return createHash('sha256').update(JSON.stringify(turns)).digest('hex')
}

export function fitSignalWeights(turns: readonly SignalTurn[]): SignalWeights {
  const examples: Array<{ x: number[]; y: number }> = []
  const history: Record<string, SignalCounts> = {}
  for (const turn of turns) {
    const offered = new Map(turn.queries.flatMap(query => query.offered.map(id => [id, query.features[id]] as const)))
    for (const [id, features] of offered) {
      if (!features || features.pinned || !turn.opened.includes(id)) continue
      examples.push({ x: vector(features, history[id]), y: Number(turn.cited.includes(id)) })
    }
    for (const [id, count] of Object.entries(signalCounts([turn]))) {
      const previous = history[id] ??= { offered: 0, opened: 0, cited: 0 }
      previous.offered += count.offered
      previous.opened += count.opened
      previous.cited += count.cited
    }
  }
  const weights = SIGNAL_FEATURE_NAMES.map(() => 0)
  for (let step = 0; step < SIGNAL_FIT_STEPS && examples.length > 0; step++) {
    const gradient = weights.map(() => 0)
    for (const { x, y } of examples) {
      const error = probability(weights, x) - y
      for (let j = 0; j < weights.length; j++) gradient[j] = gradient[j]! + error * x[j]!
    }
    for (let j = 0; j < weights.length; j++) weights[j] = weights[j]! - 0.2 * (gradient[j]! / examples.length + (j === 0 ? 0 : 0.01 * weights[j]!))
  }
  return { version: 1, digest: digestOf(turns), samples: examples.length, features: SIGNAL_FEATURE_NAMES, weights }
}

export function signalWeightsPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'signal-weights.json')
}

export function readOrFitSignalWeights(dir: string = mnemeLibraryDir(), turns: readonly SignalTurn[] = readSignalLog(dir)): SignalWeights {
  const digest = digestOf(turns)
  try {
    const cached = JSON.parse(readFileSync(signalWeightsPath(dir), 'utf8')) as SignalWeights
    if (cached.version === 1 && cached.digest === digest && JSON.stringify(cached.features) === JSON.stringify(SIGNAL_FEATURE_NAMES) && Array.isArray(cached.weights) && cached.weights.length === SIGNAL_FEATURE_NAMES.length && cached.weights.every(Number.isFinite) && Number.isInteger(cached.samples) && cached.samples >= 0) return cached
  } catch {}
  const fit = fitSignalWeights(turns)
  if (turns.length > 0) {
    try { publishLibraryFile(signalWeightsPath(dir), JSON.stringify(fit)) } catch {}
  }
  return fit
}

export function signalRanking(candidates: readonly SignalCandidate[], dir: string = mnemeLibraryDir()): string[] | null {
  if (!mnemeEnabled()) return null
  const turns = readSignalLog(dir)
  if (turns.length === 0) return null
  const fit = readOrFitSignalWeights(dir, turns)
  if (fit.samples === 0) return null
  const counts = signalCounts(turns)
  return candidates.filter(candidate => !candidate.features.pinned && candidate.features.bm25 > 0)
    .map((candidate, index) => ({ id: candidate.id, index, score: probability(fit.weights, vector(candidate.features, counts[candidate.id])) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.id)
}

export function preservePinnedOrder(baseline: readonly string[], ranked: readonly string[], pinned: ReadonlySet<string>): string[] {
  const pool = new Set(baseline)
  const free = [...new Set([...ranked, ...baseline])].filter(id => pool.has(id) && !pinned.has(id))
  let index = 0
  return baseline.map(id => pinned.has(id) ? id : free[index++]!)
}
