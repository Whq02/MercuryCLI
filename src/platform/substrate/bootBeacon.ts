
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../logs/debugLog.js'
import { getMercuryHome } from '../environment/envUtils.js'
import { errorMessage, getErrnoCode } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'

interface BootAttemptResidue {
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
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function clearBootAttempts(home: string = getMercuryHome()): void {
  const p = bootAttemptsPath(home)
  try {
    rmSync(p, { force: true })
  } catch (rmError) {
    try {
      writeFileSync(p, JSON.stringify({ version: 1, attempts: [] }) + '\n')
    } catch (writeError) {
      passedOver(writeError)
      logForDebugging(
        `[boot-beacon] could not clear ${p}: rm=${getErrnoCode(rmError) ?? errorMessage(rmError)} write=${getErrnoCode(writeError) ?? errorMessage(writeError)}`,
        { level: 'warn' },
      )
    }
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
