import { MERCURY_CONSTITUTION } from '../../system-prompt/mercuryContract.js'
import { loadMemoryPrompt } from '../../../sessions/mneme/mnemeFrontPage.js'
import { hasMnemeHomeOverride } from '../../../sessions/mneme/paths.js'
import type { ContentBlockParam } from '../../message-shapes/wire.js'
import { fetchSystemPromptParts } from '../../system-prompt/systemPromptParts.js'
import { asSystemPrompt, type SystemPrompt } from '../../system-prompt/systemPromptType.js'
import type { ConversationConfig } from '../turn.js'

export function systemPromptComposer(config: ConversationConfig, resolvedModel: string, appStateSnapshot: ReturnType<ConversationConfig['getAppState']>, prompt: string | ContentBlockParam[]) {
  const compose = async (): Promise<{ systemPrompt: SystemPrompt; userContext: Record<string, string>; systemContext: Record<string, string> }> => {
    const parts = await fetchSystemPromptParts({
      tools: config.tools,
      engineModel: resolvedModel,
      mcpClients: config.mcpClients,
      customSystemPrompt: config.customSystemPrompt,
      permissionMode: appStateSnapshot.toolPermissionContext.mode,
      memoryTask: { prompt: typeof prompt === 'string' ? prompt : prompt.filter(block => block.type === 'text').map(block => block.text).join('\n') },
    })
    let memoryMechanicsPrompt: string | null = null
    if (config.customSystemPrompt !== undefined && hasMnemeHomeOverride()) memoryMechanicsPrompt = await loadMemoryPrompt()
    const sections: string[] = config.customSystemPrompt !== undefined ? [MERCURY_CONSTITUTION, config.customSystemPrompt] : [...parts.defaultSystemPrompt]
    if (memoryMechanicsPrompt) sections.push(memoryMechanicsPrompt)
    if (config.appendSystemPrompt) sections.push(config.appendSystemPrompt)
    return { systemPrompt: asSystemPrompt(sections), userContext: parts.userContext, systemContext: parts.systemContext }
  }
  return compose
}
