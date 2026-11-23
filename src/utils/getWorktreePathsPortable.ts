import { execFile } from 'node:child_process'

import { gitExe } from './git/gitExe.js'
import { gitArgsAsync } from './git/spawnArgs.js'
import { passedOver } from './passedOver.js'
import { subprocessEnv } from './subprocessEnv.js'

const WORKTREE_LIST_TIMEOUT_MS = 5_000

export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  let argv: string[]
  try {
    argv = await gitArgsAsync(['worktree', 'list', '--porcelain'], cwd)
  } catch (error) {
    passedOver(error)
    return []
  }

  return new Promise(resolve => {
    try {
      execFile(
        gitExe(),
        argv,
        {
          cwd,
          encoding: 'utf8',
          env: subprocessEnv(),
          timeout: WORKTREE_LIST_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error || !stdout) {
            resolve([])
            return
          }
          const paths: string[] = []
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.startsWith('worktree ')) continue
            const path = line.slice('worktree '.length).trim().normalize('NFC')
            if (path) paths.push(path)
          }
          resolve(paths)
        },
      )
    } catch (error) {
      passedOver(error)
      resolve([])
    }
  })
}
