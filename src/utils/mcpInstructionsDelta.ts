import type { MCPServerConnection } from './mcp/types.js'
import type { Message } from '../types/message.js'


type McpInstructionsDelta = { addedNames: string[]; addedBlocks: string[]; removedNames: string[] }

type ClientSideInstruction = { serverName: string; block: string }

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

export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  const told = new Set<string>()
  for (const message of messages) {
    if (!isDeltaAttachment(message)) continue
    for (const name of message.attachment.addedNames ?? []) told.add(name)
    for (const name of message.attachment.removedNames ?? []) told.delete(name)
  }
  const connected = new Set<string>()
  const blocks = new Map<string, string>()
  for (const client of mcpClients) {
    if (client.type !== 'connected') continue
    connected.add(client.name)
    if (client.instructions) blocks.set(client.name, `## ${client.name}\n${client.instructions}`)
  }
  for (const { serverName, block } of clientSideInstructions) {
    if (!connected.has(serverName)) continue
    const previous = blocks.get(serverName)
    blocks.set(serverName, previous === undefined ? `## ${serverName}\n${block}` : `${previous}\n\n${block}`)
  }
  const addedNames = [...blocks.keys()].filter(name => !told.has(name)).sort((a, b) => a.localeCompare(b))
  const removedNames = [...told].filter(name => !connected.has(name)).sort()
  if (!addedNames.length && !removedNames.length) return null
  return { addedNames, addedBlocks: addedNames.map(name => blocks.get(name)!), removedNames }
}
