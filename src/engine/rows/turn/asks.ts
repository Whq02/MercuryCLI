import type { ToolUseContext } from '../../../tools/kit/tool.js'
import { askNobodyAnswered } from '../../run/unansweredAsk.js'
import type { AssistantMessage } from '../../message-shapes/message.js'
import type { PermissionDecision } from '../../../permissions/rules/permissions.js'
import type { ConversationConfig } from '../turn.js'
import type { Denial } from '../vocabulary.js'

type CanUseTool = ConversationConfig['canUseTool']

export function canUseToolKeepingDenials(config: ConversationConfig, denials: Denial[], unansweredAsks: Set<string>): CanUseTool {
  const wrappedCanUseTool: CanUseTool = (async (
    tool: { name: string },
    input: Record<string, unknown>,
    toolUseContext: ToolUseContext,
    assistantMessage: AssistantMessage,
    toolUseID: string,
    forceDecision?: unknown,
  ) => {
    const decision = await (config.canUseTool as (...args: unknown[]) => Promise<PermissionDecision>)(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision)
    if (decision?.behavior !== 'allow') {
      denials.push({ tool: tool.name, call_id: toolUseID, input })
      if (askNobodyAnswered(decision)) unansweredAsks.add(toolUseID)
    }
    return decision
  }) as CanUseTool
  return wrappedCanUseTool
}
