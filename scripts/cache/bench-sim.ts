#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Decision,
  type SessionRollup,
  classifyGap,
  decideInitialTtl,
  newSimCacheState,
  priorFromRollups,
  shouldEscalate,
  stepCache,
} from '../../src/utils/cache/cacheClockCore.js'

export interface Corpus {
  v: number
  name: string
  sessions: { id: string; startMs: number; events: { d: number; p: number; o: number }[] }[]
}

function genDurMs(outputTokens: number): number {
  return Math.min(15 * 60_000, 5_000 + (outputTokens / 30) * 1000)
}

function arrivalTimes(session: Corpus['sessions'][number]): number[] {
  const out: number[] = []
  let t = session.startMs
  for (let i = 0; i < session.events.length; i++) {
    const ev = session.events[i]!
    if (i > 0) t += ev.d
    const arrival = t - genDurMs(ev.o)
    out.push(i === 0 ? arrival : Math.max(arrival, out[i - 1]! + 1))
  }
  return out
}

interface PolicyTotals {
  costUnits: number
  readTokens: number
  writtenTokens: number
  coldRewrites: number
}

function newTotals(): PolicyTotals {
  return { costUnits: 0, readTokens: 0, writtenTokens: 0, coldRewrites: 0 }
}

export interface BenchmarkResult {
  corpus: { sessions: number; requests: number; spanDays: number }
  costUnits: { baseline5m: number; clock: number; all1h: number }
  savingsPct: number
  coldRewrites: { baseline5m: number; clock: number }
  clock: { upfront1hSessions: number; escalatedSessions: number; fiveMSessions: number }
  worstSessionRegressionPct: number
  regressedSessions: number
}

export function runBenchmark(
  corpus: Corpus,
  decide: typeof decideInitialTtl = decideInitialTtl,
): BenchmarkResult {
  const base = newTotals()
  const clock = newTotals()
  const all1h = newTotals()
  let upfront1h = 0
  let escalated = 0
  let fiveM = 0
  let worstRegressionPct = 0
  let regressedSessions = 0
  let requests = 0

  const rollups: SessionRollup[] = []
  const sessions = [...corpus.sessions].sort((a, b) => a.startMs - b.startMs)

  for (const session of sessions) {
    const arrivals = arrivalTimes(session)
    requests += session.events.length

    const bState = newSimCacheState('5m')
    let bCost = 0
    const aState = newSimCacheState('1h')
    let decision: Decision | null = decide({
      enabled: true,
      pin: null,
      eligible: true,
      cls: 'interactive',
      prior: priorFromRollups(rollups),
    })
    if (decision === null) throw new Error('clock disengaged in sim — bug')
    const wasUpfront1h = decision.ttl === '1h'
    let didEscalate = false
    const cState = newSimCacheState(decision.ttl)
    let cCost = 0
    let gapsOver5m = 0
    let gapsOver1h = 0

    for (let i = 0; i < session.events.length; i++) {
      const p = session.events[i]!.p
      const at = arrivals[i]!
      let escalateNow = false
      if (i > 0) {
        const gapMs = at - arrivals[i - 1]!
        const kind = classifyGap(gapMs)
        if (kind === 'over5m') gapsOver5m++
        if (kind === 'over1h') gapsOver1h++
        if (shouldEscalate(decision, gapMs)) {
          decision = { ttl: '1h', escalation: false }
          escalateNow = true
          didEscalate = true
        }
      }
      const b = stepCache(bState, at, p)
      bCost += b.costUnits
      base.costUnits += b.costUnits
      base.readTokens += b.readTokens
      base.writtenTokens += b.writtenTokens
      if (b.coldRewrite) base.coldRewrites++

      const c = stepCache(cState, at, p, escalateNow ? '1h' : undefined)
      cCost += c.costUnits
      clock.costUnits += c.costUnits
      clock.readTokens += c.readTokens
      clock.writtenTokens += c.writtenTokens
      if (c.coldRewrite) clock.coldRewrites++

      const a = stepCache(aState, at, p)
      all1h.costUnits += a.costUnits
      if (a.coldRewrite) all1h.coldRewrites++
    }

    if (wasUpfront1h) upfront1h++
    else if (didEscalate) escalated++
    else fiveM++

    if (cCost > bCost && bCost > 0) {
      regressedSessions++
      const reg = ((cCost - bCost) / bCost) * 100
      if (reg > worstRegressionPct) worstRegressionPct = reg
    }

    rollups.push({
      v: 1,
      sessionId: session.id,
      cls: 'interactive',
      startedIso: new Date(session.startMs).toISOString(),
      decidedTtl: wasUpfront1h ? '1h' : '5m',
      requests: session.events.length,
      gapsOver5m,
      gapsOver1h,
      tokens: { read: 0, w5m: 0, w1h: 0, uncached: 0 },
      costUnits: { actual: Math.round(cCost), baseline5m: Math.round(bCost) },
      updatedIso: new Date(session.startMs).toISOString(),
    })
  }

  const spanDays =
    sessions.length > 0
      ? (sessions[sessions.length - 1]!.startMs - sessions[0]!.startMs) /
        86_400_000
      : 0

  return {
    corpus: { sessions: sessions.length, requests, spanDays: Math.round(spanDays * 10) / 10 },
    costUnits: {
      baseline5m: Math.round(base.costUnits),
      clock: Math.round(clock.costUnits),
      all1h: Math.round(all1h.costUnits),
    },
    savingsPct:
      Math.round(
        ((base.costUnits - clock.costUnits) / base.costUnits) * 1000,
      ) / 10,
    coldRewrites: { baseline5m: base.coldRewrites, clock: clock.coldRewrites },
    clock: {
      upfront1hSessions: upfront1h,
      escalatedSessions: escalated,
      fiveMSessions: fiveM,
    },
    worstSessionRegressionPct: Math.round(worstRegressionPct * 10) / 10,
    regressedSessions,
  }
}

export function corpusSha256(corpusBytes: string): string {
  return createHash('sha256').update(corpusBytes).digest('hex')
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..', '..')
  const corpusPath = join(root, 'scripts', 'cache', 'fixtures', 'corpus.json')
  const corpusBytes = readFileSync(corpusPath, 'utf8')
  const corpus = JSON.parse(corpusBytes) as Corpus
  const result = runBenchmark(corpus)
  const escalateOnly = runBenchmark(corpus, () => ({
    ttl: '5m',
    escalation: true,
  }))

  const verdict = {
    v: 1,
    benchmark: 'cache-clock-sim-v1',
    generatedIso: new Date().toISOString(),
    corpusSha256: corpusSha256(corpusBytes),
    method:
      'deterministic replay of real shape-only session traces through the PRODUCTION cacheClockCore decision table (prior evolving chronologically) vs the flat all-5m baseline; arrival-time correction (completion − generous 30tok/s generation estimate); API-multiplier pricing (0.1 read / 1.25 5m write / 2.0 1h write); all sessions classed interactive (conservative)',
    result,
    variants: {
      escalateOnly: {
        costUnits: escalateOnly.costUnits.clock,
        savingsPct: escalateOnly.savingsPct,
        coldRewrites: escalateOnly.coldRewrites.clock,
        regressedSessions: escalateOnly.regressedSessions,
        worstSessionRegressionPct: escalateOnly.worstSessionRegressionPct,
      },
    },
    green: result.costUnits.clock < result.costUnits.baseline5m,
    evidenceRefs: [
      'scripts/cache/bench-sim.ts',
      'scripts/cache/fixtures/corpus.json',
    ],
  }

  console.log(JSON.stringify(verdict.result, null, 2))
  console.log(`green: ${verdict.green} (savings ${result.savingsPct}%)`)

  if (process.argv.includes('--write')) {
    const outPath = join(root, 'scripts', 'cache', 'fixtures', 'verdict.json')
    writeFileSync(outPath, JSON.stringify(verdict, null, 2))
    console.log(`wrote ${outPath}`)
  }
}
