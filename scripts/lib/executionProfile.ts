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
