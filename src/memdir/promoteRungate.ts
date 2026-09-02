/* ============================================================================
   promoteRungate — RUN the green-gate at card promote-time (the proposal
   "Verify the green-gate by RUNNING it at promote-time, not trusting a
   self-asserted boolean"; MUSE-Autoskill's unit-test-before-registration,
   reinforced by Meta-Harness's validate→smoke→benchmark staging).

   The gap this closes: a card's `greenGatePassed` is a MODEL-SUPPLIED boolean
   end-to-end — nothing ever executes the gate. The repo HAS the executable
   gate (scripts/run-all-suites.sh, exit 0/non-0). This module lets the
   OPERATOR-INVOKED promote path (scripts/memory/distill-card.ts --promote —
   deliberately NOT the in-loop tool, preserving no-autonomous-self-
   modification) spawn it and refuse the approved:true flip on failure.

   GATING: MERCURY_CARD_PROMOTE_RUNGATE (opt-in, default-OFF ⇒ byte-identical: the
   promote path never spawns anything). MERCURY_CARD_PROMOTE_RUNGATE_CMD overrides
   the command (proofs use a stub; hosts with a slow gate can scope a subset).
   ============================================================================ */

import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'

export function cardPromoteRungateEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_PROMOTE_RUNGATE')
}

/** The executable gate command (operator-overridable; default = the full gate). */
export function promoteRungateCommand(): string {
  const override = flagEnv('MERCURY_CARD_PROMOTE_RUNGATE_CMD')?.trim()
  return override || 'bash scripts/run-all-suites.sh'
}

export interface RungateResult {
  pass: boolean
  exitCode: number | null
  command: string
  durationMs: number
  /** The ceiling fired — pass is false regardless of exit code. */
  timedOut: boolean
}

/**
 * Run the gate synchronously, streams inherited so the operator watches the
 * real suite output. Never throws — a spawn failure is a FAIL (fail-closed:
 * an unrunnable gate must not promote).
 *
 * Timeout honesty (the ETIMEDOUT sibling class): on timeout
 * spawnSync ALWAYS sets error.code ETIMEDOUT, while a SIGTERM-trapping child
 * can exit 0 (run-all-suites.sh carries an EXIT trap; the CMD is
 * operator-overridable) — `status === 0` alone read a timed-out gate as
 * GREEN and promoted on an unverified gate.
 */
export function runPromoteRungate(opts?: {
  cwd?: string
  stdio?: 'inherit' | 'ignore'
  /** Test seam — the gate ceiling. Production default: 15 minutes. */
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
