import { channel } from 'node:diagnostics_channel'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { logForDebugging } from './debug.js'

export const EXIT_CLIFF_DRAIN_CHANNEL = 'mercury:exit-cliff-drain'
const drainChannel = channel(EXIT_CLIFF_DRAIN_CHANNEL)

export type ExitCliffSeam = {
  name: string
  phase: 1 | 2 | 3
  settle: () => Promise<unknown>
}

export type ExitCliffDrainReport = {
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

export async function drainNamedSeams(
  list: readonly ExitCliffSeam[],
  graceMs: number = EXIT_CLIFF_DRAIN_MS,
): Promise<ExitCliffDrainReport> {
  const started = Date.now()
  const deadline = started + graceMs
  const report = emptyReport(false)
  for (const phase of [1, 2, 3] as const) {
    const batch = list.filter(seam => seam.phase === phase)
    if (batch.length === 0) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      report.abandoned.push(...batch.map(seam => seam.name))
      continue
    }
    const pending = new Set(batch.map(seam => seam.name))
    const runs = batch.map(seam =>
      Promise.resolve()
        .then(() => seam.settle())
        .then(
          () => {
            report.settled.push(seam.name)
          },
          err => {
            report.failed.push(seam.name)
            logForDebugging(`exit-cliff drain: seam ${seam.name} failed (ignored): ${String(err)}`)
          },
        )
        .finally(() => {
          pending.delete(seam.name)
        }),
    )
    let grace: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(runs),
        new Promise<void>(resolve => {
          grace = setTimeout(resolve, remaining)
        }),
      ])
    } finally {
      if (grace) clearTimeout(grace)
    }
    report.abandoned.push(...pending)
  }
  report.elapsedMs = Date.now() - started
  return report
}

export const EXIT_CLIFF_LOOP_TURNS = 2
async function turnLoopForTeardown(deadline: number): Promise<void> {
  for (let hop = 0; hop < EXIT_CLIFF_LOOP_TURNS; hop++) {
    if (Date.now() >= deadline) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
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
  const started = Date.now()
  const report = await drainNamedSeams(listExitCliffSeams(), graceMs)
  await turnLoopForTeardown(started + graceMs)
  report.elapsedMs = Date.now() - started
  if (report.settled.length + report.failed.length + report.abandoned.length > 0) {
    logForDebugging(
      `exit-cliff drain: settled=[${report.settled.join(',')}] failed=[${report.failed.join(',')}] abandoned=[${report.abandoned.join(',')}] in ${report.elapsedMs}ms`,
    )
  }
  drainChannel.publish({ phase: 'after', report })
  return report
}
