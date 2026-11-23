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


const inputSchema = z.strictObject({
  action: z.enum(['keep', 'remove']),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      "remove only: true discards uncommitted files and unmerged commits on the user's word; default false requires a clean worktree.",
    ),
})

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

const outputSchema = z.object({
  action: z.enum(['keep', 'remove']),
  originalCwd: z.string(),
  worktreePath: z.string(),
  worktreeBranch: z.string().optional(),
  tmuxSessionName: z.string().optional(),
  discardedFiles: z.number().optional(),
  discardedCommits: z.number().optional(),
  message: z.string(),
})

type WorktreeChangeCounts = {
  uncommittedFiles: number
  unmergedCommits: number
}

async function countWorktreeChanges(session: WorktreeSession): Promise<WorktreeChangeCounts | null> {
  const statusResult = await execFileNoThrow('git', ['-C', session.worktreePath, 'status', '--porcelain'])
  if (statusResult.code !== 0) return null
  if (!session.originalHeadCommit) return null
  const commitsResult = await execFileNoThrow('git', [
    '-C',
    session.worktreePath,
    'rev-list',
    '--count',
    `${session.originalHeadCommit}..HEAD`,
  ])
  if (commitsResult.code !== 0) return null
  const uncommittedFiles = statusResult.stdout
    .split(/\r?\n/)
    .filter(line => line.trim() !== '').length
  const parsedCommits = Number.parseInt(commitsResult.stdout.trim(), 10)
  const unmergedCommits = Number.isFinite(parsedCommits) ? parsedCommits : 0
  return { uncommittedFiles, unmergedCommits }
}

function restoreOriginalDirectory(originalCwd: string, projectRootWasOriginal: boolean): void {
  setCwd(originalCwd)
  setOriginalCwd(originalCwd)
  regroundGitWatch()
  if (projectRootWasOriginal) {
    setProjectRoot(originalCwd)
    refreshHooksSnapshot()
  }
  clearInstructionFileCaches()
}

export const ExitWorktreeTool = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  searchHint: 'end the worktree session and return to the original directory',
  userFacingName: () => 'exiting worktree',
  getActivityDescription: () => 'Exiting worktree',
  isDestructive(input) {
    return input?.action === 'remove'
  },
  getToolUseSummary(input) {
    return input?.action ?? null
  },
  inputSchema,
  outputSchema,
  async description() {
    return 'Ends a worktree session created by the EnterWorktree tool and returns to the original directory.'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async validateInput(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      return { result: false, message: NO_SESSION_MESSAGE, errorCode: 1 }
    }
    if (input.action === 'keep' || input.discard_changes === true) {
      return { result: true }
    }
    const counts = await countWorktreeChanges(session)
    if (counts === null) {
      return {
        result: false,
        message: `Could not verify the state of the worktree at ${session.worktreePath} — refusing to remove it without explicit confirmation. Either re-invoke with discard_changes: true after confirming with the user, or use action: "keep" to preserve it.`,
        errorCode: 3,
      }
    }
    if (counts.uncommittedFiles > 0 || counts.unmergedCommits > 0) {
      const parts: string[] = []
      if (counts.uncommittedFiles > 0) {
        parts.push(`${counts.uncommittedFiles} uncommitted ${plural(counts.uncommittedFiles, 'file')}`)
      }
      if (counts.unmergedCommits > 0) {
        const branchLabel = session.worktreeBranch
          ? `on branch ${session.worktreeBranch}`
          : 'on the worktree branch'
        parts.push(`${counts.unmergedCommits} unmerged ${plural(counts.unmergedCommits, 'commit')} ${branchLabel}`)
      }
      return {
        result: false,
        message: `The worktree has ${parts.join(' and ')}. Removing it will discard this work permanently. Confirm with the user first, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      throw new Error(NO_SESSION_MESSAGE)
    }
    const projectRootWasOriginal = getProjectRoot() === getOriginalCwd()
    if (input.action === 'keep') {
      await keepWorktree()
      restoreOriginalDirectory(session.originalCwd, projectRootWasOriginal)
      let message = `Exited the worktree. Your work is preserved at ${session.worktreePath}${session.worktreeBranch ? ` on branch ${session.worktreeBranch}` : ''}. The session is back in ${session.originalCwd}.`
      if (session.tmuxSessionName) {
        message += ` The tmux session "${session.tmuxSessionName}" is still running — reattach with: tmux attach -t ${session.tmuxSessionName}`
      }
      const data: Output = {
        action: 'keep',
        originalCwd: session.originalCwd,
        worktreePath: session.worktreePath,
        ...(session.worktreeBranch !== undefined ? { worktreeBranch: session.worktreeBranch } : {}),
        ...(session.tmuxSessionName !== undefined ? { tmuxSessionName: session.tmuxSessionName } : {}),
        message,
      }
      return { data }
    }
    const counts = (await countWorktreeChanges(session)) ?? { uncommittedFiles: 0, unmergedCommits: 0 }
    if (session.tmuxSessionName) {
      await execFileNoThrow('tmux', ['kill-session', '-t', session.tmuxSessionName])
    }
    await cleanupWorktree()
    restoreOriginalDirectory(session.originalCwd, projectRootWasOriginal)
    const discardParts: string[] = []
    if (counts.unmergedCommits > 0) {
      discardParts.push(`${counts.unmergedCommits} ${plural(counts.unmergedCommits, 'commit')}`)
    }
    if (counts.uncommittedFiles > 0) {
      discardParts.push(`${counts.uncommittedFiles} uncommitted ${plural(counts.uncommittedFiles, 'file')}`)
    }
    const branchClause = session.worktreeBranch ? ` (branch ${session.worktreeBranch})` : ''
    const discardClause = discardParts.length > 0 ? `, discarding ${discardParts.join(' and ')}` : ''
    const message = `Exited and removed the worktree at ${session.worktreePath}${branchClause}${discardClause}. The session is back in ${session.originalCwd}.`
    const data: Output = {
      action: 'remove',
      originalCwd: session.originalCwd,
      worktreePath: session.worktreePath,
      ...(session.worktreeBranch !== undefined ? { worktreeBranch: session.worktreeBranch } : {}),
      discardedFiles: counts.uncommittedFiles,
      discardedCommits: counts.unmergedCommits,
      message,
    }
    return { data }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
})
