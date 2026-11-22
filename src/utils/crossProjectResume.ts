import { existsSync } from 'node:fs'
import { sep } from 'node:path'

import { getOriginalCwd } from '../bootstrap/state.js'
import type { SessionListing } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { binaryName } from './config.js'
import { normalizePathForComparison } from './file.js'
import { sessionIdOfListing } from './sessionStorage.js'
import { notBuilt } from '../pi/holes.js'

type CrossProjectResumeResult =
  | { isCrossProject: false }
  | { isCrossProject: true; isSameRepoWorktree: true; projectPath: string }
  | { isCrossProject: true; isSameRepoWorktree: false; projectPath: string; command: string }

export function checkCrossProjectResume(
  log: SessionListing,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult {
  return notBuilt('src/utils/crossProjectResume.ts:16')
}
