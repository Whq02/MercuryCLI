import { chdir } from 'node:process'
import { z } from 'zod'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearInstructionFileCaches } from '../../services/instructions/engine.js'
import { buildTool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { getCwd } from '../../utils/cwd.js'
import { getPlanSlug } from '../../utils/plans.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from '../../services/worktree.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { regroundGitWatch } from '../../utils/git/gitFilesystem.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import { setCwd } from '../../utils/Shell.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
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
        'Worktree name: letters, digits, dots, underscores and dashes per /-segment, ≤64 chars (omitted auto-names).',
      ),
  })
  .strict()

type Input = z.infer<typeof inputSchema>

export type Output = {
  worktreePath: string
  worktreeBranch?: string
  message: string
}

export const EnterWorktreeTool = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  userFacingName: () => 'Creating worktree',
  shouldDefer: true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: RESULT_SIZE_CAP,
  searchHint: 'switch this session into an isolated git worktree',
  inputSchema,
  async description() {
    return 'Create an isolated worktree and switch the session into it (explicit user request only)'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
  async call(input: Input, context) {
    const existing = getCurrentWorktreeSession()
    if (existing) {
      throw new Error(
        `This session is already working in a worktree it created (${existing.worktreePath}). Leave it with the exit tool first.`,
      )
    }
    const gitRoot = findCanonicalGitRoot(getCwd())
    const slug = input.name ?? getPlanSlug()
    const session = await createWorktreeForSession(getSessionId(), slug, undefined, {
      ...(gitRoot ? { gitRoot } : {}),
      permission: context.getAppState().toolPermissionContext,
    })
    chdir(session.worktreePath)
    setCwd(session.worktreePath)
    setOriginalCwd(session.worktreePath)
    regroundGitWatch()
    void saveWorktreeState(session)
    clearInstructionFileCaches()
    let message = `Created worktree ${session.worktreePath}${session.worktreeBranch ? ` on branch ${session.worktreeBranch}` : ''}.`
    if (session.prepareFailure !== undefined) {
      message += ` ${session.prepareFailure}; the worktree is used anyway.`
    }
    message +=
      ' The session is now working in the worktree. Leave it mid-session with the exit tool, or you will be prompted on session exit.'
    const data: Output = {
      worktreePath: session.worktreePath,
      ...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
      message,
    }
    return { data }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
})
