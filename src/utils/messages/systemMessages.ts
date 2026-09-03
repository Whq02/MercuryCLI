
import type { ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import type { APIError } from '../../services/api/sdkErrors.js'
import {
  deepestErrorDetail,
  recentTransportFailure,
} from '../../services/api/transportEvidence.js'
import { randomUUID, type UUID } from 'crypto'
import type {
  AwayRecapMetadata,
  Message,
  NormalizedMessage,
  StopHookInfo,
  SystemAgentsKilledMessage,
  SystemAPIErrorMessage,
  SystemApiMetricsMessage,
  SystemAwaySummaryMessage,
  SystemModelTransitionMessage,
  SystemCompactBoundaryMessage,
  SystemInformationalMessage,
  SystemLocalCommandMessage,
  SystemMemorySavedMessage,
  SystemMessageLevel,
  SystemMicrocompactBoundaryMessage,
  SystemPermissionRetryMessage,
  SystemScheduledTaskFireMessage,
  SystemStopHookSummaryMessage,
  SystemTurnDurationMessage,
} from '../../types/message.js'
import type { CompactMetadata } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { formatTokens } from '../format.js'


export function createSystemMessage(
  content: string,
  level: SystemMessageLevel,
  toolUseID?: string,
  preventContinuation?: boolean,
): SystemInformationalMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    toolUseID,
    level,
    ...(preventContinuation && { preventContinuation }),
  }
}

export function createRosterTransitionMessage(
  toggle: 'subagents' | 'workflows',
  on: boolean,
  content: string,
): import('../../types/message.js').SystemRosterTransitionMessage {
  return {
    type: 'system',
    subtype: 'roster_transition',
    toggle,
    on,
    content,
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createSeatReceiptMessage(
  content: string,
  level: SystemMessageLevel = 'info',
): import('../../types/message.js').SystemSeatReceiptMessage {
  return {
    type: 'system',
    subtype: 'seat_receipt',
    content,
    level,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createPermissionRetryMessage(
  commands: string[],
): SystemPermissionRetryMessage {
  return {
    type: 'system',
    subtype: 'permission_retry',
    content: `Allowed ${commands.join(', ')}`,
    commands,
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}


export function createScheduledTaskFireMessage(
  content: string,
): SystemScheduledTaskFireMessage {
  return {
    type: 'system',
    subtype: 'scheduled_task_fire',
    content,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createStopHookSummaryMessage(
  hookCount: number,
  hookInfos: StopHookInfo[],
  hookErrors: string[],
  preventedContinuation: boolean,
  stopReason: string | undefined,
  hasOutput: boolean,
  level: SystemMessageLevel,
  toolUseID?: string,
  hookLabel?: string,
  totalDurationMs?: number,
): SystemStopHookSummaryMessage {
  return {
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount,
    hookInfos,
    hookErrors,
    preventedContinuation,
    stopReason,
    hasOutput,
    level,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    toolUseID,
    hookLabel,
    totalDurationMs,
  }
}

export function createTurnDurationMessage(
  durationMs: number,
  budget?: { tokens: number; limit: number; nudges: number },
  messageCount?: number,
): SystemTurnDurationMessage {
  return {
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    budgetTokens: budget?.tokens,
    budgetLimit: budget?.limit,
    budgetNudges: budget?.nudges,
    messageCount,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createModelTransitionMessage(
  receipt: import('../model/modelTransition.js').ModelTransitionReceipt,
): SystemModelTransitionMessage {
  return {
    type: 'system',
    subtype: 'model_transition',
    previous: receipt.previous,
    requested: receipt.requested,
    applied: receipt.applied,
    resolution: receipt.resolution,
    boundary: receipt.boundary,
    crossProvider: receipt.crossProvider,
    cacheDisposition: receipt.cacheDisposition,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createAwaySummaryMessage(
  content: string,
  recapMetadata?: AwayRecapMetadata,
): SystemAwaySummaryMessage {
  return {
    type: 'system',
    subtype: 'away_summary',
    content,
    ...(recapMetadata ? { recapMetadata } : {}),
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createMemorySavedMessage(
  writtenPaths: string[],
): SystemMemorySavedMessage {
  return {
    type: 'system',
    subtype: 'memory_saved',
    writtenPaths,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createAgentsKilledMessage(): SystemAgentsKilledMessage {
  return {
    type: 'system',
    subtype: 'agents_killed',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createApiMetricsMessage(metrics: {
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}): SystemApiMetricsMessage {
  return {
    type: 'system',
    subtype: 'api_metrics',
    ttftMs: metrics.ttftMs,
    otps: metrics.otps,
    isP50: metrics.isP50,
    hookDurationMs: metrics.hookDurationMs,
    turnDurationMs: metrics.turnDurationMs,
    toolDurationMs: metrics.toolDurationMs,
    classifierDurationMs: metrics.classifierDurationMs,
    toolCount: metrics.toolCount,
    hookCount: metrics.hookCount,
    classifierCount: metrics.classifierCount,
    configWriteCount: metrics.configWriteCount,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createCommandInputMessage(
  content: string,
): SystemLocalCommandMessage {
  return {
    type: 'system',
    subtype: 'local_command',
    content,
    level: 'info',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false,
  }
}

export function createCompactBoundaryMessage(
  trigger: CompactMetadata['trigger'],
  preTokens: number,
  lastPreCompactMessageUuid?: UUID,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: `Conversation compacted`,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger,
      preTokens,
      userContext,
      messagesSummarized,
    },
    ...(lastPreCompactMessageUuid && {
      logicalParentUuid: lastPreCompactMessageUuid,
    }),
  }
}

export function createMicrocompactBoundaryMessage(
  trigger: 'auto',
  preTokens: number,
  tokensSaved: number,
  compactedToolIds: string[],
  clearedAttachmentUUIDs: string[],
): SystemMicrocompactBoundaryMessage {
  logForDebugging(
    `[microcompact] saved ~${formatTokens(tokensSaved)} tokens (cleared ${compactedToolIds.length} tool results)`,
  )
  return {
    type: 'system',
    subtype: 'microcompact_boundary',
    content: 'Context microcompacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    microcompactMetadata: {
      trigger,
      preTokens,
      tokensSaved,
      compactedToolIds,
      clearedAttachmentUUIDs,
    },
  }
}

export function apiErrorDetailOf(error: unknown): NonNullable<
  SystemAPIErrorMessage['errorDetail']
> {
  const e = error as {
    name?: unknown
    message?: unknown
    status?: unknown
  } | null
  const status = typeof e?.status === 'number' ? e.status : undefined
  const deep = deepestErrorDetail(error)
  const message =
    typeof e?.message === 'string' && e.message
      ? e.message
      : String(error ?? 'unknown error')
  let transport: NonNullable<SystemAPIErrorMessage['errorDetail']>['transport']
  if (deep.code) {
    transport = {
      code: deep.code,
      ...(deep.errno !== undefined ? { errno: deep.errno } : {}),
      ...(deep.syscall ? { syscall: deep.syscall } : {}),
      via: 'cause-chain',
    }
  } else if (
    (typeof e?.name === 'string' && e.name === 'APIConnectionTimeoutError') ||
    /request timed out/i.test(message)
  ) {
    const recent = recentTransportFailure()
    if (recent) {
      transport = {
        ...(recent.code ? { code: recent.code } : {}),
        ...(recent.errno !== undefined ? { errno: recent.errno } : {}),
        ...(recent.syscall ? { syscall: recent.syscall } : {}),
        via: 'recent-failure',
        ageMs: Math.max(0, Date.now() - recent.ts),
      }
    }
  }
  return {
    name: typeof e?.name === 'string' && e.name ? e.name : 'Error',
    message,
    ...(status !== undefined ? { status } : {}),
    ...(deep.code !== undefined ? { code: deep.code } : {}),
    ...(transport !== undefined ? { transport } : {}),
  }
}

export function createSystemAPIErrorMessage(
  error: APIError | Error,
  retryInMs: number,
  retryAttempt: number,
  maxRetries: number,
  opts?: {
    recoveryTimeoutMs?: number
  },
): SystemAPIErrorMessage {
  return {
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    cause: error.cause instanceof Error ? error.cause : undefined,
    error,
    errorDetail: apiErrorDetailOf(error),
    retryInMs,
    ...(opts?.recoveryTimeoutMs !== undefined && opts.recoveryTimeoutMs > 0
      ? { recoveryTimeoutMs: opts.recoveryTimeoutMs }
      : {}),
    retryAttempt,
    maxRetries,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}


export function isCompactBoundaryMessage(
  message: Message | NormalizedMessage,
): message is SystemCompactBoundaryMessage {
  return message?.type === 'system' && message.subtype === 'compact_boundary'
}

export function findLastCompactBoundaryIndex<
  T extends Message | NormalizedMessage,
>(messages: T[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isCompactBoundaryMessage(message)) return i
  }
  return -1
}

export function getMessagesAfterCompactBoundary<
  T extends Message | NormalizedMessage,
>(messages: T[], options?: { includeSnipped?: boolean }): T[] {
  void options
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  return boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)
}


export function shouldShowUserMessage(
  message: NormalizedMessage,
  isTranscriptMode: boolean,
): boolean {
  if (message.type !== 'user') return true
  if (message.isMeta) {
    return false
  }
  if (message.isVisibleInTranscriptOnly && !isTranscriptMode) return false
  return true
}

export function isThinkingMessage(message: Message): boolean {
  if (message.type !== 'assistant') return false
  if (!Array.isArray(message.message.content)) return false
  return message.message.content.every(
    block => block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

export function countToolCalls(
  messages: Message[],
  toolName: string,
  maxCount?: number,
): number {
  let count = 0
  for (const msg of messages) {
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const hasToolUse = msg.message.content.some(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (hasToolUse) {
        count++
        if (maxCount && count >= maxCount) return count
      }
    }
  }
  return count
}

export function hasSuccessfulToolCall(
  messages: Message[],
  toolName: string,
): boolean {
  let mostRecentToolUseId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const toolUse = msg.message.content.find(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name === toolName,
      )
      if (toolUse) {
        mostRecentToolUseId = toolUse.id
        break
      }
    }
  }
  if (!mostRecentToolUseId) return false

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const toolResult = msg.message.content.find(
        (block): block is ToolResultBlockParam =>
          block.type === 'tool_result' &&
          block.tool_use_id === mostRecentToolUseId,
      )
      if (toolResult) return toolResult.is_error !== true
    }
  }
  return false
}
