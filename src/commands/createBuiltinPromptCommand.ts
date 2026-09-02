import type { Command } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { ContentBlockParam } from '../types/wire.js'

export function createBuiltinPromptCommand(options: {
  name: string
  description: string
  progressMessage: string
  buildPrompt: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}): Command {
  const { name, description, progressMessage, buildPrompt: fallbackPrompt } = options
  return {
    type: 'prompt',
    name,
    description,
    progressMessage,
    get contentLength(): number {
      return 0
    },
    source: 'builtin',
    userFacingName() {
      return name
    },
    async getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]> {
      return fallbackPrompt(args, context)
    },
  } satisfies Command
}
