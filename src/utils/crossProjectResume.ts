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

export function checkCrossProjectResume(
  log: SessionListing,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult {
  if (!showAllProjects) return { isCrossProject: false }
  const projectPath = (log as { projectPath?: string }).projectPath
  if (!projectPath) return { isCrossProject: false }
  if (projectPath === getOriginalCwd()) return { isCrossProject: false }
  try {
    if (!existsSync(projectPath)) return { isCrossProject: false }
  } catch {
    return { isCrossProject: false }
  }
  const target = normalizePathForComparison(projectPath)
  const inRepoWorktree = worktreePaths.some(worktree => {
    const root = normalizePathForComparison(worktree)
    return target === root || target.startsWith(root + sep)
  })
  if (inRepoWorktree) return { isCrossProject: true, isSameRepoWorktree: true, projectPath }

  const sessionId = sessionIdOfListing(log)
  if (!sessionId) return { isCrossProject: false }
  const quotedPath = quote([projectPath])
  const command = `cd ${quotedPath} && ${binaryName()} --resume ${sessionId}`
  return { isCrossProject: true, isSameRepoWorktree: false, projectPath, command }
}
