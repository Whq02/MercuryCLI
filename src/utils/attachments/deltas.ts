
import type { Message } from 'src/types/message.js'
import type { Tools } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { deferralWireFormFor, supportsToolDeferral } from '../../services/providers/deferralWire.js'
import { heldToolsAtLastPlan } from '../../services/providers/toolEconomy.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../mcpInstructionsDelta.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../toolSearch.js'
import type { Attachment } from './types.js'

export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  if (!isToolSearchEnabledOptimistic() || !supportsToolDeferral(model)) return []
  if (deferralWireFormFor(model).form === 'block' && !modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  const body = [
    ...(delta.addedLines.length > 0 ? [`The following tools are available in this session:
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
