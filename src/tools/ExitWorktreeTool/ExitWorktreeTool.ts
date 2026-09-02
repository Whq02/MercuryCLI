import { z } from 'zod/v4'

import { buildTool } from '../../Tool.js'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearInstructionFileCaches } from '../../services/instructions/engine.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { plural } from '../../utils/stringUtils.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  type WorktreeSession,
} from '../../utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'


const inputSchema = z.strictObject({
  action: z
    .enum(['keep', 'remove'])
    .describe(
      '"keep" leaves the worktree directory and its branch on disk for later; "remove" deletes both.',
    ),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      'Required to be true when removing a worktree that has uncommitted files or unmerged commits; without it the tool refuses and lists them.',
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

async function countWorktreeChanges(
  session: WorktreeSession,
): Promise<{ files: number; commits: number } | null> {
  const status = await execFileNoThrow('git', [
    '-C',
    session.worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) return null
  const files = status.stdout.split('\n').filter(line => line.trim() !== '').length
  const baseline = session.originalHeadCommit
  if (baseline === undefined) return null
  const revList = await execFileNoThrow('git', [
    '-C',
    session.worktreePath,
    'rev-list',
    '--count',
    `${baseline}..HEAD`,
  ])
  if (revList.code !== 0) return null
  const parsed = parseInt(revList.stdout.trim(), 10)
  return { files, commits: Number.isNaN(parsed) ? 0 : parsed }
}

function restoreSessionState(originalCwd: string, projectRootMoved: boolean): void {
  setCwd(originalCwd)
  setOriginalCwd(originalCwd)
  if (projectRootMoved) {
    setProjectRoot(originalCwd)
    updateHooksConfigSnapshot()
  }
  clearSystemPromptSections()
  clearInstructionFileCaches()
  getPlansDirectory.cache?.clear?.()
}

const NO_SESSION_MESSAGE =
  'No active worktree session — this call is a no-op. ExitWorktree only ends a session created by the EnterWorktree tool in the CURRENT session; it will not touch manually-created worktrees or worktrees from a previous session. No filesystem changes were made.'

export const ExitWorktreeTool = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  searchHint: 'end the worktree session and return to the original directory',
  userFacingName: () => 'exiting worktree',
  isDestructive(input?: Partial<Input>): boolean {
    return input?.action === 'remove'
  },
  toAutoClassifierInput(input: Input): string {
    return input.action
  },
  getToolUseSummary(input?: Partial<Input>): string | null {
    return input?.action ?? null
  },
  getActivityDescription(): string {
    return 'Exiting worktree'
  },
  async description(): Promise<string> {
    return 'Ends a worktree session created by the EnterWorktree tool and returns to the original directory.'
  },
  async prompt(): Promise<string> {
    return getExitWorktreeToolPrompt()
  },
  async validateInput(input: Input) {
    const session = getCurrentWorktreeSession()
    if (session === null) {
      return {
        result: false as const,
        message: NO_SESSION_MESSAGE,
        errorCode: 1,
      }
    }
    if (input.action === 'remove' && !input.discard_changes) {
      const counts = await countWorktreeChanges(session)
      if (counts === null) {
        return {
          result: false as const,
          message:
            `Could not verify the state of the worktree at ${session.worktreePath} — refusing to remove it without explicit confirmation. ` +
            `Either re-invoke with discard_changes: true after confirming with the user, or use action: "keep" to preserve it.`,
          errorCode: 3,
        }
      }
      if (counts.files > 0 || counts.commits > 0) {
        const parts: string[] = []
        if (counts.files > 0) {
          parts.push(`${counts.files} uncommitted ${plural(counts.files, 'file')}`)
        }
        if (counts.commits > 0) {
          const branch = session.worktreeBranch
            ? `on branch ${session.worktreeBranch}`
            : 'on the worktree branch'
          parts.push(`${counts.commits} unmerged ${plural(counts.commits, 'commit')} ${branch}`)
        }
        return {
          result: false as const,
          message:
            `The worktree has ${parts.join(' and ')}. Removing it will discard this work permanently. ` +
            `Confirm with the user first, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          errorCode: 2,
        }
      }
    }
    return { result: true as const }
  },
  async call(input: Input) {
    const session = getCurrentWorktreeSession()
    if (session === null) {
      throw new Error(NO_SESSION_MESSAGE)
    }
    const originalCwd = session.originalCwd
    const worktreePath = session.worktreePath
    const worktreeBranch = session.worktreeBranch
    const tmuxSessionName = session.tmuxSessionName
    const projectRootMoved = getOriginalCwd() === getProjectRoot()

    const counts = (await countWorktreeChanges(session)) ?? { files: 0, commits: 0 }

    if (input.action === 'keep') {
      await keepWorktree()
      restoreSessionState(originalCwd, projectRootMoved)
      let message =
        `Exited the worktree. Your work is preserved at ${worktreePath}` +
        (worktreeBranch ? ` on branch ${worktreeBranch}` : '') +
        `. The session is back in ${originalCwd}.`
      if (tmuxSessionName) {
        message += ` The tmux session "${tmuxSessionName}" is still running — reattach with: tmux attach -t ${tmuxSessionName}`
      }
      const data: Output = {
        action: 'keep',
        originalCwd,
        worktreePath,
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        ...(tmuxSessionName !== undefined ? { tmuxSessionName } : {}),
        message,
      }
      return { data }
    }

    if (tmuxSessionName) {
      await execFileNoThrow('tmux', ['kill-session', '-t', tmuxSessionName])
    }
    await cleanupWorktree()
    restoreSessionState(originalCwd, projectRootMoved)
    const discarded: string[] = []
    if (counts.commits > 0) {
      discarded.push(`${counts.commits} ${plural(counts.commits, 'commit')}`)
    }
    if (counts.files > 0) {
      discarded.push(`${counts.files} uncommitted ${plural(counts.files, 'file')}`)
    }
    const message =
      `Exited and removed the worktree at ${worktreePath}` +
      (worktreeBranch ? ` (branch ${worktreeBranch})` : '') +
      (discarded.length > 0 ? `, discarding ${discarded.join(' and ')}` : '') +
      `. The session is back in ${originalCwd}.`
    const data: Output = {
      action: 'remove',
      originalCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      discardedFiles: counts.files,
      discardedCommits: counts.commits,
      message,
    }
    return { data }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: data.message }
  },
  renderToolUseMessage,
  renderToolResultMessage,
})
