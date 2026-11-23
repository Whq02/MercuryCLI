import type { Message } from 'src/engine/message-shapes/message.js'
import type { Tools, ToolUseContext } from '../../tools/kit/tool.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { deferralSearchIsServerSide, deferralWireFormFor, supportsToolDeferral } from '../../models/roads/deferralWire.js'
import { conversationRosterKey, heldToolsAtLastPlan, planToolPayloadUnseeded, type ToolPayloadPlan } from '../../models/roads/toolEconomy.js'
import { isDeferredToolFor } from '../../tools/tool-search/prompt.js'
import { rosterOwnerFromToolUseContext } from '../run-owner/resolveOwner.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../../integrations/mcp/mcpInstructionsDelta.js'
import { mcpServerFailedWords, mcpServersFailed } from '../../integrations/mcp/utils.js'
import {
  getDeferredToolsDelta,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../messages/toolSearch.js'
import { DEFERRED_TOOLS_ANNOUNCEMENT_HEAD } from '../../tools/kit/names/toolSearch.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'

export const SERVER_SEARCH_ANNOUNCEMENT_HEAD =
  'The following tools are available in this session but their definitions are not loaded yet. Before calling one, load it with the tool-search tool: pass the tool name as the pattern (a plain unanchored name such as WebFetch — the pattern is matched against the name and description together, so never use ^ or $), then call the tool as usual:'

export async function getPlannedDeferredToolsAttachment(
  context: ToolUseContext,
  messages: Message[],
  scanContext: DeferredToolsDeltaScanContext,
): Promise<Attachment[]> {
  const model = context.options.engineModel
  const tools = context.options.tools
  const plan = await planToolPayloadUnseeded({
    model,
    tools,
    messages,
    getToolPermissionContext: async () => context.getAppState().toolPermissionContext,
    agents: context.options.agentDefinitions?.activeAgents ?? [],
    hasPendingMcpServers: scanContext.hasPendingMcpServers,
    source: scanContext.querySource,
    latchKey: String(rosterOwnerFromToolUseContext(context)),
  })
  const suffix = conversationRosterKey('', messages, model)
  const recorded = plan.conversationKey === undefined
    ? messages.findLast(message => message.type === 'attachment' && message.attachment.type === 'bound_prefix' && message.attachment.boundKey.endsWith(suffix))
    : undefined
  if (recorded?.type === 'attachment' && recorded.attachment.type === 'bound_prefix') {
    return getDeferredToolsDeltaAttachment(tools, model, messages, scanContext, {
      enabled: recorded.attachment.rosterEnabled,
      wireForm: plan.wireForm,
      deferredNames: new Set(tools.filter(tool => isDeferredToolFor(tool, model, undefined, messages)).map(tool => tool.name)),
    })
  }
  return getDeferredToolsDeltaAttachment(tools, model, messages, scanContext, plan)
}

export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
  plan?: Pick<ToolPayloadPlan, 'enabled' | 'wireForm' | 'deferredNames'>,
): Attachment[] {
  if (!plan && !isToolSearchEnabledOptimistic()) return []
  if (!supportsToolDeferral(model)) return []
  const form = plan?.wireForm ?? deferralWireFormFor(model).form
  if (form === 'block' && !modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const names = plan?.enabled === false ? new Set<string>() : plan?.deferredNames
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext, model, names)
  if (!delta) return []
  const parts: string[] = []
  if (delta.addedLines.length) {
    const head = deferralSearchIsServerSide(form) ? SERVER_SEARCH_ANNOUNCEMENT_HEAD : DEFERRED_TOOLS_ANNOUNCEMENT_HEAD
    parts.push(`${head}\n${delta.addedLines.join('\n')}`)
  }
  if (delta.removedNames.length) parts.push(`The following tools are no longer available in this session:\n${delta.removedNames.join('\n')}`)
  return [{ type: 'deferred_tools_delta', ...delta, body: parts.join('\n\n') }]
}

export function heldToolsBody(names: readonly string[]): string {
  return `The following tools joined this session after its first request and are held out of your tool list until the next compaction or /clear (the tool list a conversation starts with is kept for its life). They cannot be called yet:
${names.join(String.fromCharCode(10))}`
}

export function getHeldToolsAttachment(rosterOwner: string, messages: Message[]): Attachment[] {
  const held = heldToolsAtLastPlan(rosterOwner, messages)
  if (!held.length) return []
  const told = new Set<string>()
  for (const row of messages) {
    if (row.type === 'attachment' && row.attachment.type === 'held_tools') {
      for (const name of row.attachment.names) told.add(name)
    }
  }
  const names = held.filter(name => !told.has(name)).sort()
  return names.length ? [{ type: 'held_tools', names, body: heldToolsBody(names) }] : []
}

export function getMcpServersFailedAttachment(
  mcpClients: ReadonlyArray<{ name: string; type: string; error?: string }>,
  messages: readonly Message[] | undefined,
): Attachment[] {
  const failed = mcpServersFailed(mcpClients)
  if (!failed.length) return []
  const told = new Set<string>()
  for (const row of messages ?? []) {
    if (row.type === 'attachment' && row.attachment.type === 'mcp_servers_failed') {
      for (const server of row.attachment.servers) told.add(server.name)
    }
  }
  const servers = failed.filter(server => !told.has(server.name))
  if (!servers.length) return []
  const body = servers.map(server => mcpServerFailedWords(server.name, server.reason)).join('\n')
  return [{ type: 'mcp_servers_failed', servers, body }]
}

export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  _tools: Tools,
  _model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []
  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], [])
  return delta ? [{ type: 'mcp_instructions_delta', ...delta }] : []
}
