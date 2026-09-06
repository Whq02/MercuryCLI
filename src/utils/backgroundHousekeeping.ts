import * as fs from 'fs/promises'
import { join } from 'path'
import { scheduleMnemeMaintenance } from '../memdir/mnemeMaintenance.js'
import { initMemoryUpkeep } from '../services/memoryUpkeep/memoryUpkeep.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { getMercuryHome } from './envUtils.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

const registerProtocolModule: typeof import('./deepLink/registerProtocol.js') | null = null

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import { runLifecyclePass } from '../substrate/stateLifecycle.js'
import { cleanupOldMessageFilesInBackground } from './cleanup.js'
import { logForDebugging } from './debug.js'

const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const SLOW_OPS_DELAY_MS = 10 * 60 * 1000

const STALE_CLEANUP_CATCHUP_DELAY_MS = 5000

const CLEANUP_SENTINEL_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

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

export async function isLastCleanupSentinelFresh(): Promise<boolean> {
  try {
    const stat = await fs.stat(sentinelPath())
    return seams.now() - stat.mtimeMs < CLEANUP_SENTINEL_FRESH_WINDOW_MS
  } catch {
    return false
  }
}


interface CycleState {
  legacyDone: boolean
  legacyErrors: number
}
let cycle: CycleState = { legacyDone: false, legacyErrors: 0 }

export type CycleStepOutcome = 'continue' | 'cycle-complete' | 'cycle-failed'

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

async function stampSentinel(): Promise<void> {
  await fs.writeFile(sentinelPath(), new Date(seams.now()).toISOString()).catch(() => {})
}

function resetCycle(): void {
  cycle = { legacyDone: false, legacyErrors: 0 }
}

export function _resetHousekeepingCycleForTesting(): void {
  resetCycle()
}

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
  } catch {
  }
}

export function startBackgroundHousekeeping(): void {
  void initMagicDocs()
  void initSkillImprovement()

  initMemoryUpkeep()
  scheduleMnemeMaintenance('boot')

  startCleanupCycleLoop()
}

export function startCleanupCycleLoop(): void {
  let sentinelChecked = false
  let cycleSettled = false

  function armTick(ms: number): void {
    seams.schedule(() => void runVerySlowOps(), ms).unref?.()
  }

  function armNextCycle(): void {
    sentinelChecked = false
    cycleSettled = false
    resetCycle()
    armTick(RECURRING_CLEANUP_INTERVAL_MS)
  }

  async function runVerySlowOps(): Promise<void> {
    if (getIsInteractive() && getLastInteractionTime() > seams.now() - 1000 * 60) {
      armTick(SLOW_OPS_DELAY_MS)
      return
    }

    if (cycleSettled) return

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
        armTick(SLOW_OPS_DELAY_MS)
        return
      }
      cycleSettled = true
      if (outcome === 'cycle-complete') {
        await stampSentinel()
      } else {
        logForDebugging(
          '[housekeeping] cleanup cycle finished with failures — sentinel withheld; retrying on the recurring cadence',
        )
      }
    } catch {
      cycleSettled = true
    }
    armNextCycle()
  }

  armTick(STALE_CLEANUP_CATCHUP_DELAY_MS)
}
