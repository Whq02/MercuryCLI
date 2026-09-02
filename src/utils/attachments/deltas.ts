// Conversation-delta announcements — deferred-tools, agent-listing, and MCP
// server instructions, each diffed against what prior attachments already
// announced (compact.ts re-announces after compaction eats the history; the
// gates here are the single source of truth for both call sites). Owned
// Mercury module.

import type { Message } from 'src/types/message.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { deferralWireFormFor } from '../../services/providers/deferralWire.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { filterAgentsByMcpRequirements } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '../../tools/AgentTool/prompt.js'
import { getSubscriptionType } from '../auth.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../mcpInstructionsDelta.js'
import { filterDeniedAgents } from '../permissions/permissions.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../toolSearch.js'
import type { Attachment } from './types.js'

// compact.ts re-announces through THIS function after compaction — one
// gate, two callers, no drift possible.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  // The attachment's copy promises "available via ToolSearch", so the three
  // sync legs of isToolSearchEnabled are re-checked here — the promise must
  // be true of the actual request. The async auto-threshold leg is left
  // out on purpose (re-running it would double-fire the mode decision);
  // the one narrow miss — tst-auto below threshold announcing tools while
  // ToolSearch is filtered out — is harmless because the announced tools
  // are directly callable anyway.
  if (!isToolSearchEnabledOptimistic()) return []
  // Model support is a BLOCK-form fact; the text form has no model term.
  if (deferralWireFormFor(model).form === 'block' && !modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
}

/**
 * Announce agent-roster changes as a delta against what this conversation
 * has already been told (reconstructed from prior agent_listing_delta
 * attachments). [] when nothing changed or the gate is off.
 *
 * Why a delta attachment at all: the roster would otherwise live inside AgentTool's
 * description, where any roster wobble — an MCP server connecting late,
 * /extensions reload, a permission-mode change — rewrote the description and
 * busted the entire tool-schema prompt cache. Out here, the description
 * stays static and roster motion costs one small attachment.
 *
 * compact.ts calls this same function to rebuild the roster announcement
 * once compaction has eaten the old deltas.
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  // Without the Agent tool in the pool, a roster is a list of doors that
  // don't open — skip it.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
  ) {
    return []
  }

  const { activeAgents, allowedAgentTypes } =
    toolUseContext.options.agentDefinitions

  // The filter chain must equal AgentTool.prompt()'s own (MCP requirements
  // → deny rules → allowedAgentTypes), or the announcement and the tool
  // disagree about which agents exist. Coupled to AgentTool.tsx.
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) mcpServers.add(info.serverName)
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType))
  }

  // What the conversation already knows = the replay of every prior delta.
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'agent_listing_delta') continue
    for (const t of msg.attachment.addedTypes) announced.add(t)
    for (const t of msg.attachment.removedTypes) announced.delete(t)
  }

  const currentTypes = new Set(filtered.map(a => a.agentType))
  const added = filtered.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  // Deterministic order out of nondeterministic discovery (extension load
  // races, MCP async connect) — sorted, always.
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: getSubscriptionType() !== 'pro',
    },
  ]
}

// The compact paths (compact.ts / reactiveCompact.ts) re-announce through
// here too — the gate lives once.
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  _tools: Tools,
  _model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  // No client-authored instruction producers remain (the chrome ToolSearch
  // hint died with the in-Chrome removal); server-authored
  // `instructions` are the only channel.
  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], [])
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}
