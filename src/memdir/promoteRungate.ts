


import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'

export function cardPromoteRungateEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_PROMOTE_RUNGATE')
}

export function promoteRungateCommand(): string {
  const override = flagEnv('MERCURY_CARD_PROMOTE_RUNGATE_CMD')?.trim()
  return override || 'bash scripts/run-all-suites.sh'
}

export interface RungateResult {
  pass: boolean
  exitCode: number | null
  command: string
  durationMs: number
  timedOut: boolean
}

export function runPromoteRungate(opts?: {
  cwd?: string
  stdio?: 'inherit' | 'ignore'
  timeoutMs?: number
}): RungateResult {
  const command = promoteRungateCommand()
  const started = Date.now()
  try {
    const res = spawnSync('bash', ['-c', command], {
      windowsHide: true,
      cwd: opts?.cwd ?? process.cwd(),
      stdio: opts?.stdio ?? 'inherit',
      env: { ...subprocessEnv() },
      timeout: opts?.timeoutMs ?? 15 * 60_000,
    })
    const exitCode = typeof res.status === 'number' ? res.status : null
    const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    return {
      pass: exitCode === 0 && res.error === undefined,
      exitCode,
      command,
      durationMs: Date.now() - started,
      timedOut,
    }
  } catch {
    return { pass: false, exitCode: null, command, durationMs: Date.now() - started, timedOut: false }
  }
}
