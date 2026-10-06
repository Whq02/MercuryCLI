import { execFile } from 'child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useEffect, useState } from 'react'
import { useFocusedWorkspaceCwd } from './useFocusedWorkspaceCwd.js'

export type WorkspaceBranchV1 = { cwd: string; folder: string; branch: string | null }

export function workspaceFolderOf(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

export function readBranchSync(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

export function useFocusedWorkspaceBranch(): WorkspaceBranchV1 {
  const cwd = useFocusedWorkspaceCwd()
  const [branch, setBranch] = useState<string | null>(() => readBranchSync(cwd))
  useEffect(() => {
    let alive = true
    setBranch(readBranchSync(cwd))
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, cwd, timeout: 500 }, (err, stdout) => {
      if (!alive || err) return
      const b = stdout.trim()
      if (b && b !== 'HEAD') setBranch(b)
    })
    return () => {
      alive = false
    }
  }, [cwd])
  return { cwd, folder: workspaceFolderOf(cwd), branch }
}
