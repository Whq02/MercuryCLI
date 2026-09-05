import { getMainThreadAgentType, getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../../types/message.js'
import type { CompactMetadata, HookResultMessage } from '../../types/message.js'
import type { UUID } from 'node:crypto'
import { getAgentRosterAttachment, queuedNoticeTaskIds } from '../../utils/attachments/agentRoster.js'
import { getDeferredToolsDeltaAttachment, getAgentListingDeltaAttachment, getMcpInstructionsDeltaAttachment } from '../../utils/attachments/deltas.js'
import { generateFileAttachment } from '../../utils/attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { getUserContextAttachment } from '../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../utils/config/derived.js'
import { logForDebugging } from '../../utils/debug.js'
import { runForkedAgent, type CacheSafeParams } from '../../utils/forkedAgent.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { classifyModelRoute } from '../providers/routeLaw.js'
import { executePostCompactHooks, executePreCompactHooks } from '../../utils/hooks/events.js'
import { logError } from '../../utils/log.js'
import { MEMORY_TYPE_VALUES } from '../../utils/memory/types.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  getAssistantMessageText,
  isCompactBoundaryMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import type { FileState } from '../../utils/fileStateCache.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import { isSessionActivityTrackingActive, sendSessionActivitySignal } from '../../utils/sessionActivity.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { reAppendSessionMetadata } from '../../utils/sessionStorage/logs.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames, isToolSearchEnabled } from '../../utils/toolSearch.js'
import { sleep } from '../../utils/sleep.js'
import { COMPACT_MAX_OUTPUT_TOKENS } from '../../utils/context.js'
import { getModelMaxOutputTokens } from '../../utils/model/capabilities.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE, getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { API_ERROR_MESSAGE_PREFIX, PROMPT_TOO_LONG_ERROR_MESSAGE, getPromptTooLongTokenGap } from '../api/errors.js'
import { type OverflowSignal, overflowGapTokens, overflowSignalOf } from '../api/overflowSignal.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import { markPostCompaction } from '../api/logging.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { getRetryDelay } from '../api/withRetry.js'
import { APIUserAbortError } from '../api/sdkErrors.js'
import { isInstructionFilePath } from '../../services/instructions/engine.js'
import { logPermissionContextForAnts } from '../internalLogging.js'
import { releaseLspDocumentsForContext } from '../lsp/manager.js'
import { advanceContextEpoch } from '../run/contextEpochs.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../run/resolveOwner.js'
import { buildRunContinuationCapsule } from '../run/runContinuationCapsule.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../../tools/FileReadTool/prompt.js'
import { ToolSearchTool } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import { groupMessagesByApiRound } from './grouping.js'
import { estimateContextTokens, estimateMessageTokens } from './microCompact.js'
import { projectRewoundWindows } from './checkpointRewind.js'
import { getCompactPrompt, getCompactUserSummaryMessage, getPartialCompactPrompt } from './prompt.js'
import { computeVerbatimRecentTail, isMercuryCompactKeepTailEnabled } from './verbatimTail.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'


void notifyCompaction


export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
export const POST_COMPACT_MAX_TOKENS_PER_PLAN = 5_000

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.'
export const ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD = 'Compaction cannot bring the context under its threshold'
export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'This conversation has outgrown one pass: after three narrowing retries the summariser itself was refused as too long. Start a fresh conversation with /clear, or switch to a model with a larger context window and run /compact again.'
export const ERROR_MESSAGE_USER_ABORT = 'Compaction canceled.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction was interrupted before a summary arrived — likely a network issue; try again.'

const PTL_RETRY_LIMIT = 3
const PTL_TRUNCATION_MARKER = '[earlier turns folded for the compaction retry]'
const LEGACY_PTL_TRUNCATION_MARKER = '[earlier conversation truncated for compaction retry]'
const KEEPALIVE_INTERVAL_MS = 30_000
const DEGRADED_SUMMARY_LENGTH = 80


export const MECHANICAL_FOLD_EFFORT = 'low' as const
const FOLD_DEADLINE_MS = 10 * 60 * 1000
const FOLD_STALL_MS = 120_000

export const ERROR_MESSAGE_FOLD_TIMEOUT =
  'The summary call stalled and was stopped — nothing was folded; the conversation stands as it was. Try again, or start fresh with /clear.'

let foldBoundsOverride: { deadlineMs: number; stallMs: number } | null = null
export function setFoldBoundsForTests(bounds: { deadlineMs: number; stallMs: number } | null): void {
  foldBoundsOverride = bounds
}

type FoldBound = {
  controller: AbortController
  signal: AbortSignal
  touch(): void
  hitDeadline(): boolean
  dispose(): void
}

function armFoldBound(parent: AbortSignal): FoldBound {
  const deadlineMs = foldBoundsOverride?.deadlineMs ?? FOLD_DEADLINE_MS
  const stallMs = foldBoundsOverride?.stallMs ?? FOLD_STALL_MS
  const controller = new AbortController()
  let timedOut = false
  const onParentAbort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const expire = (): void => {
    timedOut = true
    controller.abort()
  }
  const deadline = setTimeout(expire, deadlineMs)
  deadline.unref?.()
  let stall: NodeJS.Timeout | null = setTimeout(expire, stallMs)
  stall.unref?.()
  return {
    controller,
    signal: controller.signal,
    touch(): void {
      if (stall !== null) clearTimeout(stall)
      stall = setTimeout(expire, stallMs)
      stall.unref?.()
    },
    hitDeadline: () => timedOut,
    dispose(): void {
      clearTimeout(deadline)
      if (stall !== null) clearTimeout(stall)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

export function shouldRideCacheSharingFork(model: string, thinkingConfig?: { type: string }): boolean {
  if (thinkingConfig?.type === 'enabled') return false
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'absence') return false
  if (verdict.kind === 'unrecognised') return true
  return verdict.route === 'anthropic'
}


export type CompactionResult = {
  boundaryMarker: SystemCompactBoundaryMessage
  summaryMessages: UserMessage[]
  messagesToKeep?: Message[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  userDisplayMessage?: string
  preCompactTokenCount: number
  postCompactTokenCount: number
  truePostCompactTokenCount?: number
  compactionUsage?: NonNullableUsage
}

export type RecompactionInfo = {
  isRecompaction: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: string
}


export function buildPostCompactMessages(result: CompactionResult): Message[] {
  const { boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults } = result
  return [
    boundaryMarker,
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


function shouldExcludeFromPostCompactRestore(filename: string, agentId?: string): boolean {
  const normalizedFilename = expandPath(filename)
  try {
    if (normalizedFilename === expandPath(getPlanFilePath(agentId))) return true
  } catch {
  }
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
      if (text.includes(FILE_UNCHANGED_STUB)) stubToolUseIds.add(record.tool_use_id)
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
    .filter(([path]) => !shouldExcludeFromPostCompactRestore(path, toolUseContext.agentId))
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

const PLAN_TRUNCATION_MARKER =
  '\n\n[Plan content truncated for compaction — Read the plan path above for the full text.]'

export function createPlanAttachmentIfNeeded(agentId?: string): AttachmentMessage | null {
  const plan = getPlan(agentId)
  if (plan === null) return null
  const { content } = truncateToTokenCeiling(plan, POST_COMPACT_MAX_TOKENS_PER_PLAN, PLAN_TRUNCATION_MARKER)
  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath: getPlanFilePath(agentId),
    planContent: content,
  })
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


const POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES = ['file', 'compact_file_reference', 'invoked_skills', 'plan_file_reference'] as const

export type PostCompactFit = {
  result: CompactionResult
  estimate: number
  shed: string[]
}

function describeAttachment(message: AttachmentMessage): string {
  const attachment = message.attachment as { type: string; filename?: string; planFilePath?: string }
  if (attachment.type === 'file' || attachment.type === 'compact_file_reference') return `file ${attachment.filename ?? '?'}`
  if (attachment.type === 'plan_file_reference') return `plan ${attachment.planFilePath ?? '?'}`
  return attachment.type
}

export function fitPostCompactUnderThreshold(result: CompactionResult, threshold: number): PostCompactFit {
  let current = result
  let estimate = estimateContextTokens(buildPostCompactMessages(current))
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
      estimate = estimateContextTokens(buildPostCompactMessages(current))
    }
    if (estimate < threshold) break
  }
  return { result: current, estimate, shed }
}

function postCompactOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: with every restorable attachment dropped, the summary, ` +
    `the kept tail and the session-start hook output still estimate ${estimate} tokens against a ` +
    `${threshold}-token threshold. Start a fresh conversation with /clear, or trim the hook output.`
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

export async function createPlanModeAttachmentIfNeeded(context: ToolUseContext): Promise<AttachmentMessage | null> {
  const permissionContext = context.getAppState().toolPermissionContext
  if (permissionContext.mode !== 'strategy') return null
  const planFilePath = getPlanFilePath(context.agentId)
  return createAttachmentMessage({
    type: 'plan_mode',
    reminderType: 'full',
    isSubAgent: context.agentId !== undefined,
    planFilePath,
    planExists: getPlan(context.agentId) !== null,
  })
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
  const bound = armFoldBound(context.abortController.signal)
  try {
    const result = await runForkedAgent({
      promptMessages: [promptMessage],
      cacheSafeParams: { ...cacheSafeParams, forkContextMessages: messages },
      canUseTool: createCompactCanUseTool(),
      querySource: 'compact' as never,
      forkLabel: 'compact',
      maxTurns: 1,
      skipCacheWrite: true,
      overrides: {
        abortController: bound.controller,
        getAppState: () => {
          const state = context.getAppState()
          const shielded = state.toolPermissionContext.shouldAvoidPermissionPrompts
            ? state
            : {
                ...state,
                toolPermissionContext: { ...state.toolPermissionContext, shouldAvoidPermissionPrompts: true },
              }
          return shielded.effortValue === MECHANICAL_FOLD_EFFORT
            ? shielded
            : { ...shielded, effortValue: MECHANICAL_FOLD_EFFORT }
        },
      },
    })
    const last = [...result.messages].reverse().find(message => message.type === 'assistant') as
      | AssistantMessage
      | undefined
    if (last !== undefined && last.isApiErrorMessage !== true) {
      const text = getAssistantMessageText(last)
      if (text !== null && text !== '') return last
    }
    if (
      last !== undefined &&
      (overflowSignalOf(last) !== null || (getAssistantMessageText(last) ?? '').startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE))
    ) {
      return last
    }
    logForDebugging(`compact: fork path produced no usable summary: ${JSON.stringify(result.messages).slice(0, 500)}`, {
      level: 'warn',
    })
    return null
  } catch (err) {
    if (bound.hitDeadline()) {
      logForDebugging(`compact: fork lane hit its fold bound — handing over to the direct call`, { level: 'warn' })
      return null
    }
    logError(err)
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
  const bound = armFoldBound(context.abortController.signal)
  try {
    return await streamingFallbackAttempts(messages, cacheSafeParams, promptMessage, context, bound)
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
  const attempts = checkFeatureGate_CACHED_MAY_BE_STALE('mercury_compact_streaming_retry') ? 2 : 1
  const model = context.options.mainLoopModel
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
    toolMap.set(FileReadTool.name, FileReadTool)
    if (toolSearchEnabled) {
      toolMap.set(ToolSearchTool.name, ToolSearchTool)
      for (const tool of context.options.tools) {
        if (tool.name.startsWith('mcp__') && !toolMap.has(tool.name)) toolMap.set(tool.name, tool)
      }
    }
    const tools = [...toolMap.values()]

    const afterBoundary = (() => {
      const index = findLastCompactBoundaryIndex(messages)
      const sliced = index >= 0 ? messages.slice(index + 1) : messages
      return projectRewoundWindows(sliced)
    })()
    const apiMessages = normalizeMessagesForAPI(
      stripImagesFromMessages(stripReinjectedAttachments([...afterBoundary, promptMessage])),
      context.options.tools,
    )

    let captured: AssistantMessage | undefined
    const stream = routedCallModel({
      messages: apiMessages,
      systemPrompt: cacheSafeParams.systemPrompt,
      thinkingConfig: { type: 'disabled' },
      tools,
      signal: bound.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(context.getAppState().toolPermissionContext),
        model,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: Boolean(context.options.appendSystemPrompt),
        maxOutputTokensOverride: Math.min(COMPACT_MAX_OUTPUT_TOKENS, getModelMaxOutputTokens(model).upperLimit),
        querySource: 'compact' as never,
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        effortValue: MECHANICAL_FOLD_EFFORT,
        ownerKey: String(rosterOwnerFromToolUseContext(context)),
      },
    })
    try {
      for await (const event of stream) {
        bound.touch()
        if (event.type === 'stream_event') {
          const inner = event.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } }
          if (inner.type === 'content_block_start' && inner.content_block?.type === 'text') {
            streamingStarted = true
            context.setStreamMode?.('responding')
          }
          if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
            const length = inner.delta.text?.length ?? 0
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
    if (captured !== undefined) return captured
    if (bound.hitDeadline()) throw new Error(ERROR_MESSAGE_FOLD_TIMEOUT)
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
): Promise<AssistantMessage> {
  return withKeepAlive(context, async () => {
    if (
      getFeatureValue_CACHED_MAY_BE_STALE('mercury_compact_cache_prefix', true) &&
      shouldRideCacheSharingFork(context.options.mainLoopModel, context.options.thinkingConfig)
    ) {
      const viaFork = await summarizeViaCacheSharingFork(messages, cacheSafeParams, promptMessage, context)
      if (viaFork !== null) return viaFork
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
    }
    return summarizeViaStreamingFallback(messages, cacheSafeParams, promptMessage, context)
  })
}

async function summarizeWithPtlRetry(
  initialMessages: Message[],
  cacheSafeParams: CacheSafeParams,
  promptText: string,
  context: ToolUseContext,
): Promise<AssistantMessage> {
  let messages = initialMessages
  let response: AssistantMessage | null = null
  for (let attempt = 0; attempt <= PTL_RETRY_LIMIT; attempt++) {
    const promptMessage = createUserMessage({ content: promptText })
    response = await runSummarization(messages, cacheSafeParams, promptMessage, context)
    const text = getAssistantMessageText(response) ?? ''
    if (!text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && overflowSignalOf(response) === null) return response
    if (attempt === PTL_RETRY_LIMIT) break
    const truncated = truncateHeadForPTLRetry(messages, response)
    if (truncated === null) break
    messages = truncated
  }
  throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
}

function validateSummary(response: AssistantMessage, logMissing: boolean): string {
  const text = getAssistantMessageText(response)
  if (text === null || text === '') {
    if (logMissing) {
      logForDebugging(`compact: no summary text in response: ${JSON.stringify(response)}`, { level: 'error' })
    }
    throw new Error('Failed to generate a conversation summary.')
  }
  if (text.startsWith(API_ERROR_MESSAGE_PREFIX)) throw new Error(text)
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
  const plan = createPlanAttachmentIfNeeded(context.agentId)
  if (plan !== null) attachments.push(plan)
  const planMode = await createPlanModeAttachmentIfNeeded(context)
  if (planMode !== null) attachments.push(planMode)
  const skills = createSkillAttachmentIfNeeded(context.agentId, context.options.commands)
  if (skills !== null) attachments.push(skills)
  const model = context.options.mainLoopModel
  const deltas = [
    ...getDeferredToolsDeltaAttachment(context.options.tools, model, preserved, { callSite }),
    ...getAgentListingDeltaAttachment(context, preserved),
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

async function runSessionStartHooks(context: ToolUseContext): Promise<HookResultMessage[]> {
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'session_start' })
  return processSessionStartHooks('compact', {
    model: context.options.mainLoopModel,
    agentType: context.agentType ?? getMainThreadAgentType(),
  })
}

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

function restoreAfterCompaction(context: ToolUseContext): void {
  context.setStreamMode?.('requesting')
  context.setResponseLength?.(() => 0)
  context.onCompactProgress?.({ type: 'compact_end' })
  context.setSDKStatus?.(null)
}

export async function withFoldStatus<T>(context: ToolUseContext, work: () => Promise<T>): Promise<T> {
  context.setSDKStatus?.('compacting')
  try {
    return await work()
  } finally {
    restoreAfterCompaction(context)
  }
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
): Promise<CompactionResult> {
  const ceiling = recompactionInfo?.autoCompactThreshold
  const trigger = isAutoCompact ? 'auto' : 'manual'
  const boundaryTrigger: CompactMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger
  try {
    if (messages.length === 0) throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    const preCompactTokenCount = tokenCountWithEstimation(messages)

    context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
    context.setSDKStatus?.('compacting')
    const preHook = await executePreCompactHooks(
      { trigger, customInstructions: customInstructions ?? null },
      context.abortController.signal,
    )
    const mergedInstructions = mergeHookInstructions(customInstructions, preHook.newCustomInstructions)

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    void logPermissionContextForAnts(null, 'summary')
    const owner = ownerFromToolUseContext(context)
    const capsuleProbe = buildRunContinuationCapsule(owner)
    const promptText = getCompactPrompt(mergedInstructions, { runCapsulePresent: capsuleProbe !== null })
    const response = await summarizeWithPtlRetry(messages, cacheSafeParams, promptText, context)
    const rawSummary = validateSummary(response, true)

    let messagesToKeep: Message[] | undefined
    let tailPrecedingUuid: UUID | undefined
    if (isMercuryCompactKeepTailEnabled()) {
      const tail = computeVerbatimRecentTail(messages)
      if (tail !== null && tail.keep.length > 0) {
        messagesToKeep = stripThinkingFromIndex(tail.keep, 0)
        tailPrecedingUuid = tail.precedingUuid
        logForDebugging(`compact: verbatim tail keeps ${tail.roundsKept} rounds (${tail.keep.length} messages)`)
      }
    }

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    await releaseLspDocumentsForContext('compact_full')
    const postCompactFileAttachments = await assembleAttachments(snapshot, context, messagesToKeep ?? [], 'compact_full', ledgerBeforeFold)
    const hookResults = await runSessionStartHooks(context)

    const lastMessage = messages[messages.length - 1] as Message
    const anchor = messagesToKeep !== undefined ? tailPrecedingUuid : lastMessage.uuid
    const boundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount, anchor)
    if (overflow !== undefined) boundary.compactMetadata.overflow = overflow
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    const capsule = buildRunContinuationCapsule(owner, Object.keys(snapshot))
    const degraded = rawSummary.trim().length < DEGRADED_SUMMARY_LENGTH
    const summaryWithCapsule = capsule !== null ? `${rawSummary}\n\n${capsule}` : rawSummary

    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summaryWithCapsule,
          suppressFollowUpQuestions,
          getTranscriptPath(),
           !!messagesToKeep,
        ),
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]
    if (messagesToKeep !== undefined) {
      annotateBoundaryWithPreservedSegment(boundary, summaryMessages.at(-1)!.uuid, messagesToKeep)
    }

    const usage = (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    let partial: CompactionResult = {
      boundaryMarker: boundary,
      summaryMessages,
      messagesToKeep,
      attachments: postCompactFileAttachments,
      hookResults,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
    }
    let truePostCompactTokenCount = estimateContextTokens(buildPostCompactMessages(partial))
    if (ceiling !== undefined && truePostCompactTokenCount >= ceiling) {
      const fit = fitPostCompactUnderThreshold(partial, ceiling)
      if (fit.shed.length > 0) {
        logForDebugging(
          `compact: post-compact estimate ${truePostCompactTokenCount} >= threshold ${ceiling}; shed ${fit.shed.join(', ')} → ${fit.estimate}`,
        )
      }
      partial = fit.result
      truePostCompactTokenCount = fit.estimate
      if (truePostCompactTokenCount >= ceiling) {
        for (const [path, state] of ledgerBeforeFold) context.readFileState.set(path, state)
        throw new Error(postCompactOverThresholdMessage(truePostCompactTokenCount, ceiling))
      }
    }

    advanceContextEpoch(owner, {
      kind: isAutoCompact ? 'auto-compact' : 'manual-compact',
      reason: isAutoCompact ? 'auto-compact threshold' : 'operator /compact',
      tokensBefore: preCompactTokenCount,
      tokensAfter: truePostCompactTokenCount,
      preservedTailCount: messagesToKeep !== undefined ? messagesToKeep.length : null,
      capsule: degraded
        ? { state: 'degraded', reason: `semantic summary under ${DEGRADED_SUMMARY_LENGTH} chars` }
        : capsule !== null
          ? { state: 'installed', reason: 'summary + capsule' }
          : { state: 'none', reason: 'no substantive run' },
    })

    markPostCompaction()
    reAppendSessionMetadata()

    context.onCompactProgress?.({ type: 'hooks_start', hookType: 'post_compact' })
    const postHook = await executePostCompactHooks(
      { trigger, compactSummary: rawSummary },
      context.abortController.signal,
    )
    const display = [preHook.userDisplayMessage, postHook.userDisplayMessage].filter(
      (text): text is string => typeof text === 'string' && text !== '',
    )
    return {
      ...partial,
      userDisplayMessage: display.length > 0 ? display.join('\n') : undefined,
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

    context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
    context.setSDKStatus?.('compacting')
    const preHook = await executePreCompactHooks(
      { trigger: 'manual', customInstructions: null },
      context.abortController.signal,
    )
    const feedbackText = userFeedback?.trim() ? `User context for the summary:\n${userFeedback.trim()}` : undefined
    const hookText = preHook.newCustomInstructions?.trim() || undefined
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
    await releaseLspDocumentsForContext('compact_partial')
    const attachments = await assembleAttachments(snapshot, context, kept, 'compact_partial', ledgerBeforeFold)
    const hookResults = await runSessionStartHooks(context)

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

    const summaryText = getCompactUserSummaryMessage(rawSummary, false, getTranscriptPath(), false)
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

    markPostCompaction()
    reAppendSessionMetadata()

    context.onCompactProgress?.({ type: 'hooks_start', hookType: 'post_compact' })
    const postHook = await executePostCompactHooks(
      { trigger: 'manual', compactSummary: rawSummary },
      context.abortController.signal,
    )

    const usage = (response.message as { usage?: NonNullableUsage }).usage
    const callUsageTotal = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      : 0
    const partialResult: CompactionResult = {
      boundaryMarker: boundary,
      summaryMessages: [summaryMessage],
      messagesToKeep: kept,
      attachments,
      hookResults,
      userDisplayMessage: postHook.userDisplayMessage,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
    }
    return {
      ...partialResult,
      truePostCompactTokenCount: estimateContextTokens(buildPostCompactMessages(partialResult)),
    }
  } catch (err) {
    notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}
