import { sep } from 'node:path'

import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git/gitExe.js'

function stripTrailingSeparators(filePath: string): string {
  const stripped = filePath.replace(/[\\/]+$/, '')
  return stripped === '' ? filePath : stripped
}

function rootContainsCwd(root: string, cleanCwd: string): boolean {
  const cleanRoot = stripTrailingSeparators(root)
  if (cleanCwd === cleanRoot) return true
  if (cleanRoot.endsWith('/') || cleanRoot.endsWith('\\')) {
    return cleanCwd.startsWith(cleanRoot)
  }
  return cleanCwd.startsWith(cleanRoot + sep) || cleanCwd.startsWith(cleanRoot + '/') || cleanCwd.startsWith(cleanRoot + '\\')
}

export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const result = await execFileNoThrowWithCwd(gitExe(), ['worktree', 'list', '--porcelain'], {
    cwd,
    preserveOutputOnError: false,
  })
  if (result.code !== 0 || !result.stdout) return []

  const paths: string[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue
    const path = line.slice('worktree '.length).trim().normalize('NFC')
    if (path) paths.push(path)
  }
  if (paths.length === 0) return []

  const cleanCwd = stripTrailingSeparators(cwd.normalize('NFC'))
  const currentIndex = paths.findIndex(root => rootContainsCwd(root, cleanCwd))
  if (currentIndex === -1) {
    return paths.sort((a, b) => a.localeCompare(b))
  }
  const current = paths[currentIndex]!
  const others = paths.filter((_, index) => index !== currentIndex).sort((a, b) => a.localeCompare(b))
  return [current, ...others]
}
