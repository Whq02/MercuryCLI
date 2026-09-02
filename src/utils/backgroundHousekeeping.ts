import * as fs from 'fs/promises'
import { join } from 'path'
import { scheduleMnemeMaintenance } from '../memdir/mnemeMaintenance.js'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { getMercuryHome } from './envUtils.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

// Type-only reference; the deep-link registration module is not loaded here.
const registerProtocolModule: typeof import('./deepLink/registerProtocol.js') | null = null

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import { runLifecyclePass } from '../substrate/stateLifecycle.js'
import { cleanupOldMessageFilesInBackground } from './cleanup.js'
import { logForDebugging } from './debug.js'

// 24 hours in milliseconds — the recurring cadence (G09: the constant
// existed for months with ZERO uses while the header promised recurrence;
// the cycle now genuinely re-arms on it).
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// Slow per-session ops hold off for ten minutes so boot and the first
// turns stay snappy.
const SLOW_OPS_DELAY_MS = 10 * 60 * 1000

// Delay before the FIRST slow-op tick: 5 seconds. Short so the `.last-cleanup`
// freshness check (the "catch-up" gate) can run early in the session rather
// than 10 minutes in. Short print runs exit before it fires (G15).
const STALE_CLEANUP_CATCHUP_DELAY_MS = 5000

// A `.last-cleanup` mtime younger than this (24h) is considered "fresh", letting
// a new session skip the expensive per-session cleanup entirely.
const CLEANUP_SENTINEL_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

/** Seams for the fake-clock proof (granted-time law: proofs count wakeups,
 *  never ride wall-clock windows). Never touched by product code. */
interface HousekeepingSeams {
  now: () => number
  schedule: (fn: () => void, ms: number) => { unref?: () => unknown }
}
let seams: HousekeepingSeams = {
  now: Date.now,
  schedule: (fn, ms) => setTimeout(fn, ms),
}
export function _setHousekeepingSeamsForTesting(next: HousekeepingSeams | null): void {
  seams = next ?? { now: Date.now, schedule: (fn, ms) => setTimeout(fn, ms) }
}

function sentinelPath(): string {
  return join(getMercuryHome(), '.last-cleanup')
}

/**
 * True iff `<configDir>/.last-cleanup` exists and its mtime is younger than
 * CLEANUP_SENTINEL_FRESH_WINDOW_MS (24h). Used by the slow-op loop to decide
 * whether another (overlapping/recent) session already performed the expensive
 * per-session cleanup, so this session can skip it.
 *
 * Any error (missing file, stat failure) is swallowed and reported as "not
 * fresh" (false), which causes the cleanup to run.
 */
export async function isLastCleanupSentinelFresh(): Promise<boolean> {
  try {
    const stat = await fs.stat(sentinelPath())
    return seams.now() - stat.mtimeMs < CLEANUP_SENTINEL_FRESH_WINDOW_MS
  } catch {
    return false
  }
}

// ── the cleanup cycle ────────────────────────────────────────
// One cycle = the legacy cleanup families ONCE + lifecycle-collector passes
// until the manifest cursor wraps. The `.last-cleanup` sentinel advances ONLY
// on a complete, zero-failure cycle (G07); a partial pass keeps its persisted
// cursor and resumes on the next tick (G08); a failed cycle withholds the
// sentinel, logs once, and retries on the 24h cadence.

interface CycleState {
  legacyDone: boolean
  legacyErrors: number
}
let cycle: CycleState = { legacyDone: false, legacyErrors: 0 }

export type CycleStepOutcome = 'continue' | 'cycle-complete' | 'cycle-failed'

/** One bounded cycle step (exported for the collector prover — the timer
 *  wiring below is the only production caller). */
export async function runCleanupCycleStep(opts?: {
  budgetMs?: number
  now?: () => number
}): Promise<CycleStepOutcome> {
  if (!cycle.legacyDone) {
    try {
      const legacy = await cleanupOldMessageFilesInBackground()
      cycle.legacyErrors = legacy.errors
    } catch {
      cycle.legacyErrors = 1
    }
    cycle.legacyDone = true
  }
  const pass = await runLifecyclePass({
    ...(opts?.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  })
  if (!pass.cycleComplete) return 'continue'
  const failures = cycle.legacyErrors + pass.cycleFailures
  return failures === 0 ? 'cycle-complete' : 'cycle-failed'
}

/** Stamp the sentinel — ONLY the complete-success path calls this (G07). */
async function stampSentinel(): Promise<void> {
  await fs.writeFile(sentinelPath(), new Date(seams.now()).toISOString()).catch(() => {})
}

function resetCycle(): void {
  cycle = { legacyDone: false, legacyErrors: 0 }
}

/** Proof seam: reset the in-memory cycle state. */
export function _resetHousekeepingCycleForTesting(): void {
  resetCycle()
}

/**
 * The verb-path opportunity (base row: cleanup rides update/doctor too,
 * so a boot outage can't starve it — the field's `.last-cleanup` froze the
 * moment interactive boots stopped succeeding). Bounded and skipped entirely
 * while the sentinel is fresh; a completed zero-failure cycle stamps it.
 */
export async function runLifecycleVerbOpportunity(
  verb: 'doctor' | 'update',
  opts?: { budgetMs?: number },
): Promise<void> {
  try {
    if (await isLastCleanupSentinelFresh()) return
    const outcome = await runCleanupCycleStep({ budgetMs: opts?.budgetMs ?? 1200 })
    if (outcome === 'cycle-complete') {
      await stampSentinel()
      resetCycle()
      logForDebugging(`[housekeeping] cleanup cycle completed on the ${verb} verb — sentinel advanced`)
    } else if (outcome === 'cycle-failed') {
      resetCycle()
      logForDebugging(`[housekeeping] cleanup cycle on the ${verb} verb finished with failures — sentinel withheld`)
    }
    // 'continue': the persisted cursor resumes on the next opportunity.
  } catch {
    /* a verb must never fail on housekeeping */
  }
}

export function startBackgroundHousekeeping(): void {
  void initMagicDocs()
  void initSkillImprovement()

  initAutoDream()
  // MNEME due-check at boot: the age threshold is reachable
  // WITHOUT a future observation, and a crashed consolidator's stranded rows
  // recover promptly. OFF ⇒ no timer, no reads (gated inside).
  scheduleMnemeMaintenance('boot')

  startCleanupCycleLoop()
}

/** The cleanup-cycle loop alone (exported so the collector prover drives the
 *  timer/sentinel law without the unrelated side inits above). */
export function startCleanupCycleLoop(): void {
  // Only consult the `.last-cleanup` sentinel once per cycle arm.
  let sentinelChecked = false
  let cycleSettled = false

  function armTick(ms: number): void {
    seams.schedule(() => void runVerySlowOps(), ms).unref?.()
  }

  function armNextCycle(): void {
    // The recurring cadence (G09): a long-running session re-opens the cycle
    // after 24h instead of never cleaning again.
    sentinelChecked = false
    cycleSettled = false
    resetCycle()
    armTick(RECURRING_CLEANUP_INTERVAL_MS)
  }

  async function runVerySlowOps(): Promise<void> {
    // Operator activity within the last minute postpones the slow batch — housekeeping must never be felt.
    if (getIsInteractive() && getLastInteractionTime() > seams.now() - 1000 * 60) {
      armTick(SLOW_OPS_DELAY_MS)
      return
    }

    if (cycleSettled) return

    // If another recent session already cleaned up (fresh `.last-cleanup`
    // sentinel), skip this cycle entirely — re-arm on the recurring cadence.
    if (!sentinelChecked) {
      sentinelChecked = true
      if (await isLastCleanupSentinelFresh()) {
        cycleSettled = true
        armNextCycle()
        return
      }
    }

    try {
      const outcome = await runCleanupCycleStep()
      if (outcome === 'continue') {
        // Partial pass — the persisted cursor resumes on the next tick (G08).
        armTick(SLOW_OPS_DELAY_MS)
        return
      }
      cycleSettled = true
      if (outcome === 'cycle-complete') {
        // Stamp the sentinel so overlapping/subsequent sessions skip this stage.
        await stampSentinel()
      } else {
        logForDebugging(
          '[housekeeping] cleanup cycle finished with failures — sentinel withheld; retrying on the recurring cadence',
        )
      }
    } catch {
      cycleSettled = true // never spin a broken cycle on the 10-minute tick
    }
    armNextCycle()
  }

  // First tick fires fast (5s) so the `.last-cleanup` freshness gate can
  // short-circuit early; re-arms inside the loop use the full 10-minute cadence.
  armTick(STALE_CLEANUP_CATCHUP_DELAY_MS)
}
