import type { LocalCommandResult } from '../catalogue/commands.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  context.openRewindPicker?.()
  return { type: 'skip' }
}
