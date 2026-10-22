import { canAnswerAsks, getMainThreadAgentType, getInvokedSkillsForAgent, getSdkBetas } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../api/emptyUsage.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../../types/message.js'
import type { CompactMetadata } from '../../types/message.js'
import type { UUID } from 'node:crypto'
import { getAgentRosterAttachment, queuedNoticeTaskIds } from '../../utils/attachments/agentRoster.js'
import { getDeferredToolsDeltaAttachment, getMcpInstructionsDeltaAttachment } from '../../utils/attachments/deltas.js'
import { generateFileAttachment } from '../../utils/attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { getUserContextAttachment } from '../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../utils/config/derived.js'
import { foldedTurnReceipts } from '../../utils/cockpit/turnReceipt.js'
import { collectAwayWork } from '../../utils/cockpit/awaySummary.js'
import { getMercuryTempDir } from '../../utils/permissions/filesystem.js'
import { logForDebugging } from '../../utils/debug.js'
import { continuationOfSentRequest, lastSentRequestFor, runForkedAgent, type CacheSafeParams } from '../../utils/forkedAgent.js'
import { appendSystemContext, toolToAPISchema } from '../../utils/api.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { classifyModelRoute } from '../providers/routeLaw.js'
import { fireHooks, type HookFireResult } from '../../utils/hooks/fire.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logError } from '../../utils/log.js'
import { MEMORY_TYPE_VALUES } from '../../utils/memory/types.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  getAssistantMessageText,
  isCompactBoundaryMessage,
} from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import type { FileState } from '../../utils/fileStateCache.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../utils/sessionActivity.js'
import { reAppendSessionMetadata } from '../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { recordContentReplacement } from '../../utils/sessionStorage/writer.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames, isToolSearchEnabled } from '../../utils/toolSearch.js'
import { sleep } from '../../utils/sleep.js'
import { getContextWindowForModel } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import { API_ERROR_MESSAGE_PREFIX, PROMPT_TOO_LONG_ERROR_MESSAGE, getPromptTooLongTokenGap } from '../api/errors.js'
import { type OverflowSignal, overflowGapTokens, overflowSignalOf } from '../api/overflowSignal.js'
import { LOCAL_WINDOW_REMEDY, localFitRefusalFacts } from '../providers/local/localCatalogue.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import { COLD_INGEST_MS_PER_1K_TOKENS, coldPrefixOf, firstByteBudgetMs, streamIdleTimeoutMsForRoute } from '../providers/streamIdleBudget.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { recordWireFoldRow, type WireFoldRow } from '../api/dumpPrompts.js'
import { getRetryDelay } from '../api/withRetry.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import { isInstructionFilePath } from '../../services/instructions/engine.js'
import { releaseLspDocumentsForContext } from '../lsp/manager.js'
import { advanceContextEpoch, getContextEpoch } from '../run/contextEpochs.js'
import { buildFoldLedger, renderFoldLedger } from './foldLedger.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import { roughTokenCountEstimation, roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { estimateRequestGauge, readRequestGauge } from '../run/requestGauge.js'
import { getBlockingLimit, getEffectiveContextWindowSize, resolveAutoCompactWindow } from './autoCompact.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../utils/toolResultStorage.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import { REPEATED_RESULT_TAG } from '../../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../../tools/FileReadTool/prompt.js'
import { ToolSearchTool } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import { groupMessagesByApiRound } from './grouping.js'
import { estimateContextTokens, estimateMessageTokens } from './microCompact.js'
import { projectRewoundWindows } from './checkpointRewind.js'
import { getCompactPrompt, getCompactUserSummaryMessage, getPartialCompactPrompt, renderFoldedWork, SUMMARY_SECTION_TITLES } from './prompt.js'
import { computeVerbatimRecentTail, FOLDED_RESULT_KEY, foldLandingCeiling, foldableResults, foldedResultPlaceholder, isMercuryCompactKeepTailEnabled, withFoldedResults } from './verbatimTail.js'
import { operatorTextOf, selectOperatorMessages } from './operatorMessages.js'
import { prepareFoldContext } from './foldTransaction.js'
import { renderFoldMemory, retireFoldToMemory } from './foldRetirement.js'
import { carryFoldPrefix } from './cacheEpoch.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'
import type { CompactProgressEvent } from '../../Tool.js'
import {
  FOLD_STAMP_THROTTLE_MS,
  type FoldExit,
  type FoldStatusV1,
  type FoldTrigger,
  beginFoldStatus,
  foldStatusExit,
  foldStatusOnEvent,
} from './foldStatus.js'


void notifyCompaction


export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.'
export const ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD = 'Compaction cannot bring the context under its threshold'
export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'This conversation could not be folded: the summariser itself was refused as too long even for its smallest part. Start a fresh conversation with /clear, or switch to a model with a larger context window and run /compact again.'
export const ERROR_MESSAGE_USER_ABORT = 'Compaction cancelled.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction was interrupted before a summary arrived — likely a network issue; try again.'

const PTL_RETRY_LIMIT = 3
const NO_SUMMARY_RETRY_LIMIT = 2
const SUMMARISER_WINDOW_SHARE = 0.85
const SUMMARISER_BUDGET_FLOOR_TOKENS = 2_000
const SHAPED_RESULTS_KEEP_TOKENS = 50_000
const SHAPED_RESULT_PREVIEW_CHARS = 2_000
const SPLIT_STAND_IN_FLOOR_TOKENS = 500
const SPLIT_STAND_IN_LANDING_SHARE = 4
const PROVIDER_FINISH_FAULT_PREFIX = 'finish:'
const PROVIDER_TERMINATION_NOTE = /^\[[a-z0-9_-]+\] the provider ended this response\b/i
export const ERROR_MESSAGE_NO_SUMMARY = 'The summariser produced no summary'
export const PROSE_SKIPPED_KEY = 'The prose summary was skipped'
const PART_SUMMARY_MARKER = '[earlier turns folded into this summary for the compaction]'
const PART_TEXT_CHUNK_CHARS = 40_000
const PART_TEXT_CHUNK_FLOOR_CHARS = 2_000
export const MODEL_REFUSAL_STOP_KEY = 'stop_reason: refusal'
const PTL_TRUNCATION_MARKER = '[earlier turns folded for the compaction retry]'
const LEGACY_PTL_TRUNCATION_MARKER = '[earlier conversation truncated for compaction retry]'
const KEEPALIVE_INTERVAL_MS = 30_000
const DEGRADED_SUMMARY_LENGTH = 80

function isOverflowAnswer(row: AssistantMessage): boolean {
  return overflowSignalOf(row) !== null || (getAssistantMessageText(row) ?? '').startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)
}

const PAIRING_COMPLAINTS: readonly RegExp[] = [
  /\bno tool output found for function call\b/i,
  /\bno tool call found for function call output\b/i,
  /\btool_use\b[^.]{0,80}\bwithout\b[^.]{0,80}\btool_result\b/i,
  /\btool_result\b[^.]{0,80}\bwithout\b[^.]{0,80}\btool_use\b/i,
  /\bunexpected\b[^.]{0,40}\btool_use_id\b/i,
  /\btool_use\b[^.]{0,40}\bids? must be unique\b/i,
  /\btool_call_ids?\b[^.]{0,120}\b(?:did not have|without)\b[^.]{0,80}\bresponse/i,
  /\brole 'tool'\b[^.]{0,80}\bmust be a response to\b/i,
  /\bduplicate\b[^.]{0,60}\b(?:call_id|call id|function call id|tool_call_id)\b/i,
]

function providerSentencesOf(row: AssistantMessage): Array<{ words: string; status?: number }> {
  const out: Array<{ words: string; status?: number }> = []
  if (typeof row.errorDetails === 'string' && row.errorDetails.trim() !== '') out.push({ words: row.errorDetails })
  const text = getAssistantMessageText(row) ?? ''
  const prefix = `${API_ERROR_MESSAGE_PREFIX}: `
  let words = text.startsWith(prefix) ? text.slice(prefix.length) : text
  let status: number | undefined
  const spelled = /^(\d{3})\s+/.exec(words)
  if (spelled) {
    status = Number(spelled[1])
    words = words.slice(spelled[0].length)
  }
  const body = words.indexOf('{')
  if (body >= 0) {
    try {
      const parsed = JSON.parse(words.slice(body)) as { error?: { message?: unknown }; message?: unknown }
      const message = parsed.error?.message ?? parsed.message
      if (typeof message === 'string' && message.trim() !== '') words = message
    } catch {
    }
  }
  out.push(status !== undefined ? { words, status } : { words })
  return out
}

export function malformedHistoryRefusalOf(row: AssistantMessage): string | null {
  if (row.isApiErrorMessage !== true) return null
  if (overflowSignalOf(row) !== null) return null
  const text = getAssistantMessageText(row) ?? ''
  const sentences = providerSentencesOf(row)
  const invalidRequest =
    row.error === 'invalid_request' ||
    /\binvalid_request_error\b/.test(text) ||
    sentences.some(sentence => sentence.status === 400)
  if (!invalidRequest) return null
  const complaint = sentences.find(sentence => PAIRING_COMPLAINTS.some(pattern => pattern.test(sentence.words)))
  return complaint === undefined ? null : complaint.words
}

export function compactionRefusedForHistoryText(providerWords: string, opts: { nonInteractive: boolean }): string {
  const remedy = opts.nonInteractive
    ? 'Start a fresh run, or pass --model with a larger window.'
    : '/compact tries again after the history heals, /clear starts fresh, or /model picks a model with a larger window.'
  return `Compaction was refused for a malformed history — ${providerWords} ${remedy}`
}

export function compactionPausedForHistoryText(providerWords: string, opts: { nonInteractive: boolean }): string {
  return `${compactionRefusedForHistoryText(providerWords, opts)} Automatic compaction is paused for the rest of this run.`
}

export function foldRemedyIsHeadless(isNonInteractiveSession: boolean | undefined): boolean {
  return isNonInteractiveSession === true && !canAnswerAsks()
}

export const FOLD_WINDOW_REFUSAL_KEY = "the fold cannot run on this model's window"

export function foldWindowRefusalText(facts: { window: number; sourceWords: string; estTokens: number; remedy: string }): string {
  return `${FOLD_WINDOW_REFUSAL_KEY} (${facts.window.toLocaleString('en-US')} tokens, ${facts.sourceWords}): its own request (≈${Math.round(facts.estTokens / 1000)}k tokens) does not fit and the server would silently truncate it. ${facts.remedy}.`
}

export class CompactionRefusedForHistoryError extends Error {
  readonly providerWords: string
  readonly nonInteractive: boolean
  constructor(providerWords: string, opts: { nonInteractive: boolean }) {
    super(compactionRefusedForHistoryText(providerWords, opts))
    this.name = 'CompactionRefusedForHistoryError'
    this.providerWords = providerWords
    this.nonInteractive = opts.nonInteractive
  }
}
const FOLD_STALL_MS = 120_000

export const ERROR_MESSAGE_FOLD_TIMEOUT =
  'The summary call stalled and was stopped; the conversation is unchanged. Try again, or start fresh with /clear.'

export type FoldBounds = { stallMs: number; ingestMsPer1kTokens: number }

let foldBoundsOverride: { stallMs: number; ingestMsPer1kTokens?: number } | null = null
export function setFoldBoundsForTests(bounds: { stallMs: number; ingestMsPer1kTokens?: number } | null): void {
  foldBoundsOverride = bounds
}

function foldBounds(): FoldBounds {
  return {
    stallMs: foldBoundsOverride?.stallMs ?? FOLD_STALL_MS,
    ingestMsPer1kTokens: foldBoundsOverride?.ingestMsPer1kTokens ?? COLD_INGEST_MS_PER_1K_TOKENS,
  }
}

export function foldStallMsFor(model: string, floorMs: number = FOLD_STALL_MS): number {
  const verdict = classifyModelRoute(model)
  return Math.max(floorMs, streamIdleTimeoutMsForRoute(verdict.kind === 'route' ? verdict.route : null))
}

function foldStallAfterFirstEventMs(model: string): number {
  return foldBoundsOverride === null ? foldStallMsFor(model) : foldBoundsOverride.stallMs
}

export function foldFirstByteAllowanceMs(estTokens: number, bounds: FoldBounds = foldBounds()): number {
  const tokens = Number.isFinite(estTokens) && estTokens > 0 ? estTokens : 0
  return bounds.stallMs + Math.round((tokens / 1000) * bounds.ingestMsPer1kTokens)
}

export type FoldCut = 'silence'

type FoldBound = {
  controller: AbortController
  signal: AbortSignal
  touch(): void
  content(): void
  request(): void
  hitDeadline(): boolean
  cutBy(): FoldCut | null
  dispose(): void
}

function armFoldBound(parent: AbortSignal, road: WireFoldRow['road'], estTokens: number, model: string, cold: boolean): FoldBound {
  const stallMs = foldStallAfterFirstEventMs(model)
  const transportFirstByteMs = foldBoundsOverride === null ? firstByteBudgetMs({ cold, promptTokens: estTokens, idleMs: stallMs }) : 0
  const firstByteMs = Math.max(stallMs, foldFirstByteAllowanceMs(estTokens), transportFirstByteMs)
  const controller = new AbortController()
  let timedOut = false
  let contentSeen = false
  const onParentAbort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const expire = (): void => {
    if (timedOut) return
    timedOut = true
    controller.abort()
  }
  let stall: NodeJS.Timeout | null = setTimeout(expire, firstByteMs)
  stall.unref?.()
  const rearm = (): void => {
    if (stall !== null) clearTimeout(stall)
    stall = setTimeout(expire, contentSeen ? stallMs : firstByteMs)
    stall.unref?.()
  }
  logForDebugging(`compact: ${road} lane bound armed — first-byte allowance ${firstByteMs} ms for ≈${Math.round(estTokens)} tokens, stall ${stallMs} ms after the first event (${cold ? 'cold' : 'warm'} prefix)`)
  return {
    controller,
    signal: controller.signal,
    touch: rearm,
    content(): void {
      contentSeen = true
      rearm()
    },
    request(): void {
      contentSeen = false
      rearm()
    },
    hitDeadline: () => timedOut,
    cutBy: () => timedOut ? 'silence' : null,
    dispose(): void {
      if (stall !== null) clearTimeout(stall)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

function foldCutWords(_bound: FoldBound): string {
  return 'silence on the wire'
}

export function shouldRideCacheSharingFork(model: string, _thinkingConfig?: { type: string }): boolean {
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'absence') return false
  if (verdict.kind === 'unrecognised') return true
  return verdict.route === 'anthropic'
}

export function foldFamilyOf(model: string): string {
  const verdict = classifyModelRoute(model)
  return verdict.kind === 'route' ? verdict.route : verdict.kind
}

function recordFoldRoad(
  model: string,
  road: WireFoldRow['road'],
  startedAt: number,
  outcome: WireFoldRow['outcome'],
  detail?: string,
): void {
  recordWireFoldRow({
    family: foldFamilyOf(model),
    road,
    model,
    outcome,
    ms: Date.now() - startedAt,
    ...(detail !== undefined ? { detail } : {}),
  })
}


export type CompactionResult = {
  boundaryMarker: SystemCompactBoundaryMessage
  operatorMessages?: AttachmentMessage
  summaryMessages: UserMessage[]
  messagesToKeep?: Message[]
  attachments: AttachmentMessage[]
  hookResults: Message[]
  preCompactTokenCount: number
  postCompactTokenCount: number
  truePostCompactTokenCount?: number
  compactionUsage?: NonNullableUsage
  notes?: string[]
}

export type RecompactionInfo = {
  isRecompaction: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: string
}


export function buildPostCompactMessages(result: CompactionResult): Message[] {
  const { boundaryMarker, operatorMessages, summaryMessages, messagesToKeep, attachments, hookResults } = result
  return [
    boundaryMarker,
    ...(operatorMessages !== undefined ? [operatorMessages] : []),
    ...summaryMessages,
    ...(messagesToKeep ?? []),
    ...attachments,
    ...hookResults,
  ]
}

export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: Message[],
): SystemCompactBoundaryMessage {
  if (messagesToKeep.length === 0) return boundary
  const head = messagesToKeep[0] as Message
  const tail = messagesToKeep[messagesToKeep.length - 1] as Message
  boundary.compactMetadata.preservedSegment = {
    headUuid: head.uuid,
    anchorUuid,
    tailUuid: tail.uuid,
  }
  return boundary
}

export function foldedWorkOf(messages: Message[], kept: Message[], summaryUuid: UUID): NonNullable<CompactMetadata['work']> {
  return {
    receipts: foldedTurnReceipts(messages, kept, summaryUuid, getMercuryTempDir()),
    recap: collectAwayWork(messages, new Set(kept.map(message => message.uuid))),
  }
}

export function annotateBoundaryWithWork(
  boundary: SystemCompactBoundaryMessage,
  messages: Message[],
  kept: Message[],
  summaryUuid: UUID,
): void {
  boundary.compactMetadata.work = foldedWorkOf(messages, kept, summaryUuid)
}

export function mergeHookInstructions(
  userInstructions?: string,
  hookInstructions?: string,
): string | undefined {
  const user = userInstructions?.trim() ?? ''
  const hook = hookInstructions?.trim() ?? ''
  if (user !== '' && hook !== '') return `${user}\n\n${hook}`
  if (user !== '') return user
  if (hook !== '') return hook
  return undefined
}

function isPtlMarkerMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const user = message as UserMessage
  return (
    user.isMeta === true &&
    (user.message.content === PTL_TRUNCATION_MARKER || user.message.content === LEGACY_PTL_TRUNCATION_MARKER)
  )
}

export function isCompactCapsuleMessage(message: Message): boolean {
  return (
    isCompactBoundaryMessage(message) ||
    (message.type === 'user' && (message as UserMessage).isCompactSummary === true)
  )
}

export function truncateHeadForPTLRetry(messages: Message[], ptlResponse: Message): Message[] | null {
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const shedTokensOf = (group: Message[]): number =>
    estimateMessageTokens(group.filter(message => !isCompactCapsuleMessage(message)))

  const signal = overflowSignalOf(ptlResponse)
  const gap = getPromptTooLongTokenGap(ptlResponse) ?? (signal !== null ? overflowGapTokens(signal) : undefined)
  let dropCount: number
  if (gap !== undefined) {
    dropCount = 0
    let freed = 0
    while (dropCount < groups.length && freed < gap) {
      freed += shedTokensOf(groups[dropCount] as Message[])
      dropCount++
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }
  dropCount = Math.min(dropCount, groups.length - 1)
  while (dropCount > 0 && dropCount < groups.length - 1 && groups.slice(0, dropCount).flat().every(isCompactCapsuleMessage)) {
    dropCount++
  }
  if (dropCount <= 0) return null

  const dropped = groups.slice(0, dropCount).flat()
  const retained = dropped.filter(isCompactCapsuleMessage)
  if (retained.length === dropped.length) return null

  const survivors = groups.slice(dropCount).flat()
  if (survivors.length > 0 && survivors[0]?.type === 'assistant') {
    return [...retained, createUserMessage({ content: PTL_TRUNCATION_MARKER, isMeta: true }), ...survivors]
  }
  return [...retained, ...survivors]
}

export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) return message
    let touched = false
    const mapBlock = (block: unknown): unknown => {
      const record = block as { type?: string; content?: unknown }
      if (record.type === 'image') {
        touched = true
        return { type: 'text', text: '[image]' }
      }
      if (record.type === 'document') {
        touched = true
        return { type: 'text', text: '[document]' }
      }
      if (record.type === 'tool_result' && Array.isArray(record.content)) {
        const inner = record.content.map(mapBlock)
        return touched ? { ...record, content: inner } : block
      }
      return block
    }
    const rebuilt = content.map(mapBlock)
    if (!touched) return message
    return { ...message, message: { ...(message as UserMessage).message, content: rebuilt } } as Message
  })
}

export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages
}

export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny',
    message: 'Tool use is not allowed during compaction.',
    decisionReason: {
      type: 'other',
      reason: 'The compaction agent should only produce a text summary.',
    },
  })
}


function shouldExcludeFromPostCompactRestore(filename: string): boolean {
  const normalizedFilename = expandPath(filename)
  if (isInstructionFilePath(normalizedFilename)) return true
  try {
    const memoryPaths = MEMORY_TYPE_VALUES.map(memoryType => expandPath(getMemoryPath(memoryType)))
    if (memoryPaths.includes(normalizedFilename)) return true
  } catch {
  }
  return false
}

function collectPreservedReadPaths(preserved: Message[]): Set<string> {
  const stubToolUseIds = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'user') continue
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; tool_use_id?: string; content?: unknown }
      if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') continue
      const text =
        typeof record.content === 'string'
          ? record.content
          : Array.isArray(record.content)
            ? record.content.map(item => String((item as { text?: unknown }).text ?? '')).join('')
            : ''
      if (text.includes(FILE_UNCHANGED_STUB) || text.startsWith(FOLDED_RESULT_KEY) || text.startsWith(REPEATED_RESULT_TAG)) stubToolUseIds.add(record.tool_use_id)
    }
  }
  const paths = new Set<string>()
  for (const message of preserved) {
    if (message.type !== 'assistant') continue
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; id?: string; name?: string; input?: { file_path?: unknown } }
      if (record.type !== 'tool_use' || record.name !== FILE_READ_TOOL_NAME) continue
      if (typeof record.id === 'string' && stubToolUseIds.has(record.id)) continue
      const filePath = record.input?.file_path
      if (typeof filePath === 'string') paths.add(expandPath(filePath))
    }
  }
  return paths
}

export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  const preservedReads = collectPreservedReadPaths(preservedMessages)
  const candidates = Object.entries(readFileState)
    .filter(([path]) => !shouldExcludeFromPostCompactRestore(path))
    .filter(([path]) => !preservedReads.has(expandPath(path)))
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles)

  const generated = await Promise.all(
    candidates.map(([path]) =>
      generateFileAttachment(path, toolUseContext, 'compact', {
        limit: POST_COMPACT_MAX_TOKENS_PER_FILE,
      }).catch(() => null),
    ),
  )

  const results: AttachmentMessage[] = []
  let total = 0
  for (const attachment of generated) {
    if (attachment === null) continue
    const message = createAttachmentMessage(attachment)
    const estimate = roughTokenCountEstimation(JSON.stringify(message))
    if (total + estimate > POST_COMPACT_TOKEN_BUDGET) continue
    total += estimate
    results.push(message)
  }
  return results
}

const SKILL_TRUNCATION_MARKER =
  '\n\n[Skill content truncated for compaction — Read the skill path above for the full text.]'

function truncateToTokenCeiling(
  content: string,
  maxTokens: number,
  marker: string,
): { content: string; truncated: boolean } {
  const budget = maxTokens * 4 - marker.length
  if (content.length <= budget) return { content, truncated: false }
  return { content: content.slice(0, Math.max(0, budget)) + marker, truncated: true }
}

function truncateSkillContent(content: string, maxTokens: number): { content: string; truncated: boolean } {
  return truncateToTokenCeiling(content, maxTokens, SKILL_TRUNCATION_MARKER)
}


const POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES = ['file', 'compact_file_reference', 'invoked_skills'] as const

export type PostCompactFit = {
  result: CompactionResult
  estimate: number
  shed: string[]
}

function describeAttachment(message: AttachmentMessage): string {
  const attachment = message.attachment as { type: string; filename?: string }
  if (attachment.type === 'file' || attachment.type === 'compact_file_reference') return `file ${attachment.filename ?? '?'}`
  if (attachment.type === 'compact_operator_messages') return 'operator messages'
  return attachment.type
}

export function fitPostCompactUnderThreshold(result: CompactionResult, threshold: number, count = estimateContextTokens): PostCompactFit {
  let current = result
  let estimate = count(buildPostCompactMessages(current))
  const shed: string[] = []
  for (const kind of POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES) {
    while (estimate >= threshold) {
      let victim = -1
      let victimSize = -1
      current.attachments.forEach((message, index) => {
        if (message.attachment.type !== kind) return
        const size = estimateContextTokens([message])
        if (size > victimSize) {
          victim = index
          victimSize = size
        }
      })
      if (victim < 0) break
      shed.push(describeAttachment(current.attachments[victim] as AttachmentMessage))
      current = { ...current, attachments: current.attachments.filter((_, index) => index !== victim) }
      estimate = count(buildPostCompactMessages(current))
    }
    if (estimate < threshold) break
  }
  return { result: current, estimate, shed }
}

function obligationsOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: the fold's fixed material (${estimate} tokens: the system prompt and the tool definitions this ` +
    `request carries, this stretch's operator messages and the fold ledger) exceeds the window's ceiling (${threshold} tokens, the fold threshold) — ` +
    `no fold can land here, so no summary was requested and the original context is kept whole; nothing moved. Start a fresh conversation with /clear, ` +
    `or seat a model with a larger window.`
  )
}

function postCompactOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: with every restorable attachment dropped, the summary, ` +
    `the kept tail and the session-start hook output still estimate ${estimate} tokens against a ` +
    `${threshold}-token threshold. The original context is kept whole; nothing moved. Start a fresh conversation with /clear, or trim the hook output.`
  )
}

export function createSkillAttachmentIfNeeded(
  agentId?: string,
  catalogue?: ReadonlyArray<{ name: string }>,
): AttachmentMessage | null {
  const invoked = getInvokedSkillsForAgent(agentId)
  if (invoked.size === 0) return null
  const inCatalogue = (name: string): boolean => catalogue === undefined || catalogue.some(command => command.name === name)
  const sorted = [...invoked.values()]
    .filter(skill => {
      if (inCatalogue(skill.skillName)) return true
      logForDebugging(`compact: invoked skill ${skill.skillName} left the catalogue — not re-injected`)
      return false
    })
    .sort((a, b) => b.invokedAt - a.invokedAt)
  const skills: Array<{ name: string; path: string; content: string }> = []
  let total = 0
  for (const skill of sorted) {
    const { content } = truncateSkillContent(skill.content, POST_COMPACT_MAX_TOKENS_PER_SKILL)
    const estimate = roughTokenCountEstimation(content)
    if (total + estimate > POST_COMPACT_SKILLS_TOKEN_BUDGET) continue
    total += estimate
    skills.push({ name: skill.skillName, path: skill.skillPath, content })
  }
  if (skills.length === 0) return null
  return createAttachmentMessage({ type: 'invoked_skills', skills })
}

export async function createAsyncAgentAttachmentsIfNeeded(context: ToolUseContext): Promise<AttachmentMessage[]> {
  const state = context.getAppState()
  return getAgentRosterAttachment({
    tasks: state.tasks,
    agentNameRegistry: state.agentNameRegistry,
    excludeAgentId: context.agentId,
    queuedNoticeIds: queuedNoticeTaskIds(getCommandQueue()),
  }).map(createAttachmentMessage)
}


async function withKeepAlive<T>(context: ToolUseContext, work: () => Promise<T>): Promise<T> {
  let interval: NodeJS.Timeout | null = null
  if (isSessionActivityTrackingActive()) {
    interval = setInterval(() => {
      sendSessionActivitySignal()
      context.setSDKStatus?.('compacting')
    }, KEEPALIVE_INTERVAL_MS)
    interval.unref()
  }
  try {
    return await work()
  } finally {
    if (interval !== null) clearInterval(interval)
  }
}

async function summarizeViaCacheSharingFork(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage | null> {
  const model = context.options.engineModel
  const bound = armFoldBound(context.abortController.signal, 'fork', tokenCountWithEstimation(messages), model, coldPrefixOf(messages, model))
  const startedAt = Date.now()
  try {
    context.setResponseLength?.(() => 0)
    const result = await runForkedAgent({
      promptMessages: [promptMessage],
      cacheSafeParams: { ...cacheSafeParams, toolUseContext: context, forkContextMessages: messages },
      canUseTool: createCompactCanUseTool(),
      querySource: 'compact' as never,
      forkLabel: 'compact',
      maxTurns: 1,
      skipCacheWrite: true,
      onStreamEvent: event => {
        bound.content()
        const inner = event as { type?: string; delta?: { type?: string; text?: string } }
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const length = inner.delta.text?.length ?? 0
          context.setResponseLength?.(prev => prev + length)
        }
      },
      overrides: {
        agentId: context.agentId,
        abortController: bound.controller,
        setSDKStatus: status => {
          if (typeof status === 'object' && status !== null && 'streamActivity' in status) bound.touch()
          context.setSDKStatus?.(status)
        },
        getAppState: () => {
          const state = context.getAppState()
          return state.toolPermissionContext.shouldAvoidPermissionPrompts
            ? state
            : {
                ...state,
                toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
              }
        },
      },
    })
    if (bound.hitDeadline()) {
      const elapsedMs = Date.now() - startedAt
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsedMs} ms mid-stream — its partial output is discarded; handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsedMs} ms (partial output discarded)`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    const last = [...result.messages].reverse().find(message => message.type === 'assistant') as
      | AssistantMessage
      | undefined
    if (last !== undefined && last.isApiErrorMessage !== true) {
      const text = getAssistantMessageText(last)
      if (text !== null && text !== '') {
        recordFoldRoad(model, 'fork', startedAt, 'summary')
        return last
      }
    }
    if (last !== undefined && isOverflowAnswer(last)) {
      recordFoldRoad(model, 'fork', startedAt, 'overflow')
      return last
    }
    if (last !== undefined && summaryRefusedByModel(last)) {
      recordFoldRoad(model, 'fork', startedAt, 'refused')
      return last
    }
    if (last !== undefined) {
      const malformed = malformedHistoryRefusalOf(last)
      if (malformed !== null) {
        recordFoldRoad(model, 'fork', startedAt, 'refused', malformed.slice(0, 160))
        throw new CompactionRefusedForHistoryError(malformed, {
          nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
        })
      }
    }
    logForDebugging(`compact: fork path produced no usable summary: ${JSON.stringify(result.messages).slice(0, 500)}`, {
      level: 'warn',
    })
    recordFoldRoad(model, 'fork', startedAt, 'handover', 'no usable summary')
    return null
  } catch (err) {
    if (err instanceof CompactionRefusedForHistoryError) throw err
    const elapsedMs = Date.now() - startedAt
    if (bound.hitDeadline()) {
      logForDebugging(`compact: fork lane hit its fold bound (${foldCutWords(bound)}) after ${elapsedMs} ms — handing over to the direct call`, { level: 'warn' })
      recordFoldRoad(model, 'fork', startedAt, 'handover', `fold bound after ${elapsedMs} ms`)
      return null
    }
    if (context.abortController.signal.aborted) {
      recordFoldRoad(model, 'fork', startedAt, 'aborted')
      return null
    }
    logError(err)
    logForDebugging(`compact: fork lane failed after ${elapsedMs} ms — handing over to the direct call: ${err instanceof Error ? err.message : String(err)}`, { level: 'warn' })
    recordFoldRoad(model, 'fork', startedAt, 'handover', (err instanceof Error ? err.message : String(err)).slice(0, 160))
    return null
  } finally {
    bound.dispose()
  }
}

async function summarizeViaStreamingFallback(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
): Promise<AssistantMessage> {
  const model = context.options.engineModel
  const bound = armFoldBound(context.abortController.signal, 'direct', tokenCountWithEstimation(messages), model, coldPrefixOf(messages, model))
  const startedAt = Date.now()
  try {
    const settled = await streamingFallbackAttempts(messages, cacheSafeParams, promptMessage, context, bound)
    recordFoldRoad(model, 'direct', startedAt, settled.isApiErrorMessage === true ? 'refused' : 'summary')
    return settled
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === ERROR_MESSAGE_FOLD_TIMEOUT) {
      logForDebugging(`compact: direct lane cut for ${foldCutWords(bound)} after ${Date.now() - startedAt} ms — nothing folded`, { level: 'warn' })
    }
    recordFoldRoad(
      model,
      'direct',
      startedAt,
      message === ERROR_MESSAGE_FOLD_TIMEOUT
        ? 'timeout'
        : message === ERROR_MESSAGE_INCOMPLETE_RESPONSE
          ? 'incomplete'
          : context.abortController.signal.aborted || err instanceof APIUserAbortError
            ? 'aborted'
            : 'refused',
      message.slice(0, 160),
    )
    throw err
  } finally {
    bound.dispose()
  }
}

async function streamingFallbackAttempts(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  bound: FoldBound,
): Promise<AssistantMessage> {
  const attempts = 1
  const model = context.options.engineModel
  let streamingStarted = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    streamingStarted = false
    context.setResponseLength?.(() => 0)
    const toolSearchEnabled = await isToolSearchEnabled(
      model,
      context.options.tools,
      () => Promise.resolve(context.getAppState().toolPermissionContext),
      context.options.agentDefinitions.activeAgents,
      'compact',
    )
    const toolMap = new Map<string, (typeof context.options.tools)[number]>()
    for (const tool of context.options.tools) {
      if (!toolMap.has(tool.name)) toolMap.set(tool.name, tool)
    }
    if (toolMap.size === 0) {
      toolMap.set(FileReadTool.name, FileReadTool)
      if (toolSearchEnabled) toolMap.set(ToolSearchTool.name, ToolSearchTool)
    }
    const tools = [...toolMap.values()]

    const afterBoundary = (() => {
      const index = findLastCompactBoundaryIndex(messages)
      const sliced = index >= 0 ? messages.slice(index + 1) : messages
      return projectRewoundWindows(sliced)
    })()
    const continuation = continuationOfSentRequest(
      lastSentRequestFor(String(rosterOwnerFromToolUseContext(context))),
      afterBoundary,
    )
    if (continuation !== null && attempt === 1) {
      logForDebugging(
        `compact: direct lane re-sends the session's last request (${continuation.sent.length} rows) + ${continuation.tail.length} newer row(s) + the prompt`,
      )
    }
    const apiMessages: Message[] = continuation !== null
      ? [...continuation.sent, ...continuation.tail, promptMessage]
      : [...afterBoundary, promptMessage]

    let captured: AssistantMessage | undefined
    bound.request()
    const stream = routedCallModel({
      messages: apiMessages,
      systemPrompt: asSystemPrompt(appendSystemContext([...cacheSafeParams.systemPrompt], cacheSafeParams.systemContext ?? {})),
      thinkingConfig: context.options.thinkingConfig,
      tools,
      signal: bound.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(context.getAppState().toolPermissionContext),
        model,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: Boolean(context.options.appendSystemPrompt),
        querySource: 'compact' as never,
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        effortValue: context.getAppState().effortValue,
        agentId: context.agentId,
        onWait: wait => context.setSDKStatus?.({ wait }),
        onStreamActivity: atMs => {
          bound.touch()
          context.setSDKStatus?.({ streamActivity: atMs })
        },
        ownerKey: String(rosterOwnerFromToolUseContext(context)),
      },
    })
    try {
      for await (const event of stream) {
        bound.content()
        if (event.type === 'stream_event') {
          const inner = event.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } }
          if (inner.type === 'content_block_start' && inner.content_block?.type === 'text') {
            streamingStarted = true
            context.setStreamMode?.('responding')
          }
          if (inner.type === 'content_block_delta' && (inner.delta?.type === 'text_delta' || inner.delta?.type === 'thinking_delta')) {
            const length = (inner.delta.type === 'thinking_delta' ? inner.delta.thinking : inner.delta.text)?.length ?? 0
            context.setResponseLength?.(prev => prev + length)
          }
        } else if (event.type === 'assistant') {
          captured = event
        }
      }
    } catch (err) {
      if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
      throw err
    }
    if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
    if (bound.signal.aborted) throw new APIUserAbortError()
    if (captured?.isApiErrorMessage === true) {
      if (summaryAnswerFault(captured) !== null) return captured
      if (!isOverflowAnswer(captured) && !summaryRefusedByModel(captured)) {
        const malformed = malformedHistoryRefusalOf(captured)
        if (malformed !== null) {
          throw new CompactionRefusedForHistoryError(malformed, {
            nonInteractive: foldRemedyIsHeadless(context.options.isNonInteractiveSession),
          })
        }
        const fit = localFitRefusalFacts(getAssistantMessageText(captured) ?? '')
        if (fit !== null) {
          throw new Error(foldWindowRefusalText({ window: fit.window, sourceWords: fit.sourceWords, estTokens: fit.estTokens, remedy: LOCAL_WINDOW_REMEDY }))
        }
        throw new Error(getAssistantMessageText(captured) ?? ERROR_MESSAGE_INCOMPLETE_RESPONSE)
      }
    }
    if (captured !== undefined) return captured
    if (attempt < attempts) {
      await sleep(getRetryDelay(attempt), bound.signal).catch(() => {
        if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
        throw new APIUserAbortError()
      })
      continue
    }
    logForDebugging(
      `compact: streaming fallback produced no response after ${attempts} attempt(s) (streaming started: ${streamingStarted})`,
      { level: 'error' },
    )
  }
  throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
}

async function runSummarization(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptMessage: UserMessage,
  context: ToolUseContext,
  directOnly = false,
): Promise<AssistantMessage> {
  return withKeepAlive(context, async () => {
    if (
      !directOnly &&
      shouldRideCacheSharingFork(context.options.engineModel, context.options.thinkingConfig)
    ) {
      const viaFork = await summarizeViaCacheSharingFork(messages, cacheSafeParams, promptMessage, context)
      if (viaFork !== null) return viaFork
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
    }
    return summarizeViaStreamingFallback(messages, cacheSafeParams, promptMessage, context)
  })
}

function summaryRefused(response: AssistantMessage): boolean {
  const text = getAssistantMessageText(response) ?? ''
  return text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) || overflowSignalOf(response) !== null
}

function overflowGapOf(response: AssistantMessage): number | undefined {
  const signal = overflowSignalOf(response)
  return getPromptTooLongTokenGap(response) ?? (signal !== null ? overflowGapTokens(signal) : undefined)
}

type FoldLadder = { noSummaryRetries: number; budgetTokens?: number }

function newFoldLadder(budgetTokens?: number): FoldLadder {
  return { noSummaryRetries: 0, ...(budgetTokens !== undefined ? { budgetTokens } : {}) }
}

function withSummariserThinkingOff<C extends ToolUseContext>(context: C): C {
  return { ...context, options: { ...context.options, thinkingConfig: { type: 'disabled' } } }
}

export function summaryAnswerFault(response: AssistantMessage): string | null {
  if (response.isApiErrorMessage === true) {
    const details = typeof response.errorDetails === 'string' ? response.errorDetails : ''
    return details.startsWith(PROVIDER_FINISH_FAULT_PREFIX) ? `the provider ended the response before a summary (finish reason ${details.slice(PROVIDER_FINISH_FAULT_PREFIX.length)})` : null
  }
  const stop = response.message.stop_reason
  if (stop == null) return null
  const blocks = Array.isArray(response.message.content) ? (response.message.content as Array<{ type?: string }>) : []
  const thinking = blocks.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking').length
  const calls = blocks.filter(block => block.type === 'tool_use').length
  const text = getAssistantMessageText(response) ?? ''
  const thinkingWords = `${thinking} thinking block${thinking === 1 ? '' : 's'}`
  if (stop === 'max_tokens') return `the answer hit its output limit before a summary (stop reason max_tokens; ${text.length} characters of text, ${thinkingWords})`
  if (text === '') return `the answer had no text (stop reason ${stop}; ${thinkingWords}, ${calls} tool call${calls === 1 ? '' : 's'})`
  const body = summaryBody(text)
  if (!/[\p{L}\p{N}]/u.test(body)) return `the answer carried no words (${text.length} characters of wrapper or punctuation)`
  if (PROVIDER_TERMINATION_NOTE.test(body)) return `the provider ended the response before a summary: ${JSON.stringify(body.slice(0, 120))}`
  if (summarySaysNothing(body)) return "the answer carried the summary's headings and nothing under them"
  if (summaryRefusesInProse(body)) return `the answer refused in prose: ${JSON.stringify(body.slice(0, 120))}`
  return null
}

function foldLadderExhausted(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.startsWith(ERROR_MESSAGE_PROMPT_TOO_LONG) || error.message.startsWith(ERROR_MESSAGE_NO_SUMMARY)
}

function overflowExhaustedWords(gap: number | undefined): string {
  return `the last part sent was refused over the window${gap !== undefined && gap > 0 ? ` by ${gap.toLocaleString('en-US')} tokens` : ''}`
}

function proseSkippedNote(cause: string): string {
  const why = cause.startsWith(`${ERROR_MESSAGE_NO_SUMMARY}: `)
    ? cause.slice(ERROR_MESSAGE_NO_SUMMARY.length + 2)
    : cause.startsWith(ERROR_MESSAGE_PROMPT_TOO_LONG)
      ? `the summariser was refused as too long even for its smallest part${cause.slice(ERROR_MESSAGE_PROMPT_TOO_LONG.length).trim() === '' ? '' : ` (${cause.slice(ERROR_MESSAGE_PROMPT_TOO_LONG.length).trim().replace(/^\(|\)$/g, '')})`}`
      : cause
  return `${PROSE_SKIPPED_KEY}: ${why}.`
}

function proseSkippedLine(cause: string): string {
  return `${proseSkippedNote(cause)} The folded stretch is carried by Mercury's own records below (the run capsule, the folded work, the memory note and the fold ledger).`
}

export function summaryRefusedByModel(response: AssistantMessage): boolean {
  if (response.isApiErrorMessage !== true) return false
  const details = typeof response.errorDetails === 'string' ? response.errorDetails : ''
  return details.startsWith(MODEL_REFUSAL_STOP_KEY) || (getAssistantMessageText(response) ?? '').includes(`(${MODEL_REFUSAL_STOP_KEY})`)
}

export function isPartSummaryMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const user = message as UserMessage
  return user.isMeta === true && typeof user.message.content === 'string' && user.message.content.startsWith(PART_SUMMARY_MARKER)
}

function partCapsule(summary: string): UserMessage {
  return createUserMessage({ content: `${PART_SUMMARY_MARKER}\n\n${summary}`, isMeta: true })
}

function messageAsText(message: Message): string {
  if (message.type !== 'user' && message.type !== 'assistant') return ''
  const content = (message as UserMessage | AssistantMessage).message.content
  if (typeof content === 'string') return `${message.type}: ${content}`
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[tool call ${String(block.name)}] ${JSON.stringify(block.input)}`)
    else if (block.type === 'tool_result') {
      const inner = block.content
      const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : ''
      parts.push(`[tool result] ${text}`)
    } else if (block.type === 'image' || block.type === 'document') parts.push(`[${String(block.type)} omitted]`)
  }
  return `${message.type}: ${parts.join('\n')}`
}

export function splitTextForFold(text: string, chunkChars: number): string[] {
  const chunks: string[] = []
  for (let at = 0; at < text.length; at += chunkChars) chunks.push(text.slice(at, at + chunkChars))
  return chunks.length === 0 ? [''] : chunks
}

function partChunkChars(ladder: FoldLadder): number {
  if (ladder.budgetTokens === undefined) return PART_TEXT_CHUNK_CHARS
  return Math.min(PART_TEXT_CHUNK_CHARS, Math.max(PART_TEXT_CHUNK_FLOOR_CHARS, ladder.budgetTokens * 4))
}

async function summarizeTextInParts(
  text: string,
  chunkChars: number,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<string | null> {
  const summaries: string[] = []
  for (const chunk of splitTextForFold(text, chunkChars)) {
    const summaryContext = ladder.noSummaryRetries > 0 ? withSummariserThinkingOff(context) : context
    const response = await runSummarization([createUserMessage({ content: chunk })], cacheSafeParams, createUserMessage({ content: promptText }), summaryContext, ladder.noSummaryRetries > 0)
    if (!summaryRefused(response) && summaryAnswerFault(response) === null) {
      summaries.push(validateSummary(response, false))
      continue
    }
    if (!summaryRefused(response) && ++ladder.noSummaryRetries > NO_SUMMARY_RETRY_LIMIT) return null
    if (chunkChars <= PART_TEXT_CHUNK_FLOOR_CHARS) return null
    const narrowerChars = Math.max(PART_TEXT_CHUNK_FLOOR_CHARS, Math.floor(chunkChars / 2))
    if (chunk.length <= narrowerChars) return null
    const narrower = await summarizeTextInParts(chunk, narrowerChars, cacheSafeParams, promptText, context, ladder)
    if (narrower === null) return null
    summaries.push(narrower)
  }
  return summaries.join('\n\n')
}

async function foldAllAsText(
  input: Message[],
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[] | null> {
  const working = input.filter(message => !isCompactCapsuleMessage(message))
  if (working.length === 0) return null
  const text = working.map(messageAsText).filter(line => line !== '').join('\n\n')
  const summary = await summarizeTextInParts(text, partChunkChars(ladder), cacheSafeParams, promptText, context, ladder)
  if (summary === null) return null
  const capsule = partCapsule(summary)
  if (estimateContextTokens([capsule]) >= estimateContextTokens(working)) return null
  return [...input.filter(isCompactCapsuleMessage), capsule]
}

async function foldHeadIntoCapsule(
  messages: Message[],
  gap: number | undefined,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[] | null> {
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  const workingOf = (rows: Message[]): Message[] => rows.filter(message => !isCompactCapsuleMessage(message))
  const sizeOf = (rows: Message[]): number => estimateContextTokens(workingOf(rows))
  if (groups.length >= 2) {
    const ahead = groups.slice(0, groups.length - 1).flat()
    const coverable = gap === undefined || sizeOf(ahead) >= gap
    if (coverable && workingOf(ahead).length > 0) {
      let dropCount: number
      if (gap !== undefined) {
        dropCount = 0
        let freed = 0
        while (dropCount < groups.length - 1 && freed < gap) {
          freed += sizeOf(groups[dropCount] as Message[])
          dropCount++
        }
      } else {
        dropCount = Math.ceil(groups.length / 2)
      }
      dropCount = Math.max(1, Math.min(dropCount, groups.length - 1))
      while (dropCount < groups.length - 1 && workingOf(groups.slice(0, dropCount).flat()).length === 0) dropCount++
      const head = groups.slice(0, dropCount).flat()
      const working = workingOf(head)
      if (working.length > 0) {
        const partResponse = await summarizeWithPtlRetry(working, cacheSafeParams, promptText, context, ladder)
        const capsule = partCapsule(validateSummary(partResponse, false))
        return [...head.filter(isCompactCapsuleMessage), capsule, ...groups.slice(dropCount).flat()]
      }
    }
  }
  return foldAllAsText(input, cacheSafeParams, promptText, context, ladder)
}

async function summarizeWithPtlRetry(
  initialMessages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder = newFoldLadder(),
): Promise<AssistantMessage> {
  let messages = initialMessages
  let before = estimateContextTokens(messages)
  const bound = groupMessagesByApiRound(messages).length + PTL_RETRY_LIMIT
  let summaryContext = ladder.noSummaryRetries > 0 ? withSummariserThinkingOff(context) : context
  let fault: string | null = null
  let lastGap: number | undefined
  for (let attempt = 0; attempt <= bound; attempt++) {
    if (attempt > 0) context.onCompactProgress?.({ type: 'retry', attempt: attempt + 1 })
    const promptMessage = createUserMessage({ content: promptText })
    const response = await runSummarization(messages, cacheSafeParams, promptMessage, summaryContext, ladder.noSummaryRetries > 0)
    let folded: Message[] | null
    if (summaryRefused(response)) {
      fault = null
      lastGap = overflowGapOf(response)
      if (attempt === bound) break
      folded = await foldHeadIntoCapsule(messages, lastGap, cacheSafeParams, promptText, summaryContext, ladder)
    } else {
      fault = summaryAnswerFault(response)
      if (fault === null) return response
      if (ladder.noSummaryRetries >= NO_SUMMARY_RETRY_LIMIT || attempt === bound) break
      ladder.noSummaryRetries++
      logForDebugging(`compact: ${fault} — retrying on half the input with thinking off (retry ${ladder.noSummaryRetries} of ${NO_SUMMARY_RETRY_LIMIT})`, { level: 'warn' })
      summaryContext = withSummariserThinkingOff(context)
      folded = await foldHeadIntoCapsule(messages, undefined, cacheSafeParams, promptText, summaryContext, ladder)
    }
    if (folded === null) break
    const after = estimateContextTokens(folded)
    if (after >= before && groupMessagesByApiRound(folded).length >= groupMessagesByApiRound(messages).length) break
    before = after
    messages = folded
  }
  throw new Error(fault === null ? `${ERROR_MESSAGE_PROMPT_TOO_LONG} (${overflowExhaustedWords(lastGap)})` : `${ERROR_MESSAGE_NO_SUMMARY}: ${fault}`)
}

const REFUSAL_PREFACE = /^(?:(?:i(?:\s+am|['’]m)\s+(?:sorry|afraid)|sorry|i\s+apologi[sz]e|(?:my\s+)?apologies|unfortunately|regrettably|however|as\s+an\s+ai(?:\s+(?:language\s+model|assistant|model|system))?)[,.:!;]?\s*(?:but\s+|that\s+)?)+/i
const INABILITY = String.raw`(?:i(?:\s+am|['’]m)\s+(?:unable|not\s+(?:able|going|permitted|allowed|in\s+a\s+position))\s+to|i\s+(?:cannot|can['’]t|will\s+not|won['’]t|refuse\s+to|(?:must\s+)?decline\s+to|(?:won['’]t|will\s+not)\s+be\s+able\s+to))`
const SUMMARY_OBJECT = String.raw`(?:summari[sz]e\b|(?:provide|produce|write|create|generate|give|offer)\s+(?:(?:a|an|the|this|that|any|such|requested|detailed|complete|full)\s+){0,4}(?:summary|summari[sz]ation|record)\b|(?:fulfil|fulfill|complete|carry\s+out|perform)\s+(?:this|that|the|your)\s+(?:request|task|instruction)\b)`
const HELP_OBJECT = String.raw`(?:help|assist|comply|proceed|continue|engage|answer|respond|do\s+(?:that|this|so)\b|with\s+(?:that|this)\b)`
const NO_SUMMARY = String.raw`(?:no\s+summary\s+(?:will|can|could)\s+be\s+(?:provided|produced|generated|given)\b|(?:this|that|the)\s+(?:request|task)\s+(?:cannot|can['’]t|will\s+not|won['’]t)\s+be\s+(?:completed|fulfilled|carried\s+out)\b|that['’]s\s+not\s+something\s+i\s+can\b)`
const OPENING_REFUSAL = new RegExp(String.raw`^(?:${INABILITY}\s+(?:${SUMMARY_OBJECT}|${HELP_OBJECT})|${NO_SUMMARY})`, 'i')
const SENTENCE_REFUSAL = new RegExp(String.raw`^(?:${INABILITY}\s+${SUMMARY_OBJECT}|${NO_SUMMARY})`, 'i')
const HEDGED_REFUSAL_CEILING = 800
const SECTION_TITLE_LINE = new RegExp(String.raw`^\s*(?:#{1,6}\s*)?(?:\d{1,2}[.)]\s*)?\**(?:${SUMMARY_SECTION_TITLES.map(title => title.replace(/\s*\(optional\)$/, '').replace(/\s+/g, '\\s+')).join('|')})(?:\s*\(optional\))?\**:?\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…|[-*_]+)?\s*$`, 'i')
const PLACEHOLDER_LINE = /^\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…|[-*_]+)?\s*$/

function summaryBody(text: string): string {
  let body = text.replace(/<analysis>[\s\S]*?<\/analysis>/, '').trim()
  for (let pass = 0; pass < 3; pass++) {
    const wrapped = /<summary>([\s\S]*?)<\/summary>/.exec(body)
    const inner = (wrapped === null ? body : wrapped[1] ?? '').trim()
    const unfenced = inner.replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim()
    if (unfenced === body) break
    body = unfenced
  }
  return body.replace(/^<summary>\s*/, '').replace(/\s*<\/summary>$/, '').trim()
}

function summaryRefusesInProse(body: string): boolean {
  if (OPENING_REFUSAL.test(body.replace(REFUSAL_PREFACE, ''))) return true
  if (body.length >= HEDGED_REFUSAL_CEILING) return false
  return body.split(/(?<=[.!?])\s+|\n+/).some(sentence => SENTENCE_REFUSAL.test(sentence.replace(REFUSAL_PREFACE, '')))
}

function summarySaysNothing(body: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(body)) return true
  return body.split('\n').every(line => SECTION_TITLE_LINE.test(line) || PLACEHOLDER_LINE.test(line))
}

function validateSummary(response: AssistantMessage, logMissing: boolean): string {
  if (response.message.stop_reason == null) throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
  const text = getAssistantMessageText(response) ?? ''
  if (response.isApiErrorMessage === true || text.startsWith(API_ERROR_MESSAGE_PREFIX)) throw new Error(text === '' ? ERROR_MESSAGE_INCOMPLETE_RESPONSE : text)
  const fault = summaryAnswerFault(response)
  if (fault !== null) {
    if (logMissing) {
      logForDebugging(`compact: no summary in the response (${fault}): ${JSON.stringify(response).slice(0, 2000)}`, { level: 'error' })
    }
    throw new Error(`${ERROR_MESSAGE_NO_SUMMARY}: ${fault}`)
  }
  return text
}


function snapshotAndClearReadState(context: ToolUseContext): Record<string, { content: string; timestamp: number }> {
  const snapshot: Record<string, { content: string; timestamp: number }> = {}
  for (const [path, state] of context.readFileState.entries()) {
    snapshot[path] = { content: state.content, timestamp: state.timestamp }
  }
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()
  return snapshot
}

export function restorePreservedReads(
  context: ToolUseContext,
  ledger: Array<[string, FileState]>,
  preserved: Message[],
): string[] {
  const preservedReads = collectPreservedReadPaths(preserved)
  const restored: string[] = []
  for (const [path, state] of ledger) {
    if (!preservedReads.has(expandPath(path))) continue
    context.readFileState.set(path, state)
    restored.push(path)
  }
  return restored
}

async function assembleAttachments(
  snapshot: Record<string, { content: string; timestamp: number }>,
  context: ToolUseContext,
  preserved: Message[],
  callSite: 'compact_full' | 'compact_partial',
  ledger: Array<[string, FileState]>,
): Promise<AttachmentMessage[]> {
  const [files, asyncAgents] = await Promise.all([
    createPostCompactFileAttachments(snapshot, context, POST_COMPACT_MAX_FILES_TO_RESTORE, preserved),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])
  restorePreservedReads(context, ledger, preserved)
  const attachments: AttachmentMessage[] = [...files, ...asyncAgents]
  const skills = createSkillAttachmentIfNeeded(context.agentId, context.options.commands)
  if (skills !== null) attachments.push(skills)
  const model = context.options.engineModel
  const deltas = [
    ...getDeferredToolsDeltaAttachment(context.options.tools, model, preserved, {
      callSite,
      hasPendingMcpServers: [...context.options.mcpClients, ...(context.getAppState?.().mcp?.clients ?? [])].some(client => client.type === 'pending'),
    }),
    ...getMcpInstructionsDeltaAttachment(context.options.mcpClients, context.options.tools, model, preserved),
  ]
  for (const delta of deltas) attachments.push(createAttachmentMessage(delta))
  if (!context.agentId) {
    for (const row of await getUserContextAttachment(preserved)) {
      attachments.push(createAttachmentMessage(row))
    }
  }
  return attachments
}

function compactionHookScope(context: ToolUseContext): { sessionId: string; crewmateId?: string } {
  return { sessionId: String(getSessionId()), ...(context.agentId !== undefined ? { crewmateId: context.agentId } : {}) }
}

async function compactionBeforeHooks(context: ToolUseContext, facts: { trigger: 'manual' | 'auto' | 'overflow'; instructions?: string; tokens: number }): Promise<HookFireResult> {
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
  return fireHooks('compaction.before', { trigger: facts.trigger, ...(facts.instructions !== undefined ? { instructions: facts.instructions } : {}), tokens: facts.tokens }, { scope: compactionHookScope(context), signal: context.abortController.signal, toolUseContext: context })
}

async function compactionAfterHooks(context: ToolUseContext, facts: { method: 'summary' | 'notes' | 'digest'; trigger: 'manual' | 'auto' | 'overflow'; tokensBefore: number; tokensAfter: number; summary?: string }): Promise<Message[]> {
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'post_compact' })
  const result = await fireHooks(
    'compaction.after',
    { method: facts.method, trigger: facts.trigger, tokens_before: facts.tokensBefore, tokens_after: facts.tokensAfter, ...(facts.summary !== undefined ? { summary: facts.summary } : {}) },
    { scope: compactionHookScope(context), signal: context.abortController.signal, toolUseContext: context },
  )
  const rows: Message[] = hookRowsOfResult(result).map(row => createAttachmentMessage(row))
  for (const words of result.answer.contexts) rows.push(createUserMessage({ content: words, isMeta: true }))
  return rows
}

export { compactionAfterHooks }

function notifyCompactionError(context: ToolUseContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (message === ERROR_MESSAGE_USER_ABORT || message === ERROR_MESSAGE_NOT_ENOUGH_MESSAGES) return
  context.addNotification?.({
    key: 'compact-error',
    text: `Compaction error: ${message}`,
    color: 'error',
    priority: 'immediate',
  })
}

function restoreAfterCompaction(context: ToolUseContext, word: unknown = null): void {
  context.setStreamMode?.('requesting')
  context.setResponseLength?.(() => 0)
  context.onCompactProgress?.({ type: 'compact_end' })
  context.setSDKStatus?.(word)
}

export async function withFoldStatus<T, C extends ToolUseContext>(
  context: C,
  work: (scoped: C) => Promise<T>,
  facts: { trigger: FoldTrigger; sessionMemory: boolean; microcompaction: boolean },
): Promise<T> {
  let status: FoldStatusV1 = beginFoldStatus({ ...facts, startedAtMs: Date.now() })
  let chars = 0
  let pending: NodeJS.Timeout | null = null
  const send = (): void => {
    if (pending !== null) {
      clearTimeout(pending)
      pending = null
    }
    context.setSDKStatus?.({ compacting: status })
  }
  const stamp = (now: boolean): void => {
    if (context.setSDKStatus === undefined) return
    if (now) {
      send()
      return
    }
    if (pending !== null) return
    pending = setTimeout(send, FOLD_STAMP_THROTTLE_MS)
    pending.unref?.()
  }
  const onEvent = (event: CompactProgressEvent): void => {
    status = foldStatusOnEvent(status, event)
    stamp(event.type !== 'summary_progress')
  }
  const scoped: C = {
    ...context,
    setSDKStatus: (word: unknown) => {
      if (word === 'compacting') stamp(true)
      else if (word !== null) context.setSDKStatus?.(word)
    },
    onCompactProgress: (event: CompactProgressEvent) => {
      onEvent(event)
      context.onCompactProgress?.(event)
    },
    setResponseLength: (updater: (prev: number) => number) => {
      chars = Math.max(0, updater(chars))
      onEvent({ type: 'summary_progress', chars })
      context.setResponseLength?.(updater)
    },
  }
  stamp(true)
  let exit: FoldExit = 'landed'
  let reason: string | undefined
  try {
    return await work(scoped)
  } catch (err) {
    const aborted = context.abortController?.signal.aborted === true
    exit = aborted || err instanceof APIUserAbortError ? 'cancelled' : 'failed'
    reason = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    if (pending !== null) clearTimeout(pending)
    status = foldStatusExit(status, exit, Date.now(), reason)
    restoreAfterCompaction(context, { compacting: status })
    if (facts.trigger !== 'manual') context.setSDKStatus?.(null)
  }
}


export function withEngineModel<C extends ToolUseContext>(context: C, model: string): C {
  return { ...context, options: { ...context.options, engineModel: model } }
}

type SummariserFit = {
  budgetTokens: number
  limitTokens: number
  fixedTokens: number
  promptTokens: number
  reserveTokens: number
  window: number
  blockingLimit: number
  ratio: number
}

async function estimateFixedRequestTokens(context: ToolUseContext, cacheSafeParams: CacheSafeParams): Promise<number> {
  const system = JSON.stringify(appendSystemContext([...cacheSafeParams.systemPrompt], cacheSafeParams.systemContext ?? {}))
  let tools = 0
  try {
    const schemas = await Promise.all(
      context.options.tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: () => Promise.resolve(context.getAppState().toolPermissionContext),
          tools: context.options.tools,
          agents: context.options.agentDefinitions.activeAgents,
          allowedAgentTypes: context.options.agentDefinitions.allowedAgentTypes,
          model: context.options.engineModel,
        }),
      ),
    )
    tools = JSON.stringify(schemas).length
  } catch {
    tools = context.options.tools.length * SHAPED_RESULT_PREVIEW_CHARS
  }
  return Math.ceil((system.length + tools) / 4)
}

async function summariserFitFor(
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  gauge: ReturnType<typeof readRequestGauge>,
): Promise<SummariserFit> {
  const model = context.options.engineModel
  const window = resolveAutoCompactWindow(model).window
  const reserveTokens = Math.max(0, window - getEffectiveContextWindowSize(model))
  const blockingLimit = getBlockingLimit(model)
  const fixedTokens = gauge?.fixed.tokens ?? (await estimateFixedRequestTokens(context, cacheSafeParams))
  const promptTokens = roughTokenCountEstimation(promptText)
  const driftSafe = Math.floor(window * SUMMARISER_WINDOW_SHARE) - reserveTokens
  const budgetTokens = Math.max(SUMMARISER_BUDGET_FLOOR_TOKENS, Math.min(blockingLimit, driftSafe) - fixedTokens - promptTokens)
  const limitTokens = Math.max(budgetTokens, blockingLimit - fixedTokens - promptTokens)
  return { budgetTokens, limitTokens, fixedTokens, promptTokens, reserveTokens, window, blockingLimit, ratio: gauge?.density.ratio ?? 1 }
}

function resultTextOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type?: string; text?: string }>
  if (!blocks.every(block => block.type === 'text' && typeof block.text === 'string')) return null
  return blocks.map(block => block.text ?? '').join('\n')
}

function shapedResultPreview(text: string, previewChars: number): string {
  if (text.length <= previewChars) return text
  const headBudget = Math.floor(previewChars * 0.6)
  let head = text.slice(0, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = text.slice(text.length - (previewChars - headBudget))
  const tailNewline = tail.indexOf('\n')
  if (tailNewline !== -1 && tailNewline < tail.length / 2) tail = tail.slice(tailNewline + 1)
  const omitted = text.length - head.length - tail.length
  return `${head}\n… [${omitted.toLocaleString('en-US')} characters omitted for the compaction — the full result is in the transcript] …\n${tail}`
}

function capOlderToolResults(rows: Message[], keepTokens: number, previewChars: number): Message[] {
  const sizes: Array<{ row: number; block: number; text: string }> = []
  rows.forEach((row, index) => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return
    ;(row.message.content as Array<{ type?: string; content?: unknown }>).forEach((block, at) => {
      if (block.type !== 'tool_result') return
      const text = resultTextOf(block.content)
      if (text === null || text.length <= previewChars) return
      if (text.startsWith(FOLDED_RESULT_KEY) || text.startsWith(PERSISTED_OUTPUT_TAG) || text.startsWith(TOOL_RESULT_CLEARED_MESSAGE)) return
      sizes.push({ row: index, block: at, text })
    })
  })
  const capped = new Map<number, Map<number, string>>()
  let kept = 0
  for (let at = sizes.length - 1; at >= 0; at--) {
    const entry = sizes[at] as (typeof sizes)[number]
    const tokens = Math.ceil(entry.text.length / 4)
    if (kept + tokens <= keepTokens) {
      kept += tokens
      continue
    }
    const blocks = capped.get(entry.row) ?? new Map<number, string>()
    blocks.set(entry.block, shapedResultPreview(entry.text, previewChars))
    capped.set(entry.row, blocks)
  }
  if (capped.size === 0) return rows
  return rows.map((row, index) => {
    const blocks = capped.get(index)
    if (blocks === undefined || row.type !== 'user' || !Array.isArray(row.message.content)) return row
    return {
      ...row,
      message: {
        ...row.message,
        content: (row.message.content as Array<{ type?: string; content?: unknown }>).map((block, at) => (blocks.has(at) ? { ...block, content: blocks.get(at) } : block)),
      },
    } as Message
  })
}

async function foldOldestIntoParts(
  rows: Message[],
  budgetTokens: number,
  measure: (rows: Message[]) => number,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<Message[]> {
  let current = rows
  const passes = groupMessagesByApiRound(rows).length + PTL_RETRY_LIMIT
  for (let pass = 0; pass < passes; pass++) {
    if (measure(current) <= budgetTokens) return current
    const input = current.filter(message => !isPtlMarkerMessage(message))
    const groups = groupMessagesByApiRound(input)
    const workingOf = (group: Message[]): Message[] => group.filter(message => !isCompactCapsuleMessage(message))
    if (groups.length < 2) {
      const text = await foldAllAsText(input, cacheSafeParams, promptText, context, ladder)
      return text ?? current
    }
    let take = 0
    let size = 0
    while (take < groups.length - 1) {
      const next = measure(workingOf(groups[take] as Message[]))
      if (take > 0 && size + next > budgetTokens) break
      size += next
      take++
    }
    while (take < groups.length - 1 && workingOf(groups.slice(0, take).flat()).length === 0) take++
    const head = groups.slice(0, take).flat()
    const working = workingOf(head)
    if (working.length === 0) return current
    const partResponse = await summarizeWithPtlRetry(working, cacheSafeParams, promptText, context, ladder)
    const capsule = partCapsule(validateSummary(partResponse, false))
    current = [...head.filter(isCompactCapsuleMessage), capsule, ...groups.slice(take).flat()]
  }
  return current
}

async function prefitSummariserInput(
  messages: Message[],
  fit: SummariserFit,
  split: { retiring: Message[]; rounds: number } | null,
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
  ladder: FoldLadder,
): Promise<{ input: Message[]; shaped: boolean }> {
  const measure = (rows: Message[]): number => Math.ceil(roughTokenCountEstimationForMessages(rows) * fit.ratio)
  const whole = measure(messages)
  if (whole <= fit.budgetTokens) return { input: messages, shaped: false }
  const say = (stage: string, rows: Message[]): void =>
    logForDebugging(`compact: the summariser's input is pre-fitted — ${stage}: ≈${measure(rows)} tokens against a budget of ${fit.budgetTokens} (window ${fit.window}, blocking limit ${fit.blockingLimit}, fixed material ≈${fit.fixedTokens}, the whole conversation ≈${whole})`)
  let rows = split === null ? messages : split.retiring
  if (measure(rows) <= fit.budgetTokens) {
    say(`the kept tail (${split?.rounds ?? 0} rounds) split off`, rows)
    return { input: rows, shaped: true }
  }
  rows = capOlderToolResults(stripImagesFromMessages(stripThinkingFromIndex(rows, 0)), SHAPED_RESULTS_KEEP_TOKENS, SHAPED_RESULT_PREVIEW_CHARS)
  if (measure(rows) <= fit.budgetTokens) {
    say('older tool results capped, thinking and media stripped', rows)
    return { input: rows, shaped: true }
  }
  rows = await foldOldestIntoParts(rows, fit.budgetTokens, measure, cacheSafeParams, promptText, context, ladder)
  say('the oldest rounds folded into part capsules', rows)
  return { input: rows, shaped: true }
}
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
  overflow?: OverflowSignal,
  summaryModel?: string,
): Promise<CompactionResult> {
  const transaction = prepareFoldContext(context)
  context = transaction.context
  let ceiling = recompactionInfo?.autoCompactThreshold
  let landing: number | undefined
  const summaryContext = summaryModel === undefined ? context : withEngineModel(context, summaryModel)
  const summaryCacheSafeParams =
    summaryModel === undefined
      ? cacheSafeParams
      : { ...cacheSafeParams, toolUseContext: withEngineModel(cacheSafeParams.toolUseContext, summaryModel) }
  const trigger = isAutoCompact ? 'auto' : 'manual'
  const boundaryTrigger: CompactMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger
  const newestMessageFollows = (cacheSafeParams.postFoldCarry ?? []).some(row => operatorTextOf(row) !== null)
  try {
    if (messages.length === 0) throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    const preCompactTokenCount = tokenCountWithEstimation(messages)

    context.setSDKStatus?.('compacting')
    const before = await compactionBeforeHooks(context, { trigger: boundaryTrigger, ...(customInstructions !== undefined ? { instructions: customInstructions } : {}), tokens: preCompactTokenCount })
    const beforeRows: Message[] = hookRowsOfResult(before).map(row => createAttachmentMessage(row))
    const mergedInstructions = mergeHookInstructions(customInstructions, before.answer.instructions)

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    const owner = ownerFromToolUseContext(context)
    const capsuleProbe = buildRunContinuationCapsule(owner)
    const ledger = buildFoldLedger(messages, owner, getContextEpoch(owner).epoch + 1)
    const gauge = readRequestGauge(messages, context.options.engineModel)
    landing = ceiling === undefined ? undefined : foldLandingCeiling(ceiling, messages, gauge?.density.ratio ?? 1, gauge?.density.residuals)
    const landingCount = (rows: Message[]): number => {
      const request = [...rows, ...(cacheSafeParams.postFoldCarry ?? [])]
      return gauge ? estimateRequestGauge(request, gauge.fixed, gauge.density) : estimateContextTokens(request)
    }
    if (ceiling !== undefined) {
      const obligations = selectOperatorMessages(messages)
      const estimate = landingCount([
        createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount),
        ...(obligations ? [createAttachmentMessage(obligations)] : []),
        createUserMessage({ content: renderFoldLedger(ledger), isCompactSummary: true }),
        ...beforeRows,
      ])
      if (estimate >= ceiling) throw new Error(obligationsOverThresholdMessage(estimate, ceiling))
    }
    const promptText = getCompactPrompt(mergedInstructions, { runCapsulePresent: capsuleProbe !== null })
    const allFolded = (keep: Message[]): Message[] => withFoldedResults(keep, new Map(foldableResults(keep).map(result => [result.toolUseId, foldedResultPlaceholder(result)])))
    const fitsUnder = (limit: number | undefined, resultsFolded: boolean, prose: string, memoryNote: string | null) => (keep: Message[]): boolean => {
      if (limit === undefined) return true
      const operator = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
      const marker = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount)
      const work = renderFoldedWork(foldedWorkOf(messages, keep, marker.uuid))
      const capsule = buildRunContinuationCapsule(owner, [...context.readFileState.keys()])
      const text = getCompactUserSummaryMessage([prose, capsule, work, memoryNote].filter(part => part !== null).join('\n\n'), suppressFollowUpQuestions, getTranscriptPath(), true, newestMessageFollows) + `\n\n${renderFoldLedger(ledger)}`
      return landingCount([marker, ...(operator ? [createAttachmentMessage(operator)] : []), createUserMessage({ content: text, isCompactSummary: true }), ...stripThinkingFromIndex(resultsFolded ? allFolded(keep) : keep, 0), ...beforeRows]) < limit
    }
    const fit = await summariserFitFor(summaryContext, summaryCacheSafeParams, promptText, gauge)
    const ladder = newFoldLadder(fit.budgetTokens)
    let splitRounds = 0
    let response: AssistantMessage | undefined
    let rawSummary = ''
    let proseSkipped: string | undefined
    let proseSkippedReceipt: string | undefined
    try {
      let summaryInput = messages
      const requestTokens = Math.ceil(roughTokenCountEstimationForMessages(messages) * fit.ratio)
      if (overflow !== undefined || preCompactTokenCount + fit.promptTokens > fit.blockingLimit || requestTokens > fit.limitTokens) {
        let split: { retiring: Message[]; rounds: number } | null = null
        if (isMercuryCompactKeepTailEnabled()) {
          const standIn = 'summary '.repeat(Math.ceil(Math.min(fit.reserveTokens, Math.max(SPLIT_STAND_IN_FLOOR_TOKENS, Math.floor((landing ?? fit.reserveTokens) / SPLIT_STAND_IN_LANDING_SHARE))) / 2))
          for (const [limit, resultsFolded] of [[landing, false], [ceiling, false], [landing, true], [ceiling, true]] as const) {
            try {
              const tail = computeVerbatimRecentTail(messages, { fits: fitsUnder(limit, resultsFolded, standIn, null) })
              const first = tail === null || tail.keep.length === 0 ? -1 : messages.findIndex(row => row.uuid === tail.keep[0]?.uuid)
              if (tail !== null && first > 0) split = { retiring: messages.slice(0, first), rounds: tail.roundsKept }
              break
            } catch {
              split = null
            }
          }
        }
        const shaped = await prefitSummariserInput(messages, fit, split, summaryCacheSafeParams, promptText, summaryContext, ladder)
        summaryInput = shaped.input
        if (shaped.shaped && split !== null) splitRounds = split.rounds
      }
      response = await summarizeWithPtlRetry(summaryInput, summaryCacheSafeParams, promptText, summaryContext, ladder)
      rawSummary = validateSummary(response, true)
    } catch (error) {
      if (!foldLadderExhausted(error) || context.abortController.signal.aborted) throw error
      proseSkipped = proseSkippedLine((error as Error).message)
      proseSkippedReceipt = proseSkippedNote((error as Error).message)
      logForDebugging(`compact: the ladder's bottom — ${(error as Error).message}; the fold lands on Mercury's own records without a prose summary`, { level: 'warn' })
    }
    const prose = proseSkipped ?? rawSummary
    if (overflow?.source === 'provider' && overflow.limitTokens !== undefined) {
      ceiling = Math.min(ceiling ?? Infinity, overflow.limitTokens)
      landing = Math.min(landing ?? Infinity, foldLandingCeiling(ceiling, messages, gauge?.density.ratio ?? 1, gauge?.density.residuals))
    }
    context.onCompactProgress?.({ type: 'stage', stage: 'restoring' })
    const memory = retireFoldToMemory({
      messages, owner, epoch: ledger.epoch, records: ledger.sourceRecordIds.length,
      aborted: context.abortController.signal.aborted,
      ...(context.agentId === undefined ? {} : { agent: String(context.agentId) }),
    })
    const memoryText = renderFoldMemory(memory)

    let messagesToKeep: Message[] | undefined
    let tailPrecedingUuid: UUID | undefined
    let recentRounds: CompactMetadata['recentRounds']
    let foldTarget: number | undefined
    const selectTail = (opts: Parameters<typeof computeVerbatimRecentTail>[1]): ReturnType<typeof computeVerbatimRecentTail> => {
      try {
        return computeVerbatimRecentTail(messages, { ...opts, minRounds: splitRounds })
      } catch (error) {
        throw new Error(`${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (isMercuryCompactKeepTailEnabled()) {
      const fits = (limit: number | undefined, resultsFolded = false) => fitsUnder(limit, resultsFolded, prose, memoryText)
      let tail: ReturnType<typeof computeVerbatimRecentTail>
      try {
        tail = selectTail({ fits: fits(landing) })
      } catch (error) {
        if (landing === undefined) throw error
        try {
          tail = selectTail({ fits: fits(ceiling) })
        } catch {
          try {
            tail = selectTail({ fits: fits(landing, true) })
            foldTarget = landing
          } catch {
            tail = selectTail({ fits: fits(ceiling, true) })
            foldTarget = ceiling
          }
        }
      }
      if (tail !== null && tail.keep.length > 0) {
        messagesToKeep = stripThinkingFromIndex(tail.keep, 0)
        tailPrecedingUuid = tail.precedingUuid
        recentRounds = { requested: tail.roundsRequested, kept: tail.roundsKept, tokens: tail.estimatedTokens, reason: tail.reason }
        logForDebugging(`compact: verbatim tail keeps ${tail.roundsKept} rounds (${tail.keep.length} messages)`)
      }
    }
    const operatorSelection = selectOperatorMessages(messages, {
      keptUuids: new Set((messagesToKeep ?? []).map(message => message.uuid)),
    })
    const operatorMessages = operatorSelection === null ? undefined : createAttachmentMessage(operatorSelection)
    if (operatorSelection !== null) {
      logForDebugging(`compact: operator messages block carries ${operatorSelection.messages.length} of ${operatorSelection.messages.length + operatorSelection.omitted} prompts verbatim`)
    }

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    const postCompactFileAttachments = await assembleAttachments(snapshot, context, messagesToKeep ?? [], 'compact_full', ledgerBeforeFold)

    const lastMessage = messages[messages.length - 1] as Message
    const anchor = messagesToKeep !== undefined ? tailPrecedingUuid : lastMessage.uuid
    const boundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount, anchor)
    boundary.compactMetadata.ledger = ledger
    boundary.compactMetadata.memory = memory
    if (gauge) boundary.compactMetadata.requestGauge = { key: gauge.key, epoch: getContextEpoch(owner).epoch + 1, fixed: gauge.fixed, density: gauge.density }
    boundary.compactMetadata.recentRounds = recentRounds ?? { requested: 10, kept: 0, tokens: 0, reason: isMercuryCompactKeepTailEnabled() ? 'no-complete-tail' : 'disabled' }
    if (overflow !== undefined) boundary.compactMetadata.overflow = overflow
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    const capsule = buildRunContinuationCapsule(owner, Object.keys(snapshot))
    const degraded = proseSkipped !== undefined || rawSummary.trim().length < DEGRADED_SUMMARY_LENGTH
    const foldedWork = renderFoldedWork(foldedWorkOf(messages, messagesToKeep ?? [], boundary.uuid))
    const summaryWithCapsule = [prose, capsule, foldedWork, memoryText].filter((part): part is string => part !== null).join('\n\n')

    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summaryWithCapsule,
          suppressFollowUpQuestions,
          getTranscriptPath(),
           !!messagesToKeep,
          newestMessageFollows,
        ) + `\n\n${renderFoldLedger(ledger)}`,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]
    if (messagesToKeep !== undefined) {
      annotateBoundaryWithPreservedSegment(boundary, summaryMessages.at(-1)!.uuid, messagesToKeep)
    }
    annotateBoundaryWithWork(boundary, messages, messagesToKeep ?? [], summaryMessages.at(-1)!.uuid)

    const usage = response === undefined ? undefined : (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    let partial: CompactionResult = {
      boundaryMarker: boundary,
      operatorMessages,
      summaryMessages,
      messagesToKeep,
      attachments: postCompactFileAttachments,
      hookResults: beforeRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
      ...(proseSkippedReceipt !== undefined ? { notes: [proseSkippedReceipt] } : {}),
    }
    const cacheEpoch = carryFoldPrefix(messages, buildPostCompactMessages(partial), String(rosterOwnerFromToolUseContext(context)), context.options.engineModel, usage)
    boundary.compactMetadata.cacheEpoch = cacheEpoch.receipt
    if (cacheEpoch.attachment) partial.attachments.push(cacheEpoch.attachment)
    let truePostCompactTokenCount = landingCount(buildPostCompactMessages(partial))
    const room = landing ?? ceiling
    if (room !== undefined && truePostCompactTokenCount >= room) {
      const fit = fitPostCompactUnderThreshold(partial, room, landingCount)
      if (fit.shed.length > 0) {
        logForDebugging(
          `compact: post-compact estimate ${truePostCompactTokenCount} >= the landing line ${room} (threshold ${ceiling}); shed ${fit.shed.join(', ')} → ${fit.estimate}`,
        )
      }
      partial = fit.result
      truePostCompactTokenCount = fit.estimate
    }

    const completeFit = room === undefined ? { result: partial, estimate: landingCount(buildPostCompactMessages(partial)) } : fitPostCompactUnderThreshold(partial, room, landingCount)
    partial = completeFit.result
    truePostCompactTokenCount = completeFit.estimate
    const folded = new Map<string, string>()
    const rekeep = (keep: Message[], rounds: NonNullable<CompactMetadata['recentRounds']>): void => {
      messagesToKeep = keep
      recentRounds = rounds
      boundary.compactMetadata.recentRounds = rounds
      const selection = selectOperatorMessages(messages, { keptUuids: new Set(keep.map(row => row.uuid)) })
      const work = renderFoldedWork(foldedWorkOf(messages, keep, boundary.uuid))
      const summaryText = getCompactUserSummaryMessage([prose, capsule, work, memoryText].filter(part => part !== null).join('\n\n'), suppressFollowUpQuestions, getTranscriptPath(), true, newestMessageFollows) + `\n\n${renderFoldLedger(ledger)}`
      partial = { ...partial, messagesToKeep: keep, operatorMessages: selection ? createAttachmentMessage(selection) : undefined, summaryMessages: partial.summaryMessages.map((row, index) => index === 0 ? { ...row, message: { ...row.message, content: summaryText } } : row) }
      annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, keep)
      annotateBoundaryWithWork(boundary, messages, keep, partial.summaryMessages.at(-1)!.uuid)
      const fitted = fitPostCompactUnderThreshold(partial, room ?? Infinity, landingCount)
      partial = fitted.result
      truePostCompactTokenCount = fitted.estimate
    }
    const widest = { partial, messagesToKeep, recentRounds, logicalParentUuid: boundary.logicalParentUuid, estimate: truePostCompactTokenCount }
    while (room !== undefined && foldTarget === undefined && truePostCompactTokenCount >= room && recentRounds !== undefined && recentRounds.kept > Math.max(1, splitRounds)) {
      const narrower = selectTail({ keepRounds: recentRounds.kept - 1 })
      if (narrower === null) break
      boundary.logicalParentUuid = narrower.precedingUuid
      rekeep(stripThinkingFromIndex(narrower.keep, 0), { requested: recentRounds.requested, kept: narrower.roundsKept, tokens: narrower.estimatedTokens, reason: 'request-budget' })
    }
    if (room !== undefined && messagesToKeep !== undefined && recentRounds !== undefined) {
      const whole = messagesToKeep
      const target = foldTarget ?? room
      for (const result of foldableResults(whole)) {
        if (truePostCompactTokenCount < target) break
        folded.set(result.toolUseId, foldedResultPlaceholder(result))
        const keep = withFoldedResults(whole, folded)
        rekeep(keep, { ...recentRounds, tokens: roughTokenCountEstimationForMessages(keep), folded: folded.size })
      }
    }
    if (landing !== undefined && truePostCompactTokenCount >= landing && recentRounds !== undefined) {
      if (widest.recentRounds !== undefined && widest.estimate < (ceiling ?? Infinity)) {
        folded.clear()
        partial = widest.partial
        messagesToKeep = widest.messagesToKeep
        truePostCompactTokenCount = widest.estimate
        boundary.logicalParentUuid = widest.logicalParentUuid
        recentRounds = widest.recentRounds
        annotateBoundaryWithPreservedSegment(boundary, partial.summaryMessages.at(-1)!.uuid, messagesToKeep ?? [])
        annotateBoundaryWithWork(boundary, messages, messagesToKeep ?? [], partial.summaryMessages.at(-1)!.uuid)
      }
      recentRounds = { ...recentRounds, reason: 'no-room' }
      boundary.compactMetadata.recentRounds = recentRounds
    }
    if (ceiling !== undefined && truePostCompactTokenCount >= ceiling) throw new Error(postCompactOverThresholdMessage(truePostCompactTokenCount, ceiling))
    const visibleReads = collectPreservedReadPaths(messagesToKeep ?? [])
    for (const row of partial.attachments) if (row.attachment.type === 'file') visibleReads.add(expandPath(row.attachment.filename))
    for (const path of context.readFileState.keys()) if (!visibleReads.has(expandPath(path))) context.readFileState.delete(path)
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    boundary.compactMetadata.postTokens = truePostCompactTokenCount
    const afterRows = await compactionAfterHooks(context, { method: 'summary', trigger: boundaryTrigger, tokensBefore: preCompactTokenCount, tokensAfter: truePostCompactTokenCount, summary: prose })
    partial = { ...partial, hookResults: [...beforeRows, ...afterRows] }
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    await releaseLspDocumentsForContext('compact_full')
    transaction.commit(folded)
    if (folded.size > 0 && (recompactionInfo?.querySource === 'sdk' || recompactionInfo?.querySource?.startsWith('agent:') === true || recompactionInfo?.querySource?.startsWith('main_thread') === true)) {
      await recordContentReplacement([...folded].map(([toolUseId, replacement]) => ({ kind: 'tool-result' as const, toolUseId, replacement })), context.agentId).catch((error: unknown) => logError(error))
    }
    restoreBoundPrefixFromMessages(buildPostCompactMessages(partial), { rosterOnly: context.agentId !== undefined, fold: true })
    advanceContextEpoch(owner, {
      kind: isAutoCompact ? 'auto-compact' : 'manual-compact',
      reason: isAutoCompact ? 'auto-compact threshold' : 'operator /compact',
      tokensBefore: preCompactTokenCount,
      tokensAfter: truePostCompactTokenCount,
      preservedTailCount: messagesToKeep !== undefined ? messagesToKeep.length : null,
      capsule: degraded
        ? { state: 'degraded', reason: proseSkippedReceipt ?? `semantic summary under ${DEGRADED_SUMMARY_LENGTH} chars` }
        : capsule !== null
          ? { state: 'installed', reason: 'summary + capsule' }
          : { state: 'none', reason: 'no substantive run' },
    })

    reAppendSessionMetadata()

    return {
      ...partial,
      truePostCompactTokenCount,
    }
  } catch (err) {
    if (!isAutoCompact) notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}


function isProgressMessage(message: Message): boolean {
  return message.type === 'progress'
}

export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult> {
  const transaction = prepareFoldContext(context)
  context = transaction.context
  try {
    const summarize = direction === 'from' ? allMessages.slice(pivotIndex) : allMessages.slice(0, pivotIndex)
    let kept: Message[]
    if (direction === 'from') {
      kept = allMessages.slice(0, pivotIndex).filter(message => !isProgressMessage(message))
    } else {
      kept = stripThinkingFromIndex(
        allMessages
          .slice(pivotIndex)
          .filter(
            message =>
              !isProgressMessage(message) &&
              !isCompactBoundaryMessage(message) &&
              !(message.type === 'user' && (message as UserMessage).isCompactSummary === true),
          ),
        0,
      )
    }
    if (summarize.length === 0) {
      throw new Error(
        direction === 'from'
          ? 'Nothing to summarize after the selected message.'
          : 'Nothing to summarize before the selected message.',
      )
    }
    const preCompactTokenCount = tokenCountWithEstimation(allMessages)

    context.setSDKStatus?.('compacting')
    const before = await compactionBeforeHooks(context, { trigger: 'manual', ...(userFeedback?.trim() ? { instructions: userFeedback.trim() } : {}), tokens: preCompactTokenCount })
    const beforeRows: Message[] = hookRowsOfResult(before).map(row => createAttachmentMessage(row))
    const feedbackText = userFeedback?.trim() ? `User context for the summary:\n${userFeedback.trim()}` : undefined
    const hookText = before.answer.instructions?.trim() || undefined
    const customInstructions =
      hookText !== undefined && feedbackText !== undefined
        ? `${hookText}\n\n${feedbackText}`
        : (hookText ?? feedbackText)

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    const promptText = getPartialCompactPrompt(customInstructions, direction)
    const apiMessages = direction === 'up_to' ? summarize : allMessages
    const response = await summarizeWithPtlRetry(apiMessages, cacheSafeParams, promptText, context)
    const rawSummary = validateSummary(response, false)

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    const attachments = await assembleAttachments(snapshot, context, kept, 'compact_partial', ledgerBeforeFold)

    let anchorUuid: UUID | undefined
    if (direction === 'up_to') {
      for (let index = pivotIndex - 1; index >= 0; index--) {
        const candidate = allMessages[index] as Message
        if (!isProgressMessage(candidate)) {
          anchorUuid = candidate.uuid
          break
        }
      }
    } else {
      anchorUuid = kept.length > 0 ? (kept[kept.length - 1] as Message).uuid : undefined
    }
    const boundary = createCompactBoundaryMessage('manual', preCompactTokenCount, anchorUuid, userFeedback, summarize.length)
    const discovered = extractDiscoveredToolNames(allMessages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    const ledger = buildFoldLedger(allMessages, ownerFromToolUseContext(context), getContextEpoch(ownerFromToolUseContext(context)).epoch + 1)
    boundary.compactMetadata.ledger = ledger
    const foldedWork = renderFoldedWork(foldedWorkOf(allMessages, kept, boundary.uuid))
    const summaryText = getCompactUserSummaryMessage(foldedWork === null ? rawSummary : `${rawSummary}\n\n${foldedWork}`, false, getTranscriptPath(), false) + `\n\n${renderFoldLedger(ledger)}`
    const summaryMessage =
      kept.length > 0
        ? createUserMessage({
            content: summaryText,
            isCompactSummary: true,
            summarizeMetadata: { messagesSummarized: summarize.length, userContext: userFeedback, direction },
          })
        : createUserMessage({ content: summaryText, isCompactSummary: true, isVisibleInTranscriptOnly: true })

    const relinkAnchor = direction === 'from' ? boundary.uuid : summaryMessage.uuid
    annotateBoundaryWithPreservedSegment(boundary, relinkAnchor, kept)
    annotateBoundaryWithWork(boundary, allMessages, kept, summaryMessage.uuid)

    reAppendSessionMetadata()

    const usage = (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    const operatorSelection = selectOperatorMessages(summarize)
    const partialResult: CompactionResult = {
      boundaryMarker: boundary,
      operatorMessages: operatorSelection === null ? undefined : createAttachmentMessage(operatorSelection),
      summaryMessages: [summaryMessage],
      messagesToKeep: kept,
      attachments,
      hookResults: beforeRows,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
    }
    const cacheEpoch = carryFoldPrefix(allMessages, buildPostCompactMessages(partialResult), String(rosterOwnerFromToolUseContext(context)), context.options.engineModel, usage)
    boundary.compactMetadata.cacheEpoch = cacheEpoch.receipt
    if (cacheEpoch.attachment) partialResult.attachments.push(cacheEpoch.attachment)
    const truePostCompactTokenCount = estimateContextTokens(buildPostCompactMessages(partialResult))
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    boundary.compactMetadata.postTokens = truePostCompactTokenCount
    const afterRows = await compactionAfterHooks(context, { method: 'summary', trigger: 'manual', tokensBefore: preCompactTokenCount, tokensAfter: truePostCompactTokenCount, summary: rawSummary })
    if (context.abortController.signal.aborted) throw new APIUserAbortError()
    await releaseLspDocumentsForContext('compact_partial')
    transaction.commit()
    restoreBoundPrefixFromMessages(buildPostCompactMessages(partialResult), { rosterOnly: context.agentId !== undefined, fold: true })
    return {
      ...partialResult,
      hookResults: [...beforeRows, ...afterRows],
      truePostCompactTokenCount,
    }
  } catch (err) {
    notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}
