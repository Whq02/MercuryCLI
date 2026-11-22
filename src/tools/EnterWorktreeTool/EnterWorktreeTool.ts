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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export const EnterWorktreeTool: Unbuilt = unbuilt('src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:55')
