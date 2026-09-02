// ============================================================================
//  scripts/engine-durability/harness.ts — shared reproducer scaffolding.
//
//  Proof discipline (two standing laws):
//    · a proof must not read the calibration machine — every-relevant env
//      knob is cleared before any src import, so a defect can never be masked
//      or manufactured by the operator's own environment;
//    · a proof must never resolve user-local paths implicitly — bun's
//      homedir() ignores env HOME, and a prover that assumed otherwise once
//      clobbered a deployed launcher. scratchRoot() returns an explicit scratch
//      root and guardWrite() refuses anything outside it.
// ============================================================================

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Env this suite must never inherit from the operator's shell. */
const CLEARED = [
  'MERCURY_FAULT_INJECT',
  'MERCURY_FAULT_INJECT',
  'MERCURY_DURABLE_FSYNC',
  'MERCURY_DURABLE_FSYNC',
  'MERCURY_LANES',
  'MERCURY_LANES',
  'MERCURY_GATE_LEDGER',
] as const

/**
 * Pin a scratch config home and clear the ambient knobs. MUST be called before
 * the first src import. Returns the scratch root (already realpath-resolved so
 * a symlinked /tmp cannot defeat the write guard).
 */
export function scratchRoot(prefix: string): string {
  for (const key of CLEARED) delete process.env[key]
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `keel-${prefix}-`)))
  process.env.MERCURY_CONFIG_DIR = root
  return root
}

/** Refuse any path outside the scratch root before writing to it.
 *  Containment via path.relative — separator-agnostic (a `root + '/'`
 *  prefix check refuses every backslashed win32 path). */
export function guardWrite(root: string, path: string): string {
  const full = resolve(path)
  const rel = relative(root, full)
  const inside = full === root || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
  if (!inside) {
    throw new Error(`durability proof refused a write outside its scratch root: ${full}`)
  }
  return full
}

/**
 * Observed-ready gate: poll `pred` until it holds or the attempt budget runs
 * out. Used only where a real gather has to finish before the measurement can
 * start — the measurement itself is always a count, never a duration, so a
 * slow machine costs attempts and can never change a verdict.
 */
export async function waitUntil(
  pred: () => boolean,
  opts?: { tries?: number; everyMs?: number },
): Promise<boolean> {
  const tries = opts?.tries ?? 600
  const everyMs = opts?.everyMs ?? 5
  for (let i = 0; i < tries; i++) {
    if (pred()) return true
    await new Promise<void>(res => setTimeout(res, everyMs))
  }
  return pred()
}

/**
 * Exit code for "the prover ran and its checks failed" — deliberately NOT 1.
 * scripts/engine-durability/run-all.sh runs two reproducers in expect-red mode, and with a
 * generic non-zero it cannot tell a prover that reproduced its defect from one
 * that died at import or could not find its fixture. A reserved code makes
 * "still reproduces" and "stopped running" different observations.
 */
export const CHECKS_FAILED_EXIT = 3

export interface Checker {
  check(label: string, cond: boolean, detail?: string): void
  section(title: string): void
  failures(): number
  finish(name: string): never
}

export function checker(): Checker {
  let failures = 0
  return {
    check(label, cond, detail = '') {
      if (!cond) failures++
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
    },
    section(title) {
      console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
    },
    failures: () => failures,
    finish(name) {
      console.log(
        `\n${failures === 0 ? '✅' : '❌'} ${name} — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`,
      )
      process.exit(failures === 0 ? 0 : CHECKS_FAILED_EXIT)
    },
  }
}
