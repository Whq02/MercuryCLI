// ============================================================================
//  healthPreflight — the BOOT health probe.
//
//  A cheap subset of the /health certificate that runs fire-and-forget after
//  the interactive REPL mounts, so a FAULT (wrapper drift, red gate, missing
//  ripgrep, unstatable entry bundle) is PUSHED to the operator instead of
//  waiting to be asked. Honesty doctrine (docs/HEALTH-CERTIFICATE.md):
//    · a preflight is NOT a certificate — it NEVER writes last-cert.json and
//      never refreshes the certificate's age; it persists its own artifact
//      (<state-root>/doctor/last-preflight.json) which composeChip() may only
//      use to DOWNGRADE/annotate the chip;
//    · every check is independently wrapped — a thrown probe degrades to one
//      `unknown` row (caution), never a fabricated state, never a sunk probe.
//
//  Gate: mercuryBootPreflightEnabled() — default-ON, MERCURY_BOOT_PREFLIGHT=0
//  opts out (no run, no file, no notification ⇒ byte-identical). Registered in
//  src/substrate/flagRegistry.ts (prove-flag-registry enforces).
// ============================================================================

import {
  adoptiveProjectLocalPath,
  projectLocalEstateExists,
} from '../services/projectLocal/paths.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  MERCURY_DOCTRINE,
  mercuryDoctrineEnabled,
} from '../prompt/mercuryContract.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { getCwd } from './cwd.js'
import {
  decodeGateVerdict,
  interpretGateVerdict,
  verdictFromStatuses,
  type HealthStatus,
  type PreflightSummary,
} from './healthCertCore.js'
import { computeWorkingTreeSha, gateVerdictPath, healthStateRoot } from './healthReport.js'
import { getRipgrepStatus } from './ripgrep.js'
import { gitSnapshot } from './cockpit/gitSnapshot.js'

/** The preflight artifact — sibling of last-cert.json, never the same file. */
export function lastPreflightPath(): string {
  // The on-disk doctor/ dir is a stable artifact path older installs carry;
  // resolved through the project-local path owner.
  return join(adoptiveProjectLocalPath(healthStateRoot(), 'doctor'), 'last-preflight.json')
}

export function mercuryBootPreflightEnabled(): boolean {
  
  return flagEnv('MERCURY_BOOT_PREFLIGHT') !== '0'
}

type PreflightCheck = { id: string; status: HealthStatus; evidence: string }

async function wrapped(
  id: string,
  run: () => Promise<PreflightCheck> | PreflightCheck,
): Promise<PreflightCheck> {
  try {
    return await run()
  } catch (e) {
    return { id, status: 'unknown', evidence: `probe threw: ${String(e).slice(0, 120)}` }
  }
}

/**
 * The cheap subset (no suites, no network; one bounded git probe via the
 * cached gitSnapshot): wrapper digest · gate verdict vs HEAD · ripgrep ·
 * entry bundle. Returns the summary WITHOUT persisting (runAndRecordPreflight
 * persists) so proofs can table-test it.
 */
export async function runPreflight(): Promise<PreflightSummary> {
  const t0 = Date.now()
  const checks = await Promise.all([
    wrapped('wrapper', () => {
      // the behavioural contract is repository-owned source
      // (src/prompt/mercuryContract.ts) — there is no external compiled text
      // or freshness digest to drift. The check reports the layer's state.
      if (!mercuryDoctrineEnabled()) {
        return {
          id: 'wrapper',
          status: 'off' as const,
          evidence: 'MERCURY_WRAPPER_APPEND=0 — doctrine deliberately dropped (floor still ships)',
        }
      }
      return {
        id: 'wrapper',
        status: 'ok' as const,
        evidence: `Mercury doctrine on — repo-owned source, ${MERCURY_DOCTRINE.length} chars`,
      }
    }),
    wrapped('gate', async () => {
      let raw: unknown = null
      try {
        raw = JSON.parse(await readFile(gateVerdictPath(), 'utf8'))
      } catch {
        raw = null
      }
      const git = await gitSnapshot()
      const repo = git.state === 'live' ? git.data.git : null
      // Content binding: a verdict whose gated tree IS this tree reads fresh
      // even though the commit landed after the run (the chronic
      // stale-after-commit chip — the class this preflight kept re-raising).
      const treeSha = await computeWorkingTreeSha(getCwd())
      const head = repo
        ? { sha: repo.commitHash, dirty: !repo.isClean, treeSha }
        : { sha: null, dirty: null, treeSha }
      const res = interpretGateVerdict(decodeGateVerdict(raw), head, Date.now())
      return { id: 'gate', status: res.status, evidence: res.evidence }
    }),
    wrapped('ripgrep', () => {
      const rg = getRipgrepStatus()
      const present = existsSync(rg.path)
      return present && rg.working !== false
        ? { id: 'ripgrep', status: 'ok' as const, evidence: `ripgrep ${rg.mode} @ ${basename(rg.path)}` }
        : {
            id: 'ripgrep',
            status: 'fail' as const,
            evidence: `ripgrep ${present ? 'probe FAILED' : 'MISSING'} @ ${rg.path} — search tools will ENOENT; rebuild`,
          }
    }),
    wrapped('entry', () => {
      const entry = process.argv[1]
      return entry && existsSync(entry)
        ? { id: 'entry', status: 'ok' as const, evidence: `entry bundle statable (${basename(entry)})` }
        : {
            id: 'entry',
            status: 'unknown' as const,
            evidence: `entry bundle not statable (argv[1]=${entry ?? 'unset'})`,
          }
    }),
  ])

  return {
    // NOTE: the preflight verdict deliberately reuses the certificate roll-up
    // (fail ⇒ fault; warn/stale/unknown ⇒ caution) over the SUBSET only.
    verdict: verdictFromStatuses(checks.map(c => c.status)),
    ranAt: new Date().toISOString(),
    failing: checks
      .filter(c => c.status === 'fail')
      .map(c => ({ id: c.id, evidence: c.evidence })),
    // Persist the caution-DRIVING rows too — a `caution` verdict
    // with an empty `failing` array named nothing (the audited artifact).
    degraded: checks
      .filter(c => c.status === 'warn' || c.status === 'stale' || c.status === 'unknown')
      .map(c => ({ id: c.id, status: c.status, evidence: c.evidence })),
    durationMs: Date.now() - t0,
    via: 'preflight',
  }
}

/** Run + persist the preflight artifact (atomic tmp+rename; best-effort).
 *  The persist rides the path owner's bare-boot law: a boot-time writer may
 *  refresh an ESTABLISHED `.mercury/` estate but must never be its creator —
 *  on a virgin project the summary still drives the boot notice and nothing
 *  lands on disk. */
// ONE preflight per boot: the REPL mounts beneath the Boot face and again
// when the first chat is born, and a second run at the birth landed
// doctor/last-preflight.json inside the estate the birth had just created
// empty (the folder-as-project law: the first chat creates exactly
// `.mercury/`). Later mounts reuse the boot's own summary.
let bootPreflight: Promise<PreflightSummary> | null = null

/** Proof seam: forget this boot's preflight so a prover can play a second
 *  boot in one process (the once-per-boot law is otherwise the point). */
export function _resetBootPreflightForTesting(): void {
  bootPreflight = null
}

export async function runAndRecordPreflight(): Promise<PreflightSummary> {
  if (bootPreflight !== null) return bootPreflight
  bootPreflight = (async () => {
    const summary = await runPreflight()
    if (projectLocalEstateExists(healthStateRoot())) {
      try {
        await publishAtomic(lastPreflightPath(), JSON.stringify({ _v: 1, ...summary }))
      } catch {
        // best-effort artifact — the returned summary still drives the boot notice
      }
    }
    return summary
  })()
  return bootPreflight
}
