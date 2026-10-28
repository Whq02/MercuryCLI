import type { Tool, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { installPermission } from '../../extensions/installConsent.js'
import { installOptionalAdapter, optionalAdapterPlan } from './optionalAdapters.js'

export async function provisionDebugAdapter(key: string, tool: Tool, input: Record<string, unknown>, context: ToolUseContext, canUseTool?: CanUseToolFn, assistantMessage?: AssistantMessage): Promise<void> {
  if (context.options?.isNonInteractiveSession !== false || !canUseTool || !assistantMessage) return
  const plan = optionalAdapterPlan(key)
  if (!plan) return
  const signal = context.abortController.signal
  signal.throwIfAborted()
  await installOptionalAdapter(plan, {
    signal,
    authorize: async () => {
      const consentTool: Tool = { ...tool, checkPermissions: async () => installPermission(plan) }
      const result = await canUseTool(consentTool, input, context, assistantMessage, `debug-install-${crypto.randomUUID()}`)
      signal.throwIfAborted()
      return result.behavior === 'allow'
    },
  })
}
