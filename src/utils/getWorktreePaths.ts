import { sep } from 'node:path'

import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * Worktree path listing via the CLI git resolver: the worktree containing
 * the requested directory first (exact or directory-prefix match), then the
 * rest by locale comparison. Empty on a non-zero exit.
 */
export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const result = await execFileNoThrowWithCwd(gitExe(), ['worktree', 'list', '--porcelain'], { cwd })
  if (result.code !== 0) return []
  const paths = result.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim().normalize('NFC'))
  // The directory-prefix test appends the PLATFORM separator.
  const current = paths.find(path => cwd === path || cwd.startsWith(path.endsWith(sep) ? path : `${path}${sep}`))
  const rest = paths.filter(path => path !== current).sort((a, b) => a.localeCompare(b))
  return current ? [current, ...rest] : rest
}
