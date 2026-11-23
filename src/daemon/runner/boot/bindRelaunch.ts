import type { ToolUseContext } from '../../../tools/kit/tool.js'
import { buildSideQuestionFallbackParams } from '../../../engine/system-prompt/systemPromptParts.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../../platform/files/fileStateCache.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'relaunchContext'> {
  const { agents, commands, getAppState, messages, options, peer, setAppState, tools } = ports
  const relaunchContext = async (): Promise<ToolUseContext> => {
    const { toolUseContext } = await buildSideQuestionFallbackParams({
      tools,
      commands,
      mcpClients: [...getAppState().mcp.clients],
      messages,
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      getAppState,
      setAppState,
      customSystemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      agents,
    })
    return {
      ...toolUseContext,
      options: {
        ...toolUseContext.options,
        ...(peer !== null ? { hostHoldsAsks: true } : {}),
      },
    }
  }
  return { relaunchContext }
}

export const bindRelaunch: BootStep<'relaunchContext'> = { name: 'bindRelaunch', makes: ['relaunchContext'], run }
