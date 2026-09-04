
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
import { getMercuryHome } from './envUtils.js'
import { sanitizePath } from './sessionStoragePortable.js'
import { getRipgrepStatus } from './ripgrep.js'
import { gitSnapshot } from './cockpit/gitSnapshot.js'

export function lastPreflightPath(): string {
  return join(getMercuryHome(), 'doctor', sanitizePath(healthStateRoot()), 'last-preflight.json')
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

export async function runPreflight(): Promise<PreflightSummary> {
  const t0 = Date.now()
  const checks = await Promise.all([
    wrapped('wrapper', () => {
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
    verdict: verdictFromStatuses(checks.map(c => c.status)),
    ranAt: new Date().toISOString(),
    failing: checks
      .filter(c => c.status === 'fail')
      .map(c => ({ id: c.id, evidence: c.evidence })),
    degraded: checks
      .filter(c => c.status === 'warn' || c.status === 'stale' || c.status === 'unknown')
      .map(c => ({ id: c.id, status: c.status, evidence: c.evidence })),
    durationMs: Date.now() - t0,
    via: 'preflight',
  }
}

let bootPreflight: Promise<PreflightSummary> | null = null

export function _resetBootPreflightForTesting(): void {
  bootPreflight = null
}

export async function runAndRecordPreflight(): Promise<PreflightSummary> {
  if (bootPreflight !== null) return bootPreflight
  bootPreflight = (async () => {
    const summary = await runPreflight()
    try {
      await publishAtomic(lastPreflightPath(), JSON.stringify({ _v: 1, ...summary }))
    } catch {
    }
    return summary
  })()
  return bootPreflight
}
