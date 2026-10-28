import type { ToolUseContext } from '../../Tool.js'
import type { Attachment } from './types.js'
import { extractDiscoveredToolNames } from '../toolSearch.js'

export async function getToolManualAttachments(context: ToolUseContext, selected?: readonly string[]): Promise<Attachment[]> {
  const history = context.messages ?? []
  const boundary = history.findLastIndex(message => message.type === 'system' && message.subtype === 'compact_boundary')
  const messages = boundary < 0 ? history : history.slice(boundary)
  const names = selected === undefined ? extractDiscoveredToolNames(messages) : new Set(selected)
  if (selected === undefined) {
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      for (const block of message.message.content) {
        if (block.type === 'tool_use') names.add(block.name)
      }
    }
  }
  const delivered = new Set(messages.flatMap(message => message.type === 'attachment' && message.attachment.type === 'critical_system_reminder'
    ? [message.attachment.content.split('\n', 1)[0]] : []))
  const attachments: Attachment[] = []
  for (const tool of context.options.tools) {
    const head = `# Tool manual: ${tool.name}`
    if (tool.wireDescription === undefined || !names.has(tool.name) || delivered.has(head)) continue
    const manual = await tool.prompt({
      getToolPermissionContext: async () => context.getAppState().toolPermissionContext,
      tools: context.options.tools,
      agents: context.options.agentDefinitions?.activeAgents ?? [],
      allowedAgentTypes: context.options.agentDefinitions?.allowedAgentTypes,
      model: context.options.engineModel,
    })
    attachments.push({ type: 'critical_system_reminder', content: `${head}\n\n${manual}` })
  }
  return attachments
}
