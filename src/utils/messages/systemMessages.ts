import type { UUID } from 'crypto'
import type * as Rows from '../../types/message.js'
import type { ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import type { APIError } from '../api/sdkErrors.js'
import type { ModelTransitionReceipt } from '../../types/message.js'
import { deepestErrorDetail, recentTransportFailure } from '../api/transportEvidence.js'
import { MESSAGE_STAMPER } from '../../rows/project.js'
import { logForDebugging } from '../debug.js'
import { formatTokens } from '../format.js'
import { notBuilt } from '../../pi/holes.js'

type StoredRow = Rows.Message | Rows.NormalizedMessage
type SystemKind = Rows.SystemMessage['subtype']
type SystemRow<K extends SystemKind> = Extract<Rows.SystemMessage, { subtype: K }>
type Payload<K extends SystemKind> = Omit<SystemRow<K>, 'type' | 'subtype' | 'uuid' | 'timestamp' | 'isMeta'>

function systemRow<K extends SystemKind>(kind: K, payload: Payload<K>): SystemRow<K> {
  return Object.assign({ type: 'system', subtype: kind }, payload, MESSAGE_STAMPER.mint(), kind === 'api_error' ? {} : { isMeta: false }) as SystemRow<K>
}

function select<T, K extends keyof T>(input: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map(key => [key, input[key]])) as Pick<T, K>
}

function optional<T, K extends keyof T>(input: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])) as Partial<Pick<T, K>>
}

export function isCompactBoundaryMessage(row: StoredRow): row is Rows.SystemCompactBoundaryMessage {
  return row?.type === 'system' ? row.subtype === 'compact_boundary' : false
}

export function findLastCompactBoundaryIndex<T extends StoredRow>(messages: T[]): number {
  return messages.findLastIndex(row => !!row && isCompactBoundaryMessage(row))
}

export function getMessagesAfterCompactBoundary<T extends StoredRow>(messages: T[], _options?: { includeSnipped?: boolean }): T[] {
  const start = findLastCompactBoundaryIndex(messages)
  return start < 0 ? messages : messages.slice(start)
}

export function shouldShowUserMessage(row: Rows.NormalizedMessage, isTranscriptMode: boolean): boolean {
  return row.type !== 'user' || (!row.isMeta && (!row.isVisibleInTranscriptOnly || isTranscriptMode))
}

export function isThinkingMessage(row: Rows.Message): boolean {
  const content = row.type === 'assistant' ? row.message.content : undefined
  return Array.isArray(content) && !content.some(block => !['thinking', 'redacted_thinking'].includes(block.type))
}

function callIn(row: Rows.Message | undefined, name: string): ToolUseBlock | undefined {
  return notBuilt('src/utils/messages/systemMessages.ts:50')
}

function resultIn(row: Rows.Message | undefined, id: string): ToolResultBlockParam | undefined {
  return notBuilt('src/utils/messages/systemMessages.ts:55')
}

function* toolCallingRows(rows: Rows.Message[], name: string): IterableIterator<Rows.Message> {
  for (const row of rows) {
    const content = row?.type === 'assistant' ? row.message.content : undefined
    if (Array.isArray(content) && content.some(block => block.type === 'tool_use' && block.name === name)) yield row
  }
}

export function countToolCalls(messages: Rows.Message[], toolName: string, maxCount?: number): number {
  const callers = toolCallingRows(messages, toolName)
  let found = 0
  while (!callers.next().done) {
    found += 1
    if (maxCount && found >= maxCount) break
  }
  return found
}

export function hasSuccessfulToolCall(messages: Rows.Message[], toolName: string): boolean {
  const caller = messages.findLast(row => !!callIn(row, toolName))
  const id = callIn(caller, toolName)?.id
  if (!id) return false
  const answer = messages.findLast(row => !!resultIn(row, id))
  const result = resultIn(answer, id)
  return result !== undefined && result.is_error !== true
}

export function createCompactBoundaryMessage(
  trigger: Rows.CompactMetadata['trigger'], preTokens: number, lastPreCompactMessageUuid?: UUID,
  userContext?: string, messagesSummarized?: number,
): Rows.SystemCompactBoundaryMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:86')
}

export function createMicrocompactBoundaryMessage(
  trigger: 'auto', preTokens: number, tokensSaved: number, compactedToolIds: string[], clearedAttachmentUUIDs: string[],
): Rows.SystemMicrocompactBoundaryMessage {
  const microcompactMetadata = { trigger, preTokens, tokensSaved, compactedToolIds, clearedAttachmentUUIDs }
  logForDebugging(`microcompact: about ${formatTokens(tokensSaved)} tokens freed by clearing ${compactedToolIds.length} tool results`)
  return systemRow('microcompact_boundary', { microcompactMetadata, level: 'info', content: 'Context microcompacted' })
}

type ErrorDetail = NonNullable<Rows.SystemAPIErrorMessage['errorDetail']>

export function apiErrorDetailOf(error: unknown): ErrorDetail {
  return notBuilt('src/utils/messages/systemMessages.ts:119')
}

export function createSystemAPIErrorMessage(
  error: APIError | Error, retryInMs: number, retryAttempt: number, maxRetries: number,
  opts?: { recoveryTimeoutMs?: number },
): Rows.SystemAPIErrorMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:133')
}

export function createStreamCutMessage(input: { count: number; content: string; road?: string; sent?: string; code?: string }): Rows.SystemStreamCutMessage {
  return systemRow('stream_cut', { ...select(input, ['count', 'content']), ...optional(input, ['road', 'sent', 'code']), level: 'info' })
}

export function createBusyRecoveryMessage(input: {
  provider: string; retries: number; elapsedMs: number; content: string; status?: number; code?: string
}): Rows.SystemBusyRecoveryMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:149')
}

export function createThinkingNoteMessage(content: string, level?: Rows.SystemMessageLevel): Rows.SystemThinkingNoteMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:155')
}

export function createThinkingDeadMessage(dead: Rows.DeadThinkingMark[], content: string): Rows.SystemThinkingDeadMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:159')
}

export function createSeatReceiptMessage(content: string, level: Rows.SystemMessageLevel = 'info', copyText?: string): Rows.SystemSeatReceiptMessage {
  return systemRow('seat_receipt', { level, content, ...(copyText !== undefined ? { copyText } : {}) })
}

export function createRosterTransitionMessage(toggle: 'subagents', on: boolean, content: string): Rows.SystemRosterTransitionMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:167')
}

export function createModelTransitionMessage(receipt: ModelTransitionReceipt): Rows.SystemModelTransitionMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:171')
}

export function createSystemMessage(content: string, level: Rows.SystemMessageLevel, toolUseID?: string, preventContinuation?: boolean): Rows.SystemInformationalMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:175')
}

export function createCloseUsageMessage(input: { closeState: Rows.SystemCloseUsageMessage['closeState']; noteChars?: number; usage?: import('../api/emptyUsage.js').NonNullableUsage; spent?: import('../ledgerMark.js').LedgerMark }): Rows.SystemCloseUsageMessage {
  return systemRow('close_usage', { closeState: input.closeState, ...(input.noteChars !== undefined ? { noteChars: input.noteChars } : {}), ...(input.usage !== undefined ? { usage: input.usage } : {}), ...(input.spent !== undefined ? { spent: input.spent } : {}) })
}

export function createCommandInputMessage(content: string): Rows.SystemLocalCommandMessage {
  return systemRow('local_command', { level: 'info', content })
}

export function createScheduledTaskFireMessage(content: string): Rows.SystemScheduledTaskFireMessage {
  return systemRow('scheduled_task_fire', { content })
}

export function createAwaySummaryMessage(content: string, recapMetadata?: Rows.AwayRecapMetadata): Rows.SystemAwaySummaryMessage {
  return systemRow('away_summary', { content, ...(recapMetadata ? { recapMetadata } : {}) })
}

export function createMemorySavedMessage(writtenPaths: string[]): Rows.SystemMemorySavedMessage {
  return systemRow('memory_saved', { writtenPaths })
}

export function createAgentsKilledMessage(): Rows.SystemAgentsKilledMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:199')
}

export function createTurnDurationMessage(durationMs: number, budget?: { tokens: number; limit: number; nudges: number }, messageCount?: number): Rows.SystemTurnDurationMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:203')
}

export function createApiMetricsMessage(metrics: {
  ttftMs: number; otps: number; isP50?: boolean; hookDurationMs?: number; turnDurationMs?: number;
  toolDurationMs?: number; toolCount?: number; hookCount?: number; configWriteCount?: number
}): Rows.SystemApiMetricsMessage {
  return notBuilt('src/utils/messages/systemMessages.ts:207')
}
