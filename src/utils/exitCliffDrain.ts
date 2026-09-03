import { channel } from 'node:diagnostics_channel'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { logForDebugging } from './debug.js'

/** The proof channel: the census preload subscribes and dumps the live
 *  handles BEFORE the drain and AT the cliff after it, so the pin is a DELTA
 *  inside one run — the entries existed, then were drained by name — never
 *  an absence a broken preload could also produce. A publish with no
 *  subscriber costs nothing. */
export const EXIT_CLIFF_DRAIN_CHANNEL = 'mercury:exit-cliff-drain'
const drainChannel = channel(EXIT_CLIFF_DRAIN_CHANNEL)

/**
 * The exit-cliff drain — the ONE owner of "what must land before process.exit".
 *
 * A seam is in-flight work the cleanup registry cannot see: persistence a
 * turn armed fire-and-forget (the transcript writer's queued appends, any
 * store derived from them) or a channel that must shut (a watcher). Owners
 * REGISTER a seam by name at their own load time — the cleanupRegistry
 * doctrine: this module never imports an owner, so the shutdown path never
 * instantiates what a boot never touched.
 *
 * The handle census: at the cliff EVERY -p run
 * — a no-tool control included — still had the transcript writer's append
 * IN FLIGHT: the run's own data, discarded by process.exit. The drain holds
 * the seams by name, in three phases ordered by data dependency (the source
 * of truth, then what derives from it, then the channels they write through
 * — closing a channel under a line still being projected through it would
 * fail the projection), under ONE bounded grace: a settled seam costs zero,
 * a wedged one is abandoned at the grace so no exit ever hangs.
 *
 * The win32 libuv assert the box banked (src/win/async.c: uv_async_send on
 * a closing handle, exit 0xC0000409) is the RUNTIME's own teardown race —
 * DisposePlatform stops the V8 platform's DelayedTaskScheduler while a V8
 * background thread can still post to it (nodejs/node#56645, fixed by PR
 * #61999 in Node 24.20.0). No JS-side drain can reach that sender; this
 * owner keeps the product's side of the cliff empty so the only in-flight
 * sender left at process.exit is the runtime's, and the doctor names the
 * runtime floor.
 */
export type ExitCliffSeam = {
  /** Named on the diagnostics line — the census prover keys on it. */
  name: string
  /** Phases run in order, each only after the previous settled or was
   *  abandoned — the data dependency between the seams:
   *  1 = the source of truth (the transcript writer's queued lines);
   *  2 = persistence DERIVED from a landed line (a line the phase-1 flush
   *      lands resumes its recordTranscript continuation, which may start
   *      derived work; settling that work before the flush would miss it);
   *  3 = the channels those producers write through (settle the append
   *      chain, then close the watcher). */
  phase: 1 | 2 | 3
  settle: () => Promise<unknown>
}

export type ExitCliffDrainReport = {
  /** The registered poison seam was armed — nothing was drained. */
  skipped: boolean
  settled: string[]
  /** Rejected — the work is over, its owner logged the reason. */
  failed: string[]
  /** Still pending at the grace — abandoned by name, never held forever. */
  abandoned: string[]
  elapsedMs: number
}

/** One grace for the whole drain: both phases, every seam together. Small
 *  enough that a wedged seam cannot hold the exit; large enough that a real
 *  in-flight append (lock + line + fsync + head publish) lands. */
export const EXIT_CLIFF_DRAIN_MS = 1_500

const seams = new Set<ExitCliffSeam>()

/** Register a seam; returns its unregister. A set keyed by identity, so a
 *  reference registered twice is one seam. */
export function registerExitCliffSeam(seam: ExitCliffSeam): () => void {
  seams.add(seam)
  return () => {
    seams.delete(seam)
  }
}

/** The registered seams, for the provers and the census line. */
export function listExitCliffSeams(): readonly ExitCliffSeam[] {
  return [...seams]
}

function emptyReport(skipped: boolean): ExitCliffDrainReport {
  return { skipped, settled: [], failed: [], abandoned: [], elapsedMs: 0 }
}

/**
 * Drain `list` phase by phase under ONE deadline. Never throws: a seam that
 * throws synchronously or rejects is `failed` (settled, its work is over); a
 * seam still pending when the deadline lands is `abandoned` by name and the
 * next phase runs against what remains of the grace (zero ⇒ abandoned too).
 */
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

/** The loop turns the cliff owes what the seams and the cleanups just
 *  closed. A close is asynchronous in the runtime: `watcher.close()` hands
 *  libuv a handle whose teardown runs in the loop's closing phase, and a
 *  landed append's file-handle close is a request the runtime frees only
 *  after its resolution's microtasks return. The shutdown tail from the
 *  last completion to process.exit ran on ONE microtask chain and never
 *  yielded, so the handle census at the cliff still listed every closed
 *  watcher as alive and the landed append's close as a live request — the
 *  exit tore down a loop that only looked busy. A 0 ms timer fires on the
 *  NEXT iteration, after this one's closing phase; two hops cover a close
 *  scheduled from inside a close callback. Bounded by the drain's grace. */
export const EXIT_CLIFF_LOOP_TURNS = 2
async function turnLoopForTeardown(deadline: number): Promise<void> {
  for (let hop = 0; hop < EXIT_CLIFF_LOOP_TURNS; hop++) {
    if (Date.now() >= deadline) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/**
 * The product's cliff: every registered seam under the shared grace, then
 * the loop turns that let the runtime tear down what those seams and the
 * cleanups before them closed. The registered poison seam
 * MERCURY_EXIT_CLIFF_DRAIN=0 skips both — the census prover's pre-fix arm,
 * never set in normal operation.
 */
export async function drainExitCliffSeams(
  graceMs: number = EXIT_CLIFF_DRAIN_MS,
): Promise<ExitCliffDrainReport> {
  const skipped = !flagEnabled('MERCURY_EXIT_CLIFF_DRAIN')
  const seams = listExitCliffSeams().map(seam => seam.name)
  // Published even when the poison seam skips the drain: the census's
  // "before" dump is the same moment in both arms.
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
