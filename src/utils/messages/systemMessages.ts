import type { UUID } from 'crypto'
import type * as Rows from '../../types/message.js'
import type { ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import type { APIError } from '../../services/api/sdkErrors.js'
import type { ModelTransitionReceipt } from '../model/modelTransition.js'
import { deepestErrorDetail, recentTransportFailure } from '../../services/api/transportEvidence.js'
import { MESSAGE_STAMPER } from '../../rows/project.js'
import { logForDebugging } from '../debug.js'
import { formatTokens } from '../format.js'

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
  if (row?.type !== 'assistant' || !Array.isArray(row.message.content)) return undefined
  return row.message.content.find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === name)
}

function resultIn(row: Rows.Message | undefined, id: string): ToolResultBlockParam | undefined {
  if (row?.type !== 'user' || !Array.isArray(row.message.content)) return undefined
  return row.message.content.find((block): block is ToolResultBlockParam => block.type === 'tool_result' && block.tool_use_id === id)
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
  return systemRow('compact_boundary', {
    level: 'info', content: 'Conversation compacted',
    compactMetadata: { trigger, preTokens, userContext, messagesSummarized },
    ...(lastPreCompactMessageUuid ? { logicalParentUuid: lastPreCompactMessageUuid } : {}),
  })
}

export function createMicrocompactBoundaryMessage(
  trigger: 'auto', preTokens: number, tokensSaved: number, compactedToolIds: string[], clearedAttachmentUUIDs: string[],
): Rows.SystemMicrocompactBoundaryMessage {
  const microcompactMetadata = { trigger, preTokens, tokensSaved, compactedToolIds, clearedAttachmentUUIDs }
  logForDebugging(`microcompact: about ${formatTokens(tokensSaved)} tokens freed by clearing ${compactedToolIds.length} tool results`)
  return systemRow('microcompact_boundary', { microcompactMetadata, level: 'info', content: 'Context microcompacted' })
}

type ErrorDetail = NonNullable<Rows.SystemAPIErrorMessage['errorDetail']>

function transportDetail(error: unknown, message: string, name: unknown, deep: ReturnType<typeof deepestErrorDetail>): ErrorDetail['transport'] {
  if (deep.code) return { code: deep.code, ...optional(deep, ['errno']), ...(deep.syscall ? { syscall: deep.syscall } : {}), via: 'cause-chain' }
  if (name !== 'APIConnectionTimeoutError' && !/request timed out/i.test(message)) return undefined
  const recent = recentTransportFailure()
  return recent ? {
    ...optional(recent, ['errno']),
    ...(recent.code ? { code: recent.code } : {}),
    ...(recent.syscall ? { syscall: recent.syscall } : {}),
    via: 'recent-failure', ageMs: Math.max(0, Date.now() - recent.ts),
  } : undefined
}

export function apiErrorDetailOf(error: unknown): ErrorDetail {
  const value = error as { name?: unknown; message?: unknown; status?: unknown } | null
  const status = typeof value?.status === 'number' ? value.status : undefined
  const deep = deepestErrorDetail(error)
  const words = typeof value?.message === 'string' && value.message ? value.message : String(error ?? 'unknown error')
  const transport = transportDetail(error, words, value?.name, deep)
  return {
    message: words,
    name: typeof value?.name === 'string' && value.name ? value.name : 'Error',
    ...optional(deep, ['code']),
    ...optional({ status, transport }, ['status', 'transport']),
  }
}

export function createSystemAPIErrorMessage(
  error: APIError | Error, retryInMs: number, retryAttempt: number, maxRetries: number,
  opts?: { recoveryTimeoutMs?: number },
): Rows.SystemAPIErrorMessage {
  const recovery = opts?.recoveryTimeoutMs
  return systemRow('api_error', {
    error, cause: error.cause instanceof Error ? error.cause : undefined,
    errorDetail: apiErrorDetailOf(error), level: 'error', retryInMs, retryAttempt, maxRetries,
    ...(recovery !== undefined && recovery > 0 ? { recoveryTimeoutMs: recovery } : {}),
  })
}

export function createStreamCutMessage(input: { count: number; content: string; road?: string; sent?: string; code?: string }): Rows.SystemStreamCutMessage {
  return systemRow('stream_cut', { ...select(input, ['count', 'content']), ...optional(input, ['road', 'sent', 'code']), level: 'info' })
}

export function createBusyRecoveryMessage(input: {
  provider: string; retries: number; elapsedMs: number; content: string; status?: number; code?: string
}): Rows.SystemBusyRecoveryMessage {
  return systemRow('busy_recovery', { ...select(input, ['provider', 'retries', 'elapsedMs', 'content']), ...optional(input, ['status', 'code']), level: 'info' })
}

export function createThinkingNoteMessage(content: string, level: Rows.SystemMessageLevel = 'info'): Rows.SystemThinkingNoteMessage {
  return systemRow('thinking_note', { level, content })
}

export function createThinkingDeadMessage(dead: Rows.DeadThinkingMark[], content: string): Rows.SystemThinkingDeadMessage {
  return systemRow('thinking_dead', { level: 'info', content, dead })
}

export function createSeatReceiptMessage(content: string, level: Rows.SystemMessageLevel = 'info'): Rows.SystemSeatReceiptMessage {
  return systemRow('seat_receipt', { level, content })
}

export function createRosterTransitionMessage(toggle: 'subagents' | 'workflows', on: boolean, content: string): Rows.SystemRosterTransitionMessage {
  return systemRow('roster_transition', { content, on, toggle, level: 'info' })
}

export function createModelTransitionMessage(receipt: ModelTransitionReceipt): Rows.SystemModelTransitionMessage {
  return systemRow('model_transition', select(receipt, ['previous', 'requested', 'applied', 'resolution', 'boundary', 'crossProvider', 'cacheDisposition']))
}

export function createSystemMessage(content: string, level: Rows.SystemMessageLevel, toolUseID?: string, preventContinuation?: boolean): Rows.SystemInformationalMessage {
  return systemRow('informational', { level, toolUseID, content, ...(preventContinuation ? { preventContinuation } : {}) })
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
  return systemRow('agents_killed', {})
}

export function createTurnDurationMessage(durationMs: number, budget?: { tokens: number; limit: number; nudges: number }, messageCount?: number): Rows.SystemTurnDurationMessage {
  return systemRow('turn_duration', { durationMs, messageCount, budgetTokens: budget?.tokens, budgetLimit: budget?.limit, budgetNudges: budget?.nudges })
}

export function createApiMetricsMessage(metrics: {
  ttftMs: number; otps: number; isP50?: boolean; hookDurationMs?: number; turnDurationMs?: number;
  toolDurationMs?: number; toolCount?: number; hookCount?: number; configWriteCount?: number
}): Rows.SystemApiMetricsMessage {
  return systemRow('api_metrics', select(metrics, ['ttftMs', 'otps', 'isP50', 'hookDurationMs', 'turnDurationMs', 'toolDurationMs', 'toolCount', 'hookCount', 'configWriteCount']))
}
