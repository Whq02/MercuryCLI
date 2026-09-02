import { toolMatchesName, type Tool, type ToolPermissionContext, type Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { formatDeferredToolLine, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolReferenceBlock,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { deferralWireFormFor, type DeferralWireForm, type DeferralWireVerdict } from './deferralWire.js'

export interface ToolPayloadPlanInput {
  model: string
  tools: Tools
  messages: readonly Message[]
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  hasPendingMcpServers?: boolean
  source?: string
}

export interface ToolPayloadPlan {
  enabled: boolean
  wireForm: DeferralWireForm
  wireWhy: DeferralWireVerdict['why']
  roster: Tools
  deferredNames: ReadonlySet<string>
  admittedNames: ReadonlySet<string>
  announcement: string | null
  isDeferredUnadmitted(name: string): boolean
}

const ANNOUNCEMENT_OPEN = '<available-deferred-tools>'
const ANNOUNCEMENT_CLOSE = '</available-deferred-tools>'

export function deferredToolsAnnouncement(tools: Tools, deferredNames: ReadonlySet<string>): string | null {
  const list = tools
    .filter(t => deferredNames.has(t.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')
  if (!list) return null
  return `${ANNOUNCEMENT_OPEN}\n${list}\n${ANNOUNCEMENT_CLOSE}`
}

export async function planToolPayload(input: ToolPayloadPlanInput): Promise<ToolPayloadPlan> {
  const { model, tools, messages } = input
  const wire = deferralWireFormFor(model)
  let enabled = await isToolSearchEnabled(
    model,
    tools,
    input.getToolPermissionContext,
    input.agents,
    input.source,
    wire.form,
  )

  const deferredNames = new Set<string>()
  if (enabled) {
    const rosterPermissionMode = (await input.getToolPermissionContext()).mode
    for (const t of tools) {
      if (isDeferredTool(t, rosterPermissionMode)) deferredNames.add(t.name)
    }
  }

  if (enabled && deferredNames.size === 0 && !input.hasPendingMcpServers) {
    enabled = false
  }

  const admittedNames = enabled ? extractDiscoveredToolNames(messages as Message[]) : new Set<string>()
  const roster: Tool[] = enabled
    ? tools.filter(tool => {
        if (!deferredNames.has(tool.name)) return true
        if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
        return admittedNames.has(tool.name)
      })
    : tools.filter(t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME))

  const announcement = enabled && !isDeferredToolsDeltaEnabled() ? deferredToolsAnnouncement(tools, deferredNames) : null

  return {
    enabled,
    wireForm: wire.form,
    wireWhy: wire.why,
    roster,
    deferredNames,
    admittedNames,
    announcement,
    isDeferredUnadmitted: (name: string) => enabled && deferredNames.has(name) && !admittedNames.has(name),
  }
}

export function announcementMessage(plan: ToolPayloadPlan): UserMessage | null {
  if (plan.announcement === null) return null
  return createUserMessage({ content: plan.announcement, isMeta: true })
}

export function foldAnnouncementIntoFirstUserTurn<M extends Message>(messages: M[], plan: ToolPayloadPlan): M[] {
  if (plan.announcement === null) return messages
  const index = messages.findIndex(m => m.type === 'user')
  if (index < 0) return messages
  const first = messages[index] as unknown as UserMessage
  const content = first.message.content
  const folded: UserMessage = {
    ...first,
    message: {
      ...first.message,
      content:
        typeof content === 'string'
          ? [
              { type: 'text' as const, text: plan.announcement },
              { type: 'text' as const, text: content },
            ]
          : [{ type: 'text' as const, text: plan.announcement }, ...content],
    },
  } as UserMessage
  const out = [...messages]
  out[index] = folded as unknown as M
  return out
}

export function admissionRecordText(names: readonly string[]): string {
  const list = names.map(n => `- ${n}`).join('\n')
  return `Tools admitted to this session:\n${list}\nTheir full schemas are in your tool list from this request on — call them like any other tool.`
}

export function renderAdmissionRecordsAsText<M extends Message | UserMessage | AssistantMessage>(messages: M[]): M[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) return message
    const hasRecord = content.some(
      block =>
        block.type === 'tool_result' &&
        Array.isArray((block as { content?: unknown }).content) &&
        ((block as { content: unknown[] }).content as unknown[]).some(isToolReferenceBlock),
    )
    if (!hasRecord) return message
    const rendered = content.map(block => {
      if (block.type !== 'tool_result') return block
      const inner = (block as { content?: unknown }).content
      if (!Array.isArray(inner)) return block
      const names: string[] = []
      const rest: unknown[] = []
      for (const item of inner as unknown[]) {
        if (isToolReferenceBlock(item)) {
          const name = (item as { tool_name?: unknown }).tool_name
          if (typeof name === 'string') names.push(name)
        } else {
          rest.push(item)
        }
      }
      if (names.length === 0) return block
      return {
        ...(block as object),
        content: [{ type: 'text' as const, text: admissionRecordText(names) }, ...rest],
      }
    })
    return {
      ...message,
      message: { ...(message as UserMessage).message, content: rendered },
    } as M
  })
}
