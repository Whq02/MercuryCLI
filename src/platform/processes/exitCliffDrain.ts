import { channel } from 'node:diagnostics_channel'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { logForDebugging } from '../logs/debugLog.js'
import { sleep } from '../async/sleep.js'
import { withDeadline } from '../async/deadline.js'
import { afterMicrotask } from '../async/timers.js'

const EXIT_CLIFF_DRAIN_CHANNEL = 'mercury:exit-cliff-drain'
const drainChannel = channel(EXIT_CLIFF_DRAIN_CHANNEL)

export type ExitCliffSeam = {
  name: string
  phase: 1 | 2 | 3
  settle: () => Promise<unknown>
}

type ExitCliffDrainReport = {
  skipped: boolean
  settled: string[]
  failed: string[]
  abandoned: string[]
  elapsedMs: number
}

export const EXIT_CLIFF_DRAIN_MS = 1_500

const seams = new Set<ExitCliffSeam>()

export function registerExitCliffSeam(seam: ExitCliffSeam): () => void {
  seams.add(seam)
  return () => {
    seams.delete(seam)
  }
}

export function listExitCliffSeams(): readonly ExitCliffSeam[] {
  return [...seams]
}

function emptyReport(skipped: boolean): ExitCliffDrainReport {
  return { skipped, settled: [], failed: [], abandoned: [], elapsedMs: 0 }
}

type ExitCliffGrace = {
  readonly spent: boolean
  remainingMs(): number
  markSpent(): void
  elapsedMs(): number
}

function armGrace(graceMs: number): ExitCliffGrace {
  const armedAt = performance.now()
  const until = armedAt + graceMs
  let spent = graceMs <= 0
  return {
    get spent() {
      return spent || performance.now() >= until
    },
    remainingMs: () => (spent ? 0 : Math.max(0, until - performance.now())),
    markSpent: () => {
      spent = true
    },
    elapsedMs: () => Math.ceil(performance.now() - armedAt),
  }
}

async function drainSeamsUnder(
  list: readonly ExitCliffSeam[],
  grace: ExitCliffGrace,
  report: ExitCliffDrainReport,
): Promise<void> {
  for (const phase of [1, 2, 3] as const) {
    const batch = list.filter(seam => seam.phase === phase)
    if (batch.length === 0) continue
    const left = grace.remainingMs()
    if (left <= 0) {
      report.abandoned.push(...batch.map(seam => seam.name))
      continue
    }
    const pending = new Set(batch.map(seam => seam.name))
    const runs = batch.map(seam =>
      afterMicrotask(() => seam.settle())
        .then(
          () => {
            if (pending.delete(seam.name)) report.settled.push(seam.name)
          },
          err => {
            if (!pending.delete(seam.name)) return
            report.failed.push(seam.name)
            logForDebugging(`exit-cliff drain: seam ${seam.name} failed (ignored): ${String(err)}`)
          },
        ),
    )
    await withDeadline(Promise.all(runs), left, () => grace.markSpent())
    report.abandoned.push(...pending)
    pending.clear()
  }
}

export async function drainNamedSeams(
  list: readonly ExitCliffSeam[],
  graceMs: number = EXIT_CLIFF_DRAIN_MS,
): Promise<ExitCliffDrainReport> {
  const grace = armGrace(graceMs)
  const report = emptyReport(false)
  await drainSeamsUnder(list, grace, report)
  report.elapsedMs = grace.elapsedMs()
  return report
}

const EXIT_CLIFF_LOOP_TURNS = 2
async function turnLoopForTeardown(grace: ExitCliffGrace): Promise<void> {
  for (let hop = 0; hop < EXIT_CLIFF_LOOP_TURNS; hop++) {
    if (grace.spent) return
    await sleep(0)
  }
}

export async function drainExitCliffSeams(
  graceMs: number = EXIT_CLIFF_DRAIN_MS,
): Promise<ExitCliffDrainReport> {
  const skipped = !flagEnabled('MERCURY_EXIT_CLIFF_DRAIN')
  const seams = listExitCliffSeams().map(seam => seam.name)
  drainChannel.publish({ phase: 'before', seams, skipped })
  if (skipped) {
    const report = emptyReport(true)
    drainChannel.publish({ phase: 'after', report })
    return report
  }
  const grace = armGrace(graceMs)
  const report = emptyReport(false)
  await drainSeamsUnder(listExitCliffSeams(), grace, report)
  await turnLoopForTeardown(grace)
  report.elapsedMs = grace.elapsedMs()
  if (report.settled.length + report.failed.length + report.abandoned.length > 0) {
    logForDebugging(
      `exit-cliff drain: settled=[${report.settled.join(',')}] failed=[${report.failed.join(',')}] abandoned=[${report.abandoned.join(',')}] in ${report.elapsedMs}ms`,
    )
  }
  drainChannel.publish({ phase: 'after', report })
  return report
}
