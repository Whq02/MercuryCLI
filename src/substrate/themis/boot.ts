/* ============================================================================
   THEMIS boot verify + approve — the session-boot integrity sweep and the
   operator's re-stamp act.

   Boot (arXiv:2606.26924's install/verify contract, Mercury-shaped): while
   the plane is active (MERCURY_THEMIS=warn|enforce), session boot runs
   verifyLockfile + checkDriftBaselines + verifyAllChains, writes audit rows,
   and returns a compact problem list the REPL surfaces as a notification
   (the doctor `themis` check re-probes the same primitives with remedies).
   Level off ⇒ {ran:false} instantly: no reads, no writes, no dir — the
   OFF ⇒ byte-identical contract stays absolute on every passive path.

   Approve = the operator accepting CURRENT content as the new baseline after
   reviewing a reported change: re-stamp the lockfile over the ALREADY
   enrolled key set (falling back to the defaults when the lockfile is
   unreadable — exactly the tampered case approve exists to recover from),
   re-enroll drift baselines, and write an 'approve' audit row. Explicitly
   operator-initiated (CLI verb / doctor remedy with consent); never called
   by any passive path.
   ============================================================================ */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { appendAuditRow, themisDir, verifyAllChains } from './auditChain.js'
import { checkDriftBaselines, driftStorePath, enrollDriftBaselines } from './drift.js'
import {
  DEFAULT_ENROLLED,
  enrollLockfile,
  lockfileExists,
  lockfilePath,
  verifyLockfile,
  type Lockfile,
  type LockVerdict,
} from './integrity.js'
import { themisActive } from './level.js'

/** Prompt-bearing prose the drift (Jaccard) check watches — the injection
 *  surface; exact-content files are the lockfile's job (the pair design). */
export const DEFAULT_DRIFT_ENROLLED = [
  'MERCURY.md',
] as const

export interface ThemisBootReport {
  ran: boolean
  /** Short operator-facing problem strings (empty = clean). */
  problems: string[]
  lock: LockVerdict | null
  driftHigh: number
  driftMedium: number
  chainsBad: number
}

/** The passive session-boot sweep. Never throws; off ⇒ zero work. */
export async function themisBootVerify(cwd: string = process.cwd()): Promise<ThemisBootReport> {
  const report: ThemisBootReport = { ran: false, problems: [], lock: null, driftHigh: 0, driftMedium: 0, chainsBad: 0 }
  if (!themisActive()) return report
  report.ran = true
  try {
    const lockPresent = await lockfileExists(cwd)
    if (lockPresent) {
      const lock = await verifyLockfile(cwd)
      report.lock = lock
      if (!lock.ok) report.problems.push(lock.kind === 'hmac' ? 'lockfile HMAC refused' : lock.detail.slice(0, 120))
      void appendAuditRow({
        actor: 'boot',
        action: 'lockfile-verify',
        details: lock.ok ? `ok (${lock.checked} files)` : `${lock.kind}: ${lock.detail.slice(0, 200)}`,
        cwd,
      })
    }
    const drift = await checkDriftBaselines(cwd)
    if (drift.length > 0) {
      report.driftHigh = drift.filter(d => d.severity === 'high').length
      report.driftMedium = drift.filter(d => d.severity === 'medium').length
      if (report.driftHigh > 0) {
        report.problems.push(`${report.driftHigh} baseline(s) at HIGH drift`)
      }
      void appendAuditRow({
        actor: 'boot',
        action: 'drift-check',
        details: drift.map(d => `${d.path}=${d.jaccard}(${d.severity})`).join(' '),
        cwd,
      })
    }
    // Pairing invariant: `themis lock` writes BOTH stores in one act, so a
    // half-present pair means trust state was REMOVED, not never enrolled —
    // exactly the silent-disable that deleting drift.json (or lock.json)
    // would otherwise buy an attacker: the surviving check keeps passing
    // green while its partner silently stops running.
    const driftPresent = await stat(driftStorePath(cwd)).then(() => true, () => false)
    if (lockPresent && !driftPresent) {
      report.problems.push('drift baselines store missing (lockfile still enrolled — drift.json removed?)')
      void appendAuditRow({ actor: 'boot', action: 'drift-check', details: 'store missing while lockfile enrolled', cwd })
    }
    if (!lockPresent && driftPresent) {
      report.problems.push('lockfile missing (drift baselines still enrolled — lock.json removed?)')
      void appendAuditRow({ actor: 'boot', action: 'lockfile-verify', details: 'lockfile missing while drift store present', cwd })
    }
    const chains = await verifyAllChains(themisDir(cwd))
    report.chainsBad = chains.chains.filter(c => !c.verdict.ok).length
    if (report.chainsBad > 0) {
      report.problems.push(`${report.chainsBad} audit chain(s) tamper-flagged`)
      void appendAuditRow({
        actor: 'boot',
        action: 'chain-verify',
        details: chains.chains
          .filter(c => !c.verdict.ok)
          .map(c => `${basename(c.file)}: ${(c.verdict as { kind?: string }).kind}`)
          .join(' '),
        cwd,
      })
    }
  } catch (e) {
    // The sweep must never break boot; an unreadable substrate is a problem
    // to SURFACE, not a crash.
    report.problems.push(`boot verify errored: ${String(e).slice(0, 80)}`)
  }
  return report
}

/**
 * Re-stamp both baselines at current content (the operator's approval).
 * Returns what was re-enrolled. Caller enforces the level gate (CLI refuses
 * while off so the OFF ⇒ no-files contract stays absolute).
 */
export async function themisApprove(cwd: string = process.cwd()): Promise<{
  lockPaths: string[]
  driftPaths: string[]
}> {
  // Prior ENROLLED key set survives approve — even from a lockfile whose HMAC
  // no longer verifies (that unreadable-stamp case is what approve recovers).
  let lockPaths: string[] = [...DEFAULT_ENROLLED]
  try {
    const prior = JSON.parse(await readFile(lockfilePath(cwd), 'utf8')) as Lockfile
    const keys = Object.keys(prior?.files ?? {})
    if (keys.length > 0) lockPaths = keys
  } catch {
    /* defaults */
  }
  let driftPaths: string[] = [...DEFAULT_DRIFT_ENROLLED]
  try {
    const prior = JSON.parse(await readFile(driftStorePath(cwd), 'utf8')) as { baselines?: Record<string, unknown> }
    const keys = Object.keys(prior?.baselines ?? {})
    if (keys.length > 0) driftPaths = keys
  } catch {
    /* defaults */
  }
  const lock = await enrollLockfile(lockPaths, cwd)
  const drift = await enrollDriftBaselines(driftPaths, cwd)
  void appendAuditRow({
    actor: 'cli',
    action: 'approve',
    details: `re-stamped lockfile (${lock.enrolled.length} files) + drift baselines (${drift.enrolled.length})`,
    cwd,
  })
  return { lockPaths: lock.enrolled, driftPaths: drift.enrolled }
}
