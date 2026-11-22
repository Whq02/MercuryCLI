import type { MCPServerConnection } from './mcp/types.js'
import type { Message } from '../types/message.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


type McpInstructionsDelta = Unbuilt

type ClientSideInstruction = Unbuilt

export function isMcpInstructionsDeltaEnabled(): boolean {
  return notBuilt('src/utils/mcpInstructionsDelta.ts:13')
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
  return notBuilt('src/utils/mcpInstructionsDelta.ts:32')
}
