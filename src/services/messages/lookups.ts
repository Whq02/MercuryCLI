import type { ToolUseBlockParam } from '../../types/wire.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import type { AssistantMessage, AttachmentMessage, Message, NormalizedMessage, NormalizedUserMessage, ProgressMessage } from '../../types/message.js'
import type { HookAttachment } from '../../utils/attachments/types.js'
import { isContinuableStreamFaultMessage, isStreamFaultRecoveryNudgeText } from '../api/errors.js'
import { contentBlocksOf } from '../../utils/messages/normalize.js'
import { accumulateOpenToolUses, freshOpenToolUses } from '../../utils/messages/openToolUses.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'
export type MessageLookups = Unbuilt

export const EMPTY_LOOKUPS: MessageLookups = unbuilt('src/services/messages/lookups.ts:35')
export const EMPTY_STRING_SET: ReadonlySet<string> = unbuilt('src/services/messages/lookups.ts:36')

export function buildMessageLookups(normalizedMessages: NormalizedMessage[], messages: Message[]): MessageLookups {
  return notBuilt('src/services/messages/lookups.ts:122')
}

export function buildSubagentLookups(messages: { message: AssistantMessage | NormalizedUserMessage }[]): {
  lookups: MessageLookups; inProgressToolUseIDs: Set<string>
} {
  return notBuilt('src/services/messages/lookups.ts:147')
}

export function isHookAttachmentMessage(message: Message): message is AttachmentMessage<HookAttachment> {
  return notBuilt('src/services/messages/lookups.ts:168')
}

export function getToolUseID(message: NormalizedMessage): string | null {
  return notBuilt('src/services/messages/lookups.ts:172')
}

export function getSiblingToolUseIDsFromLookup(message: NormalizedMessage, lookups: MessageLookups): ReadonlySet<string> {
  return notBuilt('src/services/messages/lookups.ts:189')
}

export function getProgressMessagesFromLookup(message: NormalizedMessage, lookups: MessageLookups): ProgressMessage[] {
  return notBuilt('src/services/messages/lookups.ts:194')
}

export function hasUnresolvedHooksFromLookup(toolUseID: string, hookEvent: HookEvent, lookups: MessageLookups): boolean {
  return notBuilt('src/services/messages/lookups.ts:199')
}

export function hasUnresolvedHooks(messages: NormalizedMessage[], toolUseID: string, hookEvent: HookEvent): Unbuilt {
  return notBuilt('src/services/messages/lookups.ts:204')
}

export function getToolResultIDs(normalizedMessages: NormalizedMessage[]): { [toolUseID: string]: boolean } {
  return notBuilt('src/services/messages/lookups.ts:214')
}

export function getToolUseIDs(normalizedMessages: NormalizedMessage[]): Set<string> {
  return notBuilt('src/services/messages/lookups.ts:224')
}

export function getSiblingToolUseIDs(message: NormalizedMessage, messages: Message[]): Set<string> {
  return notBuilt('src/services/messages/lookups.ts:234')
}

export function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  return notBuilt('src/services/messages/lookups.ts:248')
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  return notBuilt('src/services/messages/lookups.ts:252')
}
