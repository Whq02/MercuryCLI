import type { LocalCommandResult } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { notBuilt } from '../../pi/holes.js'

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  return notBuilt('src/commands/rewind/rewind.ts:4')
}
