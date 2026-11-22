import { randomUUID } from 'node:crypto'

import { canAnswerAsks, getSessionId } from '../../bootstrap/state.js'
import { guardKeysOf, judgeToolCall } from '../../guards/guards.js'
import type { ToolUseContext } from '../../Tool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { logForDebugging } from '../../utils/debug.js'
import { MalformedCommandError, ShellError } from '../../utils/errors.js'
import { errorMessage } from '../../utils/errors.js'
import type { FrontmatterShell } from '../../utils/frontmatterParser.js'
import { createAssistantMessage } from '../messages.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { processToolResultBlock } from '../../utils/toolResultStorage.js'
import { notBuilt } from '../../pi/holes.js'

export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  slashCommandName: string,
  shell?: FrontmatterShell,
): Promise<string> {
  return notBuilt('src/services/tools/promptShellExecution.ts:95')
}
