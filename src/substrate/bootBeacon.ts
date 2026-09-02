
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

export function clearBootAttempts(home: string = getMercuryHome()): void {
  try {
    rmSync(bootAttemptsPath(home), { force: true })
  } catch {
  }
}

export function formatBootResidueWarning(residue: BootAttemptResidue): string {
  const when = new Date(residue.lastTs).toISOString()
  return (
    `${residue.count} interactive boot attempt(s) reached the enter screen but no session completed startup ` +
    `(last ${when}). If \`mercury\` seems stuck on the launch screen, the installed version may be unbootable — ` +
    '`mercury update --rollback` returns to the previous version; `MERCURY_SPLASH=off mercury` boots without the enter screen.'
  )
}
