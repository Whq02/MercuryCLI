
import type { ImpactManifest, ImpactSelection } from './impactManifest.ts'
import { selectImpact } from './impactManifest.ts'

export type GateClass = 'pure' | 'cpu' | 'pty' | 'exclusive' | 'undeclared'

export const DEFAULT_HUB_CEILING = 15
export const DEFAULT_CLEARLY_UNDER_RATIO = 0.5
export const DEFAULT_SUITE_SECONDS = 30

export interface SliceAnchor {
  treeSha: string
  source: string
  headSha: string | null
  ageCommits: number | null
}

export interface SlicePlanInput {
  changedPaths: string[]
  manifest: ImpactManifest
  classes: Record<string, GateClass>
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

export function estimatePooledWallS(
  suites: string[],
  opts: {
    durations: Record<string, number>
    classes: Record<string, GateClass>
    cores: number
    ptyMax?: number
  },
): number {
  const ptyMax = Math.max(1, opts.ptyMax ?? 3)
  const slotsTotal = Math.max(2, opts.cores)
  const pureMax = Math.max(1, slotsTotal - 2)
  const dur = (s: string): number => Math.max(1, Math.round(opts.durations[s] ?? DEFAULT_SUITE_SECONDS))
  const cls = (s: string): GateClass => opts.classes[s] ?? 'undeclared'
  const longestFirst = (a: string, b: string): number => dur(b) - dur(a) || a.localeCompare(b)
  const q = {
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
    for (;;) {
      if (q.pty.length > 0 && ptyN < ptyMax && slots + 2 <= slotsTotal) {
        launch(q.pty.shift()!, 2, 'pty')
        continue
      }
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
