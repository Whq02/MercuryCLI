// ============================================================================
//  substrate/bootBeacon — the boot-completion beacon.
//
//  The 1.5.4 Windows launcher defect was silent BY CONSTRUCTION: the batch
//  aborted with a visible exit 0, node never started, and no product surface
//  recorded that an interactive boot was ever attempted — the operator's only
//  signal was a stranded splash frame. The beacon closes that class:
//    · the SPLASH stamps every interactive handoff into
//      <config-home>/boot-attempts.json (the attempt half — it runs BEFORE
//      the runtime, so it survives any launcher/runtime death; the writer is
//      stampBootAttempt() in assets/splash/mercury-splash.mjs, shape-pinned
//      by the splash-receipt prover);
//    · the RUNTIME clears the file at interactive startup — beside the same
//      numStartups increment the field audit used as its liveness oracle;
//    · residue (attempts with no completed startup after them) is surfaced
//      by `mercury doctor` and the `update` verb, naming
//      `mercury update --rollback` — the recovery that saved the field boxes.
//  ≥3 residue attempts is the brick signature (both consumers gate at ≥3;
//  fewer tolerates a killed-mid-onboarding boot or an attempt still in
//  flight). Reads are validated + fail-soft: the beacon is a lever, never a
//  boot dependency.
// ============================================================================

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'

export interface BootAttemptResidue {
  count: number
  lastTs: number
}

export function bootAttemptsPath(home: string = getMercuryHome()): string {
  return join(home, 'boot-attempts.json')
}

/** Validated read of the splash's attempt stamps; null = no residue. */
export function readBootAttemptResidue(
  home: string = getMercuryHome(),
): BootAttemptResidue | null {
  try {
    const p = bootAttemptsPath(home)
    if (!existsSync(p)) return null
    const o = JSON.parse(readFileSync(p, 'utf8')) as {
      version?: unknown
      attempts?: unknown
    }
    if (o?.version !== 1 || !Array.isArray(o.attempts)) return null
    const ts = o.attempts.filter((t): t is number => typeof t === 'number')
    if (ts.length === 0) return null
    return { count: ts.length, lastTs: Math.max(...ts) }
  } catch {
    return null
  }
}

/** Interactive startup completed — the attempt residue is answered. */
export function clearBootAttempts(home: string = getMercuryHome()): void {
  try {
    rmSync(bootAttemptsPath(home), { force: true })
  } catch {
    /* fail-soft — the beacon never blocks a boot */
  }
}

/** The one shared phrasing for doctor + the update verb. */
export function formatBootResidueWarning(residue: BootAttemptResidue): string {
  const when = new Date(residue.lastTs).toISOString()
  return (
    `${residue.count} interactive boot attempt(s) reached the enter screen but no session completed startup ` +
    `(last ${when}). If \`mercury\` seems stuck on the launch screen, the installed version may be unbootable — ` +
    '`mercury update --rollback` returns to the previous version; `MERCURY_SPLASH=off mercury` boots without the enter screen.'
  )
}
