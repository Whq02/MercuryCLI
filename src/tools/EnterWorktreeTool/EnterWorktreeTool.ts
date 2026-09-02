// Create an isolated worktree and switch the session into it.

import { chdir } from 'node:process'
import { z } from 'zod'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearInstructionFileCaches } from '../../services/instructions/engine.js'
import { buildTool } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getCwd } from '../../utils/cwd.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { ENTER_WORKTREE_TOOL_NAME, getEnterWorktreeToolPrompt } from './prompt.js'
import * as UI from './UI.js'

const RESULT_SIZE_CAP = 100_000

const inputSchema = z
  .object({
    name: z
      .string()
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined) return
        try {
          validateWorktreeSlug(value)
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            message: errorMessage(error),
          })
        }
      })
      .describe(
        'Worktree name: letters, digits, dots, underscores, and dashes within each slash-delimited segment; at most 64 characters. Omitted ⇒ a generated name.',
      ),
  })
  .strict()

export type Input = z.infer<typeof inputSchema>

export type Output = {
  worktreePath: string
  worktreeBranch?: string
  message: string
}

export const EnterWorktreeTool = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  inputSchema,
  maxResultSizeChars: RESULT_SIZE_CAP,
  shouldDefer: true,
  searchHint: 'switch this session into an isolated git worktree',
  async description() {
    return 'Create an isolated worktree and switch the session into it (explicit user request only)'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  isConcurrencySafe(): boolean {
    return false
  },
  userFacingName(): string {
    return 'Creating worktree'
  },
  toAutoClassifierInput(input: Input): string {
    return input.name ?? ''
  },
  async call(input: Input) {
    // Refuse when already in a session-created worktree.
    const existing = getCurrentWorktreeSession()
    if (existing) {
      throw new Error(
        `This session is already working in a worktree it created (${existing.worktreePath}). Leave it with the exit tool first.`,
      )
    }

    // Resolve to the canonical repository root and change into it FIRST, so
    // creation works even when invoked from inside another worktree.
    const gitRoot = findCanonicalGitRoot(getCwd())
    if (gitRoot && gitRoot !== getCwd()) {
      chdir(gitRoot)
    }

    const slug = input.name ?? getPlanSlug()
    const session = await createWorktreeForSession(getSessionId(), slug)

    // Switch the session into the worktree.
    chdir(session.worktreePath)
    setOriginalCwd(session.worktreePath)
    void saveWorktreeState(session as never)

    // Invalidate everything that caches the working directory: the cached
    // system-prompt sections (env section recomputes with worktree
    // context), the instruction-file caches, and the plans-directory memo.
    try {
      clearSystemPromptSections()
    } catch (error) {
      logForDebugging(`EnterWorktree: prompt-section clear failed: ${errorMessage(error)}`)
    }
    clearInstructionFileCaches()
    getPlansDirectory.cache.clear()

    const branchNote = session.worktreeBranch
      ? ` on branch ${session.worktreeBranch}`
      : ''
    const message = `Created worktree ${session.worktreePath}${branchNote}. The session is now working in the worktree. Leave it mid-session with the exit tool, or you will be prompted on session exit.`
    return {
      data: {
        worktreePath: session.worktreePath,
        ...(session.worktreeBranch
          ? { worktreeBranch: session.worktreeBranch }
          : {}),
        message,
      } as Output,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
})
