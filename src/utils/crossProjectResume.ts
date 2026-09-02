import { existsSync } from 'node:fs'

import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { binaryName } from './config.js'
import { getSessionIdFromLog } from './sessionStorage.js'

/**
 * Classify whether a resumable session belongs to another project directory
 * and build the command to reach it.
 *
 * Dead arm reproduced as built: the worktree-detection branch folded into an
 * unconditional early return, so every cross-project result is the command
 * form and the worktree-path parameter is accepted and ignored. The union
 * member survives only in the type.
 */
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
  // A DELETED project directory (a removed worktree is daily reality) must
  // not produce a cd-into-a-dead-path instruction: the transcript lives in
  // the config home, so the session resumes right here instead.
  try {
    if (!existsSync(projectPath)) return { isCrossProject: false }
  } catch {
    return { isCrossProject: false }
  }

  // The shared log helper: the direct field when present, else the first
  // message's session id. With neither, the log is not cross-project-
  // resumable via command — never emit a command with an empty id.
  const sessionId = getSessionIdFromLog(log)
  if (!sessionId) return { isCrossProject: false }
  // The shared quote helper never falls back to an unquoted path.
  const quotedPath = quote([projectPath])
  // The operator copies and runs this; --resume is the CLI's own flag, and
  // the CLI name comes from the shared invocation-name helper so a renamed
  // or forked launcher is reflected.
  const command = `cd ${quotedPath} && ${binaryName()} --resume ${sessionId}`
  return { isCrossProject: true, isSameRepoWorktree: false, projectPath, command }
}
