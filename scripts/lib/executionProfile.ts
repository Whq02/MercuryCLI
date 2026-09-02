// ============================================================================
//  scripts/lib/executionProfile.ts — the maintainer-side execution-profile
//  resolver.
//
//  Three environments run Mercury's verification machinery and they are NOT
//  interchangeable:
//    · source-maintainer POSIX — the full Bash pool's home (signals, pgrep,
//      kill-based watchdogs are its lifecycle contract);
//    · source-maintainer WINDOWS — builds and runs the product fine, but the
//      POSIX pool's descendant-settlement contract does not port: starting it
//      leaves orphan children and half-run verdicts (the F2 field defect).
//      The truthful remedy is the hosted gate;
//    · hosted-gate — CI runners (the lanes install their own contract).
//  Packaged-runtime consumers never reach this file (releases carry no
//  scripts/); the arm exists so a mis-staged environment reports itself
//  instead of impersonating a maintainer checkout.
//
//  Resolution uses facts the tree already carries — no ambient guessing. The
//  platform is injectable so POSIX fixtures can prove the Windows arm.
// ============================================================================
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ExecutionProfile =
  | { kind: 'source-maintainer-posix' }
  | { kind: 'source-maintainer-windows' }
  | { kind: 'hosted-gate' }
  | { kind: 'packaged-or-unknown'; detail: string }

export function resolveExecutionProfile(
  root: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ExecutionProfile {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  if (env.GITHUB_ACTIONS === 'true') return { kind: 'hosted-gate' }
  // The pool contract IS the runner. build.ts deliberately stays OUT of the
  // predicate: hermetic synthetic proof estates (the verify suite's e2e
  // fixtures) carry a pool runner and NO build system by design — fast.ts
  // already skips dist work at build-less roots on its own.
  const hasPoolRunner = existsSync(join(root, 'scripts', 'run-all-suites.sh'))
  if (!hasPoolRunner) {
    return {
      kind: 'packaged-or-unknown',
      detail: 'no pool runner at this root (scripts/run-all-suites.sh absent)',
    }
  }
  return platform === 'win32'
    ? { kind: 'source-maintainer-windows' }
    : { kind: 'source-maintainer-posix' }
}

/** Can the FULL Bash pool (or a pooled subset) run to a settled verdict on
 *  this profile? A refusal carries the truthful remedy (L18) and the caller
 *  must spawn NOTHING (L21 — zero descendants on refusal). */
export function fullPoolSupport(profile: ExecutionProfile):
  | { supported: true }
  | { supported: false; reason: string; remedy: string } {
  switch (profile.kind) {
    case 'source-maintainer-posix':
    case 'hosted-gate':
      return { supported: true }
    case 'source-maintainer-windows':
      return {
        supported: false,
        reason:
          'the local suite pool is POSIX maintainer infrastructure (its watchdog/descendant lifecycle — signals, pgrep, process-group kills — has no Windows contract)',
        remedy:
          'run the hosted gate instead: gh workflow run gate.yml --ref <branch> (plus windows-ui.yml / windows-functional.yml for the Windows lanes)',
      }
    case 'packaged-or-unknown':
      return {
        supported: false,
        reason: `not a maintainer checkout — ${profile.detail}`,
        remedy: 'verification pools are source-maintainer machinery; run them from a Mercury source checkout',
      }
  }
}
