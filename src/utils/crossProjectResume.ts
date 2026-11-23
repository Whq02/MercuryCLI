import { existsSync } from 'node:fs'
import { sep } from 'node:path'

import { getOriginalCwd } from '../bootstrap/state.js'
import type { SessionListing } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { binaryName } from './config.js'
import { normalizePathForComparison } from './file.js'
import { sessionIdOfListing } from './sessionStorage.js'

type CrossProjectResumeResult =
  | { isCrossProject: false }
  | { isCrossProject: true; isSameRepoWorktree: true; projectPath: string }
  | { isCrossProject: true; isSameRepoWorktree: false; projectPath: string; command: string }

function normalizeDir(dir: string): string {
  const normalized = normalizePathForComparison(dir)
  if (normalized.length > 1 && normalized.endsWith(sep) && !/^[a-zA-Z]:[\\/]$/.test(normalized)) {
    return normalized.slice(0, -1)
  }
  return normalized
}

export function checkCrossProjectResume(
  log: SessionListing,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult {
  if (!showAllProjects || !log.projectPath) {
    return { isCrossProject: false }
  }
  const projectPath = log.projectPath
  const currentCwd = normalizeDir(getOriginalCwd())
  const normalizedProject = normalizeDir(projectPath)
  if (normalizedProject === currentCwd) {
    return { isCrossProject: false }
  }
  const isSameRepoWorktree = worktreePaths.some(worktreePath => {
    const normalizedWorktree = normalizeDir(worktreePath)
    const prefix = normalizedWorktree.endsWith(sep) ? normalizedWorktree : `${normalizedWorktree}${sep}`
    return normalizedProject === normalizedWorktree || normalizedProject.startsWith(prefix)
  })
  if (isSameRepoWorktree) {
    return { isCrossProject: true, isSameRepoWorktree: true, projectPath }
  }
  if (!existsSync(projectPath)) {
    return { isCrossProject: false }
  }
  const sessionId = sessionIdOfListing(log)
  if (!sessionId) {
    return { isCrossProject: false }
  }
  const command = `cd ${quote([projectPath])} && ${binaryName()} --resume ${sessionId}`
  return { isCrossProject: true, isSameRepoWorktree: false, projectPath, command }
}
