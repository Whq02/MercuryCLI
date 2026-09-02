import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Message } from '../types/message.js'

/**
 * Announce connected MCP servers' instructions once, as an attachment
 * persisted into the conversation, instead of rebuilding a system-prompt
 * section every turn (which sits inside the cached prefix and re-bills every
 * block after it whenever a server connects or drops).
 */

export type McpInstructionsDelta = {
  addedNames: string[]
  addedBlocks: string[]
  removedNames: string[]
}

export type ClientSideInstruction = { serverName: string; block: string }

/** Unconditionally ON — a Mercury ruling, not an experiment; no env
 *  override exists. */
export function isMcpInstructionsDeltaEnabled(): boolean {
  return true
}

type DeltaAttachmentMessage = {
  type: 'attachment'
  attachment: { type: 'mcp_instructions_delta'; addedNames: string[]; removedNames: string[] }
}

function isDeltaAttachment(message: unknown): message is DeltaAttachmentMessage {
  const candidate = message as { type?: unknown; attachment?: { type?: unknown } } | null
  return (
    !!candidate &&
    candidate.type === 'attachment' &&
    !!candidate.attachment &&
    candidate.attachment.type === 'mcp_instructions_delta'
  )
}

/**
 * Diffs by SERVER NAME only, never by content — instructions arrive once in
 * the handshake and cannot change without a reconnect. History is the only
 * source of truth for what was announced; the delta only ever moves forward.
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  const announced = new Set<string>()
  for (const message of messages) {
    if (!isDeltaAttachment(message)) continue
    for (const name of message.attachment.addedNames ?? []) announced.add(name)
    for (const name of message.attachment.removedNames ?? []) announced.delete(name)
  }

  const blocks = new Map<string, string>()
  const connectedNames = new Set<string>()
  for (const client of mcpClients) {
    if (client.type !== 'connected') continue
    connectedNames.add(client.name)
    if (client.instructions) blocks.set(client.name, `## ${client.name}\n${client.instructions}`)
  }
  for (const { serverName, block } of clientSideInstructions) {
    if (!connectedNames.has(serverName)) continue
    const existing = blocks.get(serverName)
    blocks.set(serverName, existing ? `${existing}\n\n${block}` : `## ${serverName}\n${block}`)
  }

  const addedNames = [...blocks.keys()].filter(name => !announced.has(name)).sort((a, b) => a.localeCompare(b))
  const removedNames = [...announced].filter(name => !connectedNames.has(name)).sort()
  if (addedNames.length === 0 && removedNames.length === 0) return null
  return {
    addedNames,
    addedBlocks: addedNames.map(name => blocks.get(name) as string),
    removedNames,
  }
}
