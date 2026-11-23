import { execFile } from 'child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { useLoad } from './effects.js'
import { useFocusedWorkspaceCwd } from './useFocusedWorkspaceCwd.js'
import { gitArgs } from '../utils/git/spawnArgs.js'
import { passedOver } from '../utils/passedOver.js'

type WorkspaceBranchV1 = { cwd: string; folder: string; branch: string | null }

export function workspaceFolderOf(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

function readBranchSync(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m && m[1] ? m[1] : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function useFocusedWorkspaceBranch(): WorkspaceBranchV1 {
  const cwd = useFocusedWorkspaceCwd()
  const [branch, setBranch] = useState<string | null>(() => readBranchSync(cwd))
  useLoad(signal => {
    setBranch(readBranchSync(cwd))
    execFile('git', gitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), { windowsHide: true, cwd, timeout: 500 }, (err, stdout) => {
      if (signal.aborted || err) return
      const b = stdout.trim()
      if (b && b !== 'HEAD') setBranch(b)
    })
  }, [cwd])
  return { cwd, folder: workspaceFolderOf(cwd), branch }
}
