import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { type GitMark, parseGitMarks } from './fileTree.js'

export type FileTreeGit = { branch: string; marks: Map<string, GitMark> }

function realRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

export async function readFileTreeGit(root: string): Promise<FileTreeGit | null> {
  const top = await execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--show-toplevel'], { cwd: root, preserveOutputOnError: false })
  if (top.code !== 0) return null
  const topDir = top.stdout.trim()
  if (topDir === '') return null
  const [branch, status] = await Promise.all([
    execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, preserveOutputOnError: false }),
    execFileNoThrowWithCwd(
      gitExe(),
      ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all', '--', '.'],
      { cwd: root, preserveOutputOnError: false },
    ),
  ])
  const base = realRoot(root)
  const rebase = (repoPath: string): string | null => {
    const rel = relative(base, resolve(topDir, repoPath))
    if (rel === '' || rel.startsWith('..')) return null
    return rel.split(sep).join('/')
  }
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : '',
    marks: status.code === 0 ? parseGitMarks(status.stdout, rebase) : new Map<string, GitMark>(),
  }
}
