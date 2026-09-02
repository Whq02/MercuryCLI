import { existsSync } from 'node:fs'

import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { binaryName } from './config.js'
import { getSessionIdFromLog } from './sessionStorage.js'

export type CrossProjectResumeResult =
  | { isCrossProject: false }
  | { isCrossProject: true; isSameRepoWorktree: true; projectPath: string }
  | { isCrossProject: true; isSameRepoWorktree: false; projectPath: string; command: string }

export function checkCrossProjectResume(
  log: LogOption,
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

  const sessionId = getSessionIdFromLog(log)
  if (!sessionId) return { isCrossProject: false }
  const quotedPath = quote([projectPath])
  const command = `cd ${quotedPath} && ${binaryName()} --resume ${sessionId}`
  return { isCrossProject: true, isSameRepoWorktree: false, projectPath, command }
}
