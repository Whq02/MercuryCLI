import { execFile } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

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
