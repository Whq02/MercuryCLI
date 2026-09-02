import { execFile } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

/**
 * Worktree path listing with no CLI dependency chain — for the SDK and
 * session-listing paths, which need the list but must not drag the CLI's
 * module graph in behind it. Invokes bare `git` with a 5 s timeout; empty on
 * any error or empty output; the same line-filter and NFC normalisation as
 * the CLI variant, but no ordering.
 */
export function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  return new Promise(resolvePaths => {
    try {
      execFile(
        'git',
        ['worktree', 'list', '--porcelain'],
        { windowsHide: true, cwd, timeout: 5000, encoding: 'utf8', env: { ...subprocessEnv() } },
        (error, stdout) => {
          if (error || !stdout || stdout.trim() === '') {
            resolvePaths([])
            return
          }
          resolvePaths(
            stdout
              .split('\n')
              .filter(line => line.startsWith('worktree '))
              .map(line => line.slice('worktree '.length).trim().normalize('NFC')),
          )
        },
      )
    } catch {
      resolvePaths([])
    }
  })
}
