import type { Message } from 'src/types/message.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { deferralSearchIsServerSide, deferralWireFormFor, supportsToolDeferral } from '../providers/deferralWire.js'
import { conversationRosterKey, heldToolsAtLastPlan, planToolPayloadUnseeded, type ToolPayloadPlan } from '../providers/toolEconomy.js'
import { isDeferredToolFor } from '../../tools/ToolSearchTool/prompt.js'
import { rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../../utils/mcpInstructionsDelta.js'
import { mcpServerFailedWords, mcpServersFailed } from '../mcp/utils.js'
import {
  getDeferredToolsDelta,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../messages/toolSearch.js'
import { DEFERRED_TOOLS_ANNOUNCEMENT_HEAD } from '../../constants/tools/toolSearch.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { notBuilt } from '../../pi/holes.js'

export const SERVER_SEARCH_ANNOUNCEMENT_HEAD =
  'The following tools are available in this session but their definitions are not loaded yet. Before calling one, load it with the tool-search tool: pass the tool name as the pattern (a plain unanchored name such as WebFetch — the pattern is matched against the name and description together, so never use ^ or $), then call the tool as usual:'

export async function getPlannedDeferredToolsAttachment(
  context: ToolUseContext,
  messages: Message[],
  scanContext: DeferredToolsDeltaScanContext,
): Promise<Attachment[]> {
  return notBuilt('src/services/attachments/deltas.ts:27')
}

export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
  plan?: Pick<ToolPayloadPlan, 'enabled' | 'wireForm' | 'deferredNames'>,
): Attachment[] {
  return notBuilt('src/services/attachments/deltas.ts:58')
}

export function heldToolsBody(names: readonly string[]): string {
  return `The following tools joined this session after its first request and are held out of your tool list until the next compaction or /clear (the tool list a conversation starts with is kept for its life). They cannot be called yet:
${names.join(String.fromCharCode(10))}`
}

export function getHeldToolsAttachment(rosterOwner: string, messages: Message[]): Attachment[] {
  return notBuilt('src/services/attachments/deltas.ts:87')
}

export function getMcpServersFailedAttachment(
  mcpClients: ReadonlyArray<{ name: string; type: string; error?: string }>,
  messages: readonly Message[] | undefined,
): Attachment[] {
  return notBuilt('src/services/attachments/deltas.ts:100')
}

export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  _tools: Tools,
  _model: string,
  messages: Message[] | undefined,
): Attachment[] {
  return notBuilt('src/services/attachments/deltas.ts:116')
}
