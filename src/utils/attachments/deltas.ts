
import type { Message } from 'src/types/message.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { deferralSearchIsServerSide, deferralWireFormFor, supportsToolDeferral } from '../../services/providers/deferralWire.js'
import { conversationRosterKey, heldToolsAtLastPlan, planToolPayloadUnseeded, type ToolPayloadPlan } from '../../services/providers/toolEconomy.js'
import { isDeferredToolFor } from '../../tools/ToolSearchTool/prompt.js'
import { rosterOwnerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../mcpInstructionsDelta.js'
import { mcpServerFailedWords, mcpServersFailed } from '../../services/mcp/utils.js'
import {
  getDeferredToolsDelta,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../toolSearch.js'
import type { Attachment } from './types.js'

export const SERVER_SEARCH_ANNOUNCEMENT_HEAD =
  'The following tools are available in this session but their definitions are not loaded yet. Before calling one, load it with the tool-search tool: pass the tool name as the pattern (a plain unanchored name such as WebFetch — the pattern is matched against the name and description together, so never use ^ or $), then call the tool as usual:'

export const DEFERRED_TOOLS_ANNOUNCEMENT_HEAD =
  'Deferred tools: offered in this session, but their definitions are not loaded. To call one, first load it with ToolSearch — query "select:<name>", or "select:<name>,<name>" for several — then call it.'

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
  if (!(plan?.enabled ?? isToolSearchEnabledOptimistic()) || !supportsToolDeferral(model)) return []
  const form = plan?.wireForm ?? deferralWireFormFor(model).form
  if (form === 'block' && !modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext, model, plan?.deferredNames)
  if (!delta) return []
  const addedHead = deferralSearchIsServerSide(form) ? SERVER_SEARCH_ANNOUNCEMENT_HEAD : DEFERRED_TOOLS_ANNOUNCEMENT_HEAD
  const body = [
    ...(delta.addedLines.length > 0 ? [`${addedHead}
${delta.addedLines.join(String.fromCharCode(10))}`] : []),
    ...(delta.removedNames.length > 0 ? [`The following tools are no longer available in this session:
${delta.removedNames.join(String.fromCharCode(10))}`] : []),
  ].join(String.fromCharCode(10, 10))
  return [{ type: 'deferred_tools_delta', ...delta, body }]
}

export function heldToolsBody(names: readonly string[]): string {
  return `The following tools joined this session after its first request and are held out of your tool list until the next compaction or /clear (the tool list a conversation starts with is kept for its life). They cannot be called yet:
${names.join(String.fromCharCode(10))}`
}

export function getHeldToolsAttachment(rosterOwner: string, messages: Message[]): Attachment[] {
  const held = heldToolsAtLastPlan(rosterOwner, messages)
  if (held.length === 0) return []
  const announced = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'attachment' || message.attachment.type !== 'held_tools') continue
    for (const name of message.attachment.names) announced.add(name)
  }
  const names = held.filter(name => !announced.has(name)).sort()
  if (names.length === 0) return []
  return [{ type: 'held_tools', names, body: heldToolsBody(names) }]
}

export function getMcpServersFailedAttachment(
  mcpClients: ReadonlyArray<{ name: string; type: string; error?: string }>,
  messages: readonly Message[] | undefined,
): Attachment[] {
  const failed = mcpServersFailed(mcpClients)
  if (failed.length === 0) return []
  const announced = new Set<string>()
  for (const message of messages ?? []) {
    if (message.type !== 'attachment' || message.attachment.type !== 'mcp_servers_failed') continue
    for (const server of message.attachment.servers) announced.add(server.name)
  }
  const servers = failed.filter(server => !announced.has(server.name))
  if (servers.length === 0) return []
  return [{ type: 'mcp_servers_failed', servers, body: servers.map(server => mcpServerFailedWords(server.name, server.reason)).join('\n') }]
}

export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  _tools: Tools,
  _model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], [])
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}
