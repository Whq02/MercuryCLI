// traceSnapshot — the invocation-trace sidecar (mercury-trace.jsonl). Parses
// line-by-line (malformed lines skipped, never throws) and rolls up
// calls/high-risk-class/killed/errors. States: `live` with records · `off` when tracing is
// disabled and no file · `unavailable` when enabled but the file is empty/missing.
import { readFile } from 'node:fs/promises'
import {
  getInvocationTracePath,
  isInvocationTraceEnabled,
  type CompactionTrace,
  type InvocationTrace,
} from '../observability/invocationTrace.js'
import { withState, type Snapshot } from './types.js'

/** Rolled-up compaction-pipeline activity (the paper's most opaque subsystem). */
export type CompactionAgg = {
  total: number
  totalTokensFreed: number
  byEvent: { event: string; count: number; tokensFreed: number }[]
  last?: { ts: string; event: string; tokensFreed?: number }
}

export type TraceData = {
  records: InvocationTrace[]
  total: number
  /** Risk-CLASS tally (manifest classes every exec/net tool 'high') — a count
   *  of shell/network calls, NOT a warning count. Surfaces must tone it
   *  neutral (product-study r2: '▲94' read as 94 warnings). */
  highRisk: number
  /** REAL kills only (capability gate / permission kill) — the only count
   *  that earns CRIMSON ✕ on a chip. */
  killed: number
  /** Plain failed calls (ok:false, not killed): a no-match grep, a non-zero
   *  exit — routine work, never a denial. */
  errors: number
  compaction: CompactionAgg
}

/**
 * Single-pass parse of the shared sidecar: one `split('\n')` + one JSON.parse
 * per line, classifying each record into invocation traces (`typeof rec.tool ===
 * 'string'`) and compaction traces (`rec.kind === 'compaction'`). Replaces two
 * separate full passes that JSON.parsed every line TWICE — on the bounded-2MB
 * sidecar this halves JSON.parse calls + line-array allocations on the 5s
 * deck-pane hot path (Deck/MercuryHome/TraceView/PolicyPanel all call it). The
 * two classifications are applied independently per line, so the output is the
 * byte-identical union of the old parseTrace + parseCompactionTrace. Malformed
 * lines are skipped (never throws).
 */
export function parseTraceLines(text: string): {
  records: InvocationTrace[]
  compaction: CompactionTrace[]
} {
  const records: InvocationTrace[] = []
  const compaction: CompactionTrace[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (!rec || typeof rec !== 'object') continue
      if (typeof rec.tool === 'string') records.push(rec as InvocationTrace)
      if (rec.kind === 'compaction' && typeof rec.event === 'string') {
        compaction.push(rec as CompactionTrace)
      }
    } catch {
      // partial/garbage write — skip the line, never break the view
    }
  }
  return { records, compaction }
}

const emptyCompaction: CompactionAgg = { total: 0, totalTokensFreed: 0, byEvent: [] }
const empty: TraceData = { records: [], total: 0, highRisk: 0, killed: 0, errors: 0, compaction: emptyCompaction }

/** Roll up compaction records by event (count + tokens freed), newest-last. Pure. */
export function aggregateCompaction(records: CompactionTrace[]): CompactionAgg {
  const map = new Map<string, { event: string; count: number; tokensFreed: number }>()
  let totalTokensFreed = 0
  for (const r of records) {
    const event = typeof r?.event === 'string' && r.event ? r.event : '?'
    let a = map.get(event)
    if (!a) {
      a = { event, count: 0, tokensFreed: 0 }
      map.set(event, a)
    }
    a.count++
    if (typeof r.tokensFreed === 'number' && Number.isFinite(r.tokensFreed)) {
      a.tokensFreed += r.tokensFreed
      totalTokensFreed += r.tokensFreed
    }
  }
  const lastRec = records[records.length - 1]
  return {
    total: records.length,
    totalTokensFreed,
    byEvent: [...map.values()].sort((x, y) => y.count - x.count || x.event.localeCompare(y.event)),
    last: lastRec
      ? { ts: lastRec.ts, event: lastRec.event, tokensFreed: lastRec.tokensFreed }
      : undefined,
  }
}

/** One tool's rolled-up trace stats (for the /trace per-tool breakdown). */
export type ToolAgg = {
  tool: string
  count: number
  /** invocations that ended ok:false OR killed (capability-gate / error). */
  failed: number
  surface: string
  risk: string
  avgDurationMs: number
}

/**
 * Aggregate trace records BY TOOL — the last-N table is fine for a short session
 * but useless for a long autonomous run (1000s of calls); this turns the raw
 * trace into insight: which tools ran most, and their failure rate + avg
 * duration. Pure (no IO), sorted by count desc then failures desc. A tool's
 * surface/risk are stable (descriptor-derived), so the last seen value wins.
 */
export function aggregateByTool(records: InvocationTrace[]): ToolAgg[] {
  const map = new Map<
    string,
    { tool: string; count: number; failed: number; surface: string; risk: string; totalMs: number; durSamples: number }
  >()
  for (const r of records) {
    const tool = typeof r?.tool === 'string' && r.tool ? r.tool : '?'
    let a = map.get(tool)
    if (!a) {
      a = { tool, count: 0, failed: 0, surface: '?', risk: '?', totalMs: 0, durSamples: 0 }
      map.set(tool, a)
    }
    a.count++
    if (r.ok === false || r.killed === true) a.failed++
    if (typeof r.surface === 'string' && r.surface) a.surface = r.surface
    if (typeof r.risk === 'string' && r.risk) a.risk = r.risk
    if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)) {
      a.totalMs += r.durationMs
      a.durSamples++
    }
  }
  return [...map.values()]
    .map(a => ({
      tool: a.tool,
      count: a.count,
      failed: a.failed,
      surface: a.surface,
      risk: a.risk,
      avgDurationMs: a.durSamples ? Math.round(a.totalMs / a.durSamples) : 0,
    }))
    .sort((x, y) => y.count - x.count || y.failed - x.failed || x.tool.localeCompare(y.tool))
}

/** Session pulse — invocation velocity over a recent window (the SPARK sparkline). */
export type VelocityPulse = {
  /** Calls per bin, oldest→newest (length === bins). Drives the sparkline. */
  perMin: number[]
  bins: number
  binMs: number
  /** Total calls inside the window. */
  total: number
  /** Busiest single bin. */
  peakPerMin: number
  /** Recent-third vs earliest-third of the window. */
  trend: 'rising' | 'falling' | 'steady'
  /** Seconds since the most recent call (now − lastTs); 0 when none / a future ts. */
  idleSec: number
}

/**
 * Aggregate invocation velocity into a recent time window — the by-tool table
 * says WHAT ran, this says WHEN + HOW FAST, the pulse a long autonomous run lacks.
 * Pure: bins records by their ISO `ts` into `bins` slots of `binMs` ending at
 * `nowMs` (the caller passes Date.now() — kept a param so the math is testable +
 * deterministic, never calling the clock itself). NaN/in-the-future ts skipped;
 * never throws. trend compares the newest third of the window to the oldest third.
 */
export function aggregateVelocity(
  records: InvocationTrace[],
  nowMs: number,
  bins = 14,
  binMs = 60_000,
): VelocityPulse {
  const perMin = new Array<number>(bins).fill(0)
  const windowStart = nowMs - bins * binMs
  let total = 0
  let lastTs = 0
  for (const r of records) {
    const t = Date.parse(r?.ts ?? '')
    if (!Number.isFinite(t)) continue
    if (t > nowMs) continue // future / clock skew — ignore entirely
    if (t > lastTs) lastTs = t // newest real activity (even if older than the window)
    if (t < windowStart) continue // older than the sparkline window — not binned
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((t - windowStart) / binMs)))
    perMin[idx]++
    total++
  }
  const peakPerMin = perMin.reduce((m, v) => Math.max(m, v), 0)
  // trend: newest third vs oldest third (hysteresis bands avoid jitter).
  const third = Math.max(1, Math.floor(bins / 3))
  const recent = perMin.slice(bins - third).reduce((a, b) => a + b, 0)
  const early = perMin.slice(0, third).reduce((a, b) => a + b, 0)
  const trend: VelocityPulse['trend'] =
    recent > early * 1.25 ? 'rising' : recent < early * 0.75 ? 'falling' : 'steady'
  const idleSec = lastTs > 0 && nowMs >= lastTs ? Math.floor((nowMs - lastTs) / 1000) : 0
  return { perMin, bins, binMs, total, peakPerMin, trend, idleSec }
}

export async function traceSnapshot(): Promise<Snapshot<{ data: TraceData }>> {
  const enabled = (() => {
    try {
      return isInvocationTraceEnabled()
    } catch {
      return false
    }
  })()
  try {
    const text = await readFile(getInvocationTracePath(), 'utf8')
    const { records, compaction: compactionRecs } = parseTraceLines(text)
    const compaction = aggregateCompaction(compactionRecs)
    if (records.length === 0 && compaction.total === 0) {
      return withState(
        enabled ? 'unavailable' : 'off',
        empty,
        enabled ? 'no events yet' : 'enable with MERCURY_TRACE=1',
        getInvocationTracePath(),
      )
    }
    return {
      state: 'live',
      source: getInvocationTracePath(),
      data: {
        records,
        total: records.length,
        highRisk: records.filter(r => r.risk === 'high').length,
        killed: records.filter(r => r.killed === true).length,
        errors: records.filter(r => r.ok === false && r.killed !== true).length,
        compaction,
      },
    }
  } catch {
    return withState(
      enabled ? 'unavailable' : 'off',
      empty,
      enabled ? 'no trace file yet' : 'enable with MERCURY_TRACE=1 or MERCURY_SUBSTRATE=1',
    )
  }
}
