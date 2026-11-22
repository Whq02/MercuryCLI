import { z } from 'zod/v4'

import { buildTool } from '../../Tool.js'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearInstructionFileCaches } from '../../services/instructions/engine.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { regroundGitWatch } from '../../utils/git/gitFilesystem.js'
import { refreshHooksSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { setCwd } from '../../utils/Shell.js'
import { plural } from '../../utils/stringUtils.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  type WorktreeSession,
} from '../../services/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const inputSchema: Unbuilt = unbuilt('src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:27')

type Input = z.infer<typeof inputSchema>

export type Output = {
  action: 'keep' | 'remove'
  originalCwd: string
  worktreePath: string
  worktreeBranch?: string
  tmuxSessionName?: string
  discardedFiles?: number
  discardedCommits?: number
  message: string
}

const NO_SESSION_MESSAGE =
  'No active worktree session — this call is a no-op. ExitWorktree only ends a session created by the EnterWorktree tool in the CURRENT session; it will not touch manually-created worktrees or worktrees from a previous session. No filesystem changes were made.'

export const ExitWorktreeTool: Unbuilt = unbuilt('src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:101')
