// ============================================================================
//  scripts/verify/sliceCore.ts — the PURE slice-rung planner (
// returned verify:fast from PARKED).
//
//  ONE pure decision over injected inputs — no fs, no env, no git, no clock —
//  so every law is provable on fixtures (scripts/verify/prove-slice-core.ts):
//
//    · ESCALATE (correctness — the manifest cannot bound the change; the FULL
//      gate auto-runs, today's contract):
// any UNCLASSIFIED changed path, or
//        - the HUB FAN-OUT CEILING: a single changed path whose watch fan-out
//          exceeds the ceiling — the declaration plane is saturated for that
//          path, and a near-pool-width "slice" proves less than the pool for
//          the same wall (a subset run writes no verdict). Named by path.
//    · REFUSE (economics — the slice is sound but not worth running; exit
//      non-zero naming "run the full pool", NEVER auto-runs):
//        - the anchor is absent (no full-green verdict tree ⇒ no sound
//          changed set), or
//        - the NOT-FASTER LAW: the slice's estimated pooled wall is not
//          clearly under the full pool's (default: strictly < 50%). A stale
//          anchor grows the changed set → the selection → the estimate, so
//          anchor age needs no threshold of its own — the 55-suite-crawl
//          class is structurally unreachable through the estimate.
//    · RUN: the selected suites, executed by the CALLER through the SAME
//      class-aware pooled lanes as the full gate (run-all-suites.sh subset —
//      selection ≡ lanes by construction, never a sequential crawl).
//
//  The wall estimator mirrors scripts/run-all-suites.sh's dispatch loop
//  exactly (lane caps · slot weights · longest-first · exclusive-alone ·
//  the empty-floor deadlock guard) — a deterministic simulation, wall-clock
//  advisory only: a wrong estimate can cost a refusal or a run, never a
//  verdict.
// ============================================================================

import type { ImpactManifest, ImpactSelection } from './impactManifest.ts'
import { selectImpact } from './impactManifest.ts'

export type GateClass = 'pure' | 'cpu' | 'pty' | 'exclusive' | 'undeclared'

/** Defaults for the tunable laws (CLI env seams override; provers inject). */
export const DEFAULT_HUB_CEILING = 15
export const DEFAULT_CLEARLY_UNDER_RATIO = 0.5
export const DEFAULT_SUITE_SECONDS = 30 // matches the scheduler's dur_of fallback

export interface SliceAnchor {
  /** The full-green content tree the changed set is computed against. */
  treeSha: string
  /** Where it came from ('local verdict' | 'ci verdict'). */
  source: string
  /** The commit the verdict/run was recorded at (null: unrecorded). */
  headSha: string | null
  /** Commits between the anchor head and HEAD (null: not computable). */
  ageCommits: number | null
}

export interface SlicePlanInput {
  /** Committed-since-anchor ∪ working dirt, repo-relative, deduped. */
  changedPaths: string[]
  manifest: ImpactManifest
  /** suite → declared gate-class (absent ⇒ 'undeclared', pty-conservative). */
  classes: Record<string, GateClass>
  /** suite → last observed pooled seconds (verdict rows over seed rows). */
  durations: Record<string, number>
  anchor: SliceAnchor | null
  cores: number
  ptyMax: number
  hubCeiling: number
  clearlyUnderRatio: number
}

export interface SliceLedger {
  selection: ImpactSelection | null
  suites: string[]
  sliceEstimateS: number | null
  poolEstimateS: number
  hubs: Array<{ path: string; fanout: number }>
}

export type SlicePlan =
  | { kind: 'refuse'; reason: 'anchor-absent' | 'not-faster'; message: string; ledger: SliceLedger }
  | { kind: 'escalate'; reason: 'unclassified' | 'hub-fanout'; message: string; ledger: SliceLedger }
  | { kind: 'run'; suites: string[]; ledger: SliceLedger }

interface RunningSuite {
  end: number
  wt: number
  cls: 'pty' | 'cpu' | 'pure' | 'excl'
}

/**
 * Deterministic makespan estimate for a suite set through the gate's
 * class-aware pooled lanes. Mirrors run-all-suites.sh: SLOTS_TOTAL=cores,
 * pty cap `ptyMax` (weight 2), cpu weight 2, pure cap cores-2 (weight 1),
 * exclusive alone after every queue drains, queues longest-first, and the
 * empty-floor deadlock guard (always run SOMETHING).
 */
export function estimatePooledWallS(
  suites: string[],
  opts: {
    durations: Record<string, number>
    classes: Record<string, GateClass>
    cores: number
    ptyMax?: number
  },
): number {
  const ptyMax = Math.max(1, opts.ptyMax ?? 3) // gate default since the adoption
  const slotsTotal = Math.max(2, opts.cores)
  const pureMax = Math.max(1, slotsTotal - 2)
  const dur = (s: string): number => Math.max(1, Math.round(opts.durations[s] ?? DEFAULT_SUITE_SECONDS))
  const cls = (s: string): GateClass => opts.classes[s] ?? 'undeclared'
  const longestFirst = (a: string, b: string): number => dur(b) - dur(a) || a.localeCompare(b)
  const q = {
    // undeclared schedules conservatively in the pty lane, like the gate
    pty: suites.filter(s => cls(s) === 'pty' || cls(s) === 'undeclared').sort(longestFirst),
    cpu: suites.filter(s => cls(s) === 'cpu').sort(longestFirst),
    pure: suites.filter(s => cls(s) === 'pure').sort(longestFirst),
    excl: suites.filter(s => cls(s) === 'exclusive').sort(longestFirst),
  }
  let t = 0
  let slots = 0
  let ptyN = 0
  let pureN = 0
  const running: RunningSuite[] = []
  const launch = (name: string, wt: number, c: RunningSuite['cls']): void => {
    running.push({ end: t + dur(name), wt, cls: c })
    slots += wt
    if (c === 'pty') ptyN++
    if (c === 'pure') pureN++
  }
  while (q.pty.length + q.cpu.length + q.pure.length + q.excl.length > 0 || running.length > 0) {
    // dispatch while capacity — the same preference order as the gate
    for (;;) {
      if (q.pty.length > 0 && ptyN < ptyMax && slots + 2 <= slotsTotal) {
        launch(q.pty.shift()!, 2, 'pty')
        continue
      }
      // cpu before pure for the leftover slots — unless the pure head fits and
      // outlasts the cpu head (longest-first across the two lanes, as the gate)
      const pureHeadOutlastsCpu =
        q.pure.length > 0 && pureN < pureMax && slots + 1 <= slotsTotal && q.cpu.length > 0 && dur(q.pure[0]!) > dur(q.cpu[0]!)
      if (q.cpu.length > 0 && slots + 2 <= slotsTotal && !pureHeadOutlastsCpu) {
        launch(q.cpu.shift()!, 2, 'cpu')
        continue
      }
      if (q.pure.length > 0 && pureN < pureMax && slots + 1 <= slotsTotal) {
        launch(q.pure.shift()!, 1, 'pure')
        continue
      }
      // exclusive: ALONE — every other queue drained and the floor empty
      if (
        q.excl.length > 0 &&
        running.length === 0 &&
        q.pty.length === 0 &&
        q.cpu.length === 0 &&
        q.pure.length === 0
      ) {
        launch(q.excl.shift()!, slotsTotal, 'excl')
        break
      }
      // deadlock guard: with an empty floor, always run SOMETHING
      if (running.length === 0) {
        if (q.pty.length > 0) {
          launch(q.pty.shift()!, 2, 'pty')
          continue
        }
        if (q.cpu.length > 0) {
          launch(q.cpu.shift()!, 2, 'cpu')
          continue
        }
        if (q.pure.length > 0) {
          launch(q.pure.shift()!, 1, 'pure')
          continue
        }
      }
      break
    }
    if (running.length === 0) break
    // advance to the earliest completion, reap everything ending then
    let tNext = Infinity
    for (const r of running) tNext = Math.min(tNext, r.end)
    t = tNext
    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i]!
      if (r.end <= t) {
        slots -= r.wt
        if (r.cls === 'pty') ptyN--
        if (r.cls === 'pure') pureN--
        running.splice(i, 1)
      }
    }
  }
  return t
}

/** The ONE slice decision. Order: anchor (soundness of the changed set) →
 *  unclassified (fail-closed) → hub ceiling → the not-faster law → run. */
export function planSlice(input: SlicePlanInput): SlicePlan {
  const poolEstimateS = estimatePooledWallS(input.manifest.suites, {
    durations: input.durations,
    classes: input.classes,
    cores: input.cores,
    ptyMax: input.ptyMax,
  })
  const base: SliceLedger = {
    selection: null,
    suites: [],
    sliceEstimateS: null,
    poolEstimateS,
    hubs: [],
  }
  if (input.anchor === null) {
    return {
      kind: 'refuse',
      reason: 'anchor-absent',
      message:
        'no full-green verdict tree to anchor the changed set — ' +
        'run the full pool (bash scripts/run-all-suites.sh) to anchor the slice rung',
      ledger: base,
    }
  }
  const selection = selectImpact(input.manifest, input.changedPaths)
  const suites = [...selection.suites].sort()
  const hubs = Object.entries(selection.perPath)
    .filter(([, who]) => who[0] !== '(ignored)' && who[0] !== '(UNCLASSIFIED)' && who.length > input.hubCeiling)
    .map(([path, who]) => ({ path, fanout: who.length }))
    .sort((a, b) => b.fanout - a.fanout)
  const ledger: SliceLedger = { ...base, selection, suites, hubs }
  if (selection.unclassified.length > 0) {
    return {
      kind: 'escalate',
      reason: 'unclassified',
      message:
        `${selection.unclassified.length} UNCLASSIFIED changed path(s) — no suite watches them and they are ` +
        'not declared ignorable; the manifest cannot bound the blast radius',
      ledger,
    }
  }
  if (hubs.length > 0) {
    const worst = hubs[0]!
    return {
      kind: 'escalate',
      reason: 'hub-fanout',
      message:
        `hub fan-out: ${worst.path} selects ${worst.fanout} suites (ceiling ${input.hubCeiling}) — ` +
        'the declaration plane is saturated for this path; a near-pool-width slice would prove ' +
        'less than the pool for the same wall',
      ledger,
    }
  }
  const sliceEstimateS = estimatePooledWallS(suites, {
    durations: input.durations,
    classes: input.classes,
    cores: input.cores,
    ptyMax: input.ptyMax,
  })
  ledger.sliceEstimateS = sliceEstimateS
  if (suites.length > 0 && sliceEstimateS >= input.clearlyUnderRatio * poolEstimateS) {
    const pct = Math.round((sliceEstimateS / Math.max(1, poolEstimateS)) * 100)
    return {
      kind: 'refuse',
      reason: 'not-faster',
      message:
        `slice ≈ ${sliceEstimateS}s pooled is not clearly under the full pool ≈ ${poolEstimateS}s ` +
        `(${pct}%; the law: strictly < ${Math.round(input.clearlyUnderRatio * 100)}%) — ` +
        'run the full pool (bash scripts/run-all-suites.sh); it also re-anchors the slice rung',
      ledger,
    }
  }
  return { kind: 'run', suites, ledger }
}
