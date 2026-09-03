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
import { getDeferredToolsDeltaAttachment, getAgentListingDeltaAttachment, getMcpInstructionsDeltaAttachment } from '../../utils/attachments/deltas.js'
import { generateFileAttachment } from '../../utils/attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { getUserContextAttachment } from '../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../utils/config/derived.js'
import { logForDebugging } from '../../utils/debug.js'
import { runForkedAgent, type CacheSafeParams } from '../../utils/forkedAgent.js'
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
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
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

/**
 * Full and partial conversation compaction: summarise, rebuild the
 * post-compact context (summary + optional verbatim tail + restored files,
 * plans, skills, tool/agent/MCP re-announcements + hook output), boundary
 * metadata, and attachments.
 */

// The compaction notifier is imported but deliberately NOT called from any
// path here — restoring the call is an operator decision.
void notifyCompaction

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
/** The plan reference's ceiling — the one reconstruction budget that had
 *  none (FN-015 rank 26); the head keeps, the marker names the path. */
export const POST_COMPACT_MAX_TOKENS_PER_PLAN = 5_000

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.'
/** The post-compact ceiling refusal (FN-015 rank 26): the leading phrase is
 *  the stable key; the sentence carries the numbers. */
export const ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD = 'Compaction cannot bring the context under its threshold'
/** The exhausted-retries refusal (FN-015 rank 72): the old sentence sent
 *  the operator to "press esc twice" — the message selector's summarise
 *  action, which this build refuses for a managed session — so the only
 *  instructed recovery could not be performed. The roads named here exist
 *  in this build. */
export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'This conversation has outgrown one pass: after three narrowing retries the summariser itself was refused as too long. Start a fresh conversation with /clear, or switch to a model with a larger context window and run /compact again.'
export const ERROR_MESSAGE_USER_ABORT = 'Compaction canceled.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction was interrupted before a summary arrived — likely a network issue; try again.'

const PTL_RETRY_LIMIT = 3
const PTL_TRUNCATION_MARKER = '[earlier turns folded for the compaction retry]'
// The pre-migration marker spelling — recognized on read forever (persisted transcripts carry it), never emitted.
const LEGACY_PTL_TRUNCATION_MARKER = '[earlier conversation truncated for compaction retry]'
const KEEPALIVE_INTERVAL_MS = 30_000
const DEGRADED_SUMMARY_LENGTH = 80

// ---------------------------------------------------------------------------
// The mechanical fold profile
// ---------------------------------------------------------------------------
// The summary call is MECHANICAL: it never inherits the session's
// thinking/effort posture. The session may run xhigh with adaptive thinking;
// the fold is a bounded utility call — effort pinned low (each provider
// runtime maps the word onto its own wire vocabulary, or omits the parameter
// where the model has no dial), thinking disabled on the direct call, output
// bounded, and the whole fold under a wall-clock deadline plus (on the
// direct call, whose stream is visible here) an inter-event stall watchdog.
// The one deliberate exception: the cache-sharing fork inherits the
// session's THINKING CONFIG — that config is part of the provider cache key,
// and the fork exists solely to reuse the session's cached prefix — but its
// effort is pinned like everything else (a sampling parameter, cache-neutral).

/** The pinned fold effort — the resolution owner maps it per family. */
export const MECHANICAL_FOLD_EFFORT = 'low' as const
/** Wall-clock ceiling for one fold lane (fork and direct each get one). */
const FOLD_DEADLINE_MS = 10 * 60 * 1000
/** Direct-lane stall watchdog: no stream event for this long ⇒ wedged. */
const FOLD_STALL_MS = 120_000

export const ERROR_MESSAGE_FOLD_TIMEOUT =
  'The summary call stalled and was stopped — nothing was folded; the conversation stands as it was. Try again, or start fresh with /clear.'

let foldBoundsOverride: { deadlineMs: number; stallMs: number } | null = null
/** Proof seam: shrink the fold bounds so a wedged-wire leg settles fast. */
export function setFoldBoundsForTests(bounds: { deadlineMs: number; stallMs: number } | null): void {
  foldBoundsOverride = bounds
}

type FoldBound = {
  /** For runForkedAgent, which takes a controller. */
  controller: AbortController
  signal: AbortSignal
  /** Reset the stall watchdog — call per stream event. */
  touch(): void
  /** True when the deadline or the stall watchdog expired this bound. */
  hitDeadline(): boolean
  dispose(): void
}

/** One fold lane's time bound: aborts with the parent, at the wall-clock
 *  deadline, or when the stall watchdog runs dry between touches. */
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

/**
 * The fork admission, pure: the cache-sharing fork rides ONLY where the prompt
 * cache it protects lives — the home transport (anthropic ids, and
 * unrecognised strangers whose only road is the gateway home ride). Every
 * engine family folds through the direct mechanical call: those runtimes
 * have no client-keyed prefix cache to preserve, so the fork would buy
 * nothing and cost the session's posture. An explicit fixed thinking budget
 * also forces the direct lane — a fold under a mandatory thinking spend is
 * not mechanical, and the budget cannot be dropped without breaking the very
 * cache the fork exists for.
 */
export function shouldRideCacheSharingFork(model: string, thinkingConfig?: { type: string }): boolean {
  if (thinkingConfig?.type === 'enabled') return false
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'absence') return false
  if (verdict.kind === 'unrecognised') return true
  return verdict.route === 'anthropic'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionResult = {
  boundaryMarker: SystemCompactBoundaryMessage
  summaryMessages: UserMessage[]
  messagesToKeep?: Message[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  userDisplayMessage?: string
  preCompactTokenCount: number
  /** The compaction call's total usage — roughly the pre-compact count. */
  postCompactTokenCount: number
  /** The true post-compact context estimate. */
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

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

/** ONE fixed order: boundary, summaries, kept, attachments, hook results. */
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

/**
 * Preserved messages keep their original parent links on disk; the loader
 * patches head→anchor and the anchor's other children→tail from this.
 * No-ops on an empty keep list.
 */
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

/** Operator text first, hook text after a blank line; empties collapse. */
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

/**
 * The compact capsule class: a compact summary and the boundary that
 * anchors it stand for every turn folded before them. No head drop may
 * shed one — a retry that lost the capsule would write its new summary
 * over a half-history and never say so (FN-015 rank 25).
 */
export function isCompactCapsuleMessage(message: Message): boolean {
  return (
    isCompactBoundaryMessage(message) ||
    (message.type === 'user' && (message as UserMessage).isCompactSummary === true)
  )
}

/**
 * Drop the oldest API-round groups so the summarisation call itself fits.
 * Strictly shrinks on every call; null when it cannot make progress. The
 * capsule rows of every dropped group are retained ahead of the survivors,
 * in order: a retry sheds WORKING turns only.
 */
export function truncateHeadForPTLRetry(messages: Message[], ptlResponse: Message): Message[] | null {
  // Strip the synthetic marker first — otherwise it becomes its own leading
  // group and the proportional fallback stalls on it. A prior retry seats
  // it behind the retained capsule, so the strip reads the whole list.
  const input = messages.filter(message => !isPtlMarkerMessage(message))
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  // Only the working rows of a group count toward the gap: its capsule
  // rows are retained, so dropping them frees nothing.
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
    // Unknown gap (some gateway error formats): 20% of the groups, at least one.
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }
  // At least one group survives.
  dropCount = Math.min(dropCount, groups.length - 1)
  // A drop that would shed only capsule rows is no drop: walk on until a
  // working row goes (the last group always survives).
  while (dropCount > 0 && dropCount < groups.length - 1 && groups.slice(0, dropCount).flat().every(isCompactCapsuleMessage)) {
    dropCount++
  }
  if (dropCount <= 0) return null

  const dropped = groups.slice(0, dropCount).flat()
  const retained = dropped.filter(isCompactCapsuleMessage)
  if (retained.length === dropped.length) return null

  const survivors = groups.slice(dropCount).flat()
  if (survivors.length > 0 && survivors[0]?.type === 'assistant') {
    // Every later group starts with an assistant message and the API needs
    // the first message to be a user message. The marker seats between the
    // retained capsule and the survivors, where the fold happened.
    return [...retained, createUserMessage({ content: PTL_TRUNCATION_MARKER, isMeta: true }), ...survivors]
  }
  return [...retained, ...survivors]
}

/** Images/documents become text placeholders; media-free messages are identity. */
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

/** Identity in this build: the re-injected attachment kinds are compiled out. */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  return messages
}

/** Denies every tool: the compaction agent only produces a text summary. */
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

// ---------------------------------------------------------------------------
// Post-compact context restoration
// ---------------------------------------------------------------------------

function shouldExcludeFromPostCompactRestore(filename: string, agentId?: string): boolean {
  const normalizedFilename = expandPath(filename)
  try {
    if (normalizedFilename === expandPath(getPlanFilePath(agentId))) return true
  } catch {
    // Continue with the remaining checks.
  }
  // Instruction files anywhere plus rules directories (child-directory
  // instructions the top-level memory-path set misses).
  if (isInstructionFilePath(normalizedFilename)) return true
  // Belt and braces: the per-type canonical memory paths, so a non-standard
  // memory filename still excludes. Memory files are re-surfaced separately.
  try {
    const memoryPaths = MEMORY_TYPE_VALUES.map(memoryType => expandPath(getMemoryPath(memoryType)))
    if (memoryPaths.includes(normalizedFilename)) return true
  } catch {
    // Continue.
  }
  return false
}

/**
 * File paths already visible as READ tool results in the preserved
 * messages. Read alone: only a read result carries the whole file — an edit
 * reports a hunk and a write reports success — so treating those as
 * already-present would throw away the only surviving copy.
 */
function collectPreservedReadPaths(preserved: Message[]): Set<string> {
  // Unchanged-file dedup stubs point at an earlier read that may have been
  // compacted away; skip their tool uses so the content is re-injected.
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
    // Estimated over the SERIALISED attachment message; later attachments
    // are still tested, so a small one can follow a dropped large one.
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
  // Character budget: maxTokens × 4 (the estimator's 4-bytes-per-token
  // default) minus the marker length. Keep the HEAD — setup and usage
  // instructions live at the top.
  const budget = maxTokens * 4 - marker.length
  if (content.length <= budget) return { content, truncated: false }
  return { content: content.slice(0, Math.max(0, budget)) + marker, truncated: true }
}

function truncateSkillContent(content: string, maxTokens: number): { content: string; truncated: boolean } {
  return truncateToTokenCeiling(content, maxTokens, SKILL_TRUNCATION_MARKER)
}

// ---------------------------------------------------------------------------
// The post-compact ceiling (FN-015 rank 26)
// ---------------------------------------------------------------------------

/** The reconstruction classes the ceiling may shed, in shedding order:
 *  restored files first (the model can re-read them), then the invoked
 *  skills, then the plan reference. The boundary, the summary, the kept
 *  tail, the hook output and the announcement deltas are never shed. */
const POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES = ['file', 'compact_file_reference', 'invoked_skills', 'plan_file_reference'] as const

export type PostCompactFit = {
  result: CompactionResult
  /** The estimate over the whole post-compact context after the fit. */
  estimate: number
  /** What the fit shed, in order — empty when the result already fit. */
  shed: string[]
}

function describeAttachment(message: AttachmentMessage): string {
  const attachment = message.attachment as { type: string; filename?: string; planFilePath?: string }
  if (attachment.type === 'file' || attachment.type === 'compact_file_reference') return `file ${attachment.filename ?? '?'}`
  if (attachment.type === 'plan_file_reference') return `plan ${attachment.planFilePath ?? '?'}`
  return attachment.type
}

/**
 * A compaction must end UNDER the threshold that triggered it. The
 * reconstruction (restored files, skills, plan) is shed one attachment at
 * a time — largest of the class first — until the post-compact estimate
 * is under the threshold or nothing sheddable remains. The caller refuses
 * when the estimate is still over: the irreducible core (summary, kept
 * tail, hook output) alone exceeds the window's working band.
 */
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

/** The invoked-skills attachment, filtered against the CURRENT catalogue
 *  when one is given: a skill the operator de-applied — dialed off in
 *  /skills, or its SKILL.md deleted — used to come back into the freshly
 *  compacted context in full (up to 5,000 tokens per skill, 25,000 total)
 *  and the model resumed following instructions the user believed removed,
 *  with no way to clear them short of ending the session (FN-015 rank 61).
 *  Without a catalogue (a caller that has none) the capture is used as is. */
export function createSkillAttachmentIfNeeded(
  agentId?: string,
  catalogue?: ReadonlyArray<{ name: string }>,
): AttachmentMessage | null {
  const invoked = getInvokedSkillsForAgent(agentId)
  if (invoked.size === 0) return null
  const inCatalogue = (name: string): boolean => catalogue === undefined || catalogue.some(command => command.name === name)
  // Most-recently-invoked first so budget pressure drops the least relevant.
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

/**
 * Background local-agent tasks the model must know about after compaction:
 * still running (no duplicate spawn) or finished with results never
 * collected.
 */
export async function createAsyncAgentAttachmentsIfNeeded(context: ToolUseContext): Promise<AttachmentMessage[]> {
  const tasks = context.getAppState().tasks
  const attachments: AttachmentMessage[] = []
  for (const task of Object.values(tasks ?? {})) {
    const record = task as {
      id: string
      type: string
      status: string
      description: string
      agentId?: string
      retrieved?: boolean
      progress?: { summary?: string }
      error?: string
    }
    if (record.type !== 'local_agent') continue
    if (record.retrieved === true) continue
    if (record.status === 'pending') continue
    if (record.agentId !== undefined && record.agentId === context.agentId) continue
    attachments.push(
      createAttachmentMessage({
        type: 'task_status',
        taskId: record.agentId ?? record.id,
        taskType: 'local_agent',
        status: record.status as never,
        description: record.description,
        deltaSummary:
          record.status === 'running' ? (record.progress?.summary ?? null) : (record.error ?? null),
        outputFilePath: getTaskOutputPath(record.id),
      }),
    )
  }
  return attachments
}

// ---------------------------------------------------------------------------
// The summarisation call
// ---------------------------------------------------------------------------

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
      // NO maxOutputTokens: it clamps the thinking budget, changes the
      // thinking configuration, and invalidates the shared cache.
      skipCacheWrite: true,
      overrides: {
        abortController: bound.controller,
        // The mechanical effort pin, cache-neutrally: the fork's query loop
        // reads effortValue from app state, and effort is a sampling
        // parameter — pinning it low never touches the cached prefix the
        // fork exists to reuse. The prompt-shield wrap mirrors the
        // subagent-context default this override would otherwise displace.
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
    // The last assistant message counts ONLY if it exists, has text, and is
    // not an API error — an aborted compaction otherwise "succeeds" with the
    // abort text as its summary.
    if (last !== undefined && last.isApiErrorMessage !== true) {
      const text = getAssistantMessageText(last)
      if (text !== null && text !== '') return last
    }
    // An OVERFLOW refusal is an answer about SIZE, not about the lane: the
    // direct call would send the identical prefix and be refused the same
    // way, so it goes straight back to the truncate-and-retry loop instead
    // of costing a doubled refusal per attempt. Every other fault still
    // hands over to the direct call (a transient may differ per lane).
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

/**
 * The direct summarisation call, used when the cache-sharing fork produces
 * no usable summary. It rides routedCallModel — the ONE provider-aware seam
 * — so the request lands on the main model's own family wire (an OpenAI or
 * chat-completions session summarises on its own lane and wallet); an
 * Anthropic id reaches the transport through the router's home arm, the
 * same call with the same parameters. Every option below is family-neutral:
 * the output ceiling is the capability table's fact for the model, and each
 * runtime maps it onto its wire's own field.
 */
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

/** The fallback's attempt loop, under one armed fold bound. */
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
    // De-duplicated by name: MCP tools can collide with built-ins and the
    // API rejects duplicates.
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
      // Abandoned (rewound) explorations never feed the summarizer either
      // — the report message already carries what survives them.
      return projectRewoundWindows(sliced)
    })()
    const apiMessages = normalizeMessagesForAPI(
      stripImagesFromMessages(stripReinjectedAttachments([...afterBoundary, promptMessage])),
      context.options.tools,
    )

    let captured: AssistantMessage | undefined
    const stream = routedCallModel({
      messages: apiMessages,
      // The SESSION'S OWN posture prompt, exactly as the cache-sharing fork
      // rides it: a summary written under a generic summarizer prompt loses
      // the conversation's own instructions (an --agent session's persona, a
      // runner-hosted posture), and the two compaction lanes must not
      // disagree about whose conversation they are summarizing. The
      // summarization INSTRUCTION arrives as the prompt message. The
      // thinking/effort DIALS are the mechanical profile's, never the
      // session's (see the profile block above).
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
        // The summariser rides the conversation's frozen tool roster — the
        // tools array byte-for-byte, so the request is the conversation's
        // own prefix plus the summarization prompt (its thinking blocks
        // stay bound; the cache is shared, never re-billed).
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
      // The bound's own expiry surfaces as the typed fold-timeout sentence;
      // the operator's abort keeps its abort shape (the command road maps it
      // to the cancel sentence) — never each other's dress.
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
      // A fork felled by the operator's own abort must not spin up the
      // direct lane just to abort again — surface the abort here.
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
    }
    return summarizeViaStreamingFallback(messages, cacheSafeParams, promptMessage, context)
  })
}

/** The 3-attempt prompt-too-long truncate-and-retry loop. */
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
    // The fold itself overflowed: the home lane's content key, or any
    // family's typed overflow stamp (the summary call rides the session's
    // own provider, so the retry-by-truncation must read every wire).
    if (!text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && overflowSignalOf(response) === null) return response
    if (attempt === PTL_RETRY_LIMIT) break
    // Thread the truncated set through BOTH the direct messages parameter
    // and the fork path's context messages.
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

// ---------------------------------------------------------------------------
// Shared post-summary steps
// ---------------------------------------------------------------------------

function snapshotAndClearReadState(context: ToolUseContext): Record<string, { content: string; timestamp: number }> {
  const snapshot: Record<string, { content: string; timestamp: number }> = {}
  for (const [path, state] of context.readFileState.entries()) {
    snapshot[path] = { content: state.content, timestamp: state.timestamp }
  }
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()
  return snapshot
}

/** The files the kept tail preserves verbatim are excluded from
 *  re-attachment (their bytes are already in context) — but they leave the
 *  ledger with everything else at the clear, and nothing re-registered them:
 *  the edit the agent was about to make, on exactly the most recently
 *  touched files, refused "Read the file before editing it" and cost a
 *  re-read per file (FN-015 rank 58). Their whole ledger entries are
 *  written back — offset and limit included, so a partial read stays
 *  partial. */
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
  // The main conversation's user context rides as a PERSISTED row (utils/
  // attachments/userContext.ts). The post-compaction history must carry it
  // too: without it the per-request prepend would switch on for the rest of
  // the turn and off again at the next turn's producer — a first row that
  // moves, which the preserved-thinking check reads as an edit.
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

// ---------------------------------------------------------------------------
// Full compaction
// ---------------------------------------------------------------------------

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
  /** The overflow this fold answers (the recovery ladder's fold rung): the
   *  boundary row names it and carries the signal. The pre-compact hooks
   *  still see 'auto' — the fold IS automatic; their vocabulary is theirs. */
  overflow?: OverflowSignal,
): Promise<CompactionResult> {
  // The threshold that triggered this fold is the ceiling its result must
  // end under (FN-015 rank 26); absent (a caller with no threshold) ⇒ no
  // ceiling, the reconstruction budgets alone bound the result.
  const ceiling = recompactionInfo?.autoCompactThreshold
  const trigger = isAutoCompact ? 'auto' : 'manual'
  const boundaryTrigger: CompactMetadata['trigger'] = overflow !== undefined ? 'overflow' : trigger
  try {
    if (messages.length === 0) throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    const preCompactTokenCount = tokenCountWithEstimation(messages)

    // Pre-compact hooks.
    context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
    context.setSDKStatus?.('compacting')
    const preHook = await executePreCompactHooks(
      { trigger, customInstructions: customInstructions ?? null },
      context.abortController.signal,
    )
    const mergedInstructions = mergeHookInstructions(customInstructions, preHook.newCustomInstructions)

    // Summarisation.
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })
    void logPermissionContextForAnts(null, 'summary')
    const owner = ownerFromToolUseContext(context)
    const capsuleProbe = buildRunContinuationCapsule(owner)
    const promptText = getCompactPrompt(mergedInstructions, { runCapsulePresent: capsuleProbe !== null })
    const response = await summarizeWithPtlRetry(messages, cacheSafeParams, promptText, context)
    const rawSummary = validateSummary(response, true)

    // Verbatim recent tail (flag-gated, additive). Undefined when disabled or
    // when there is no meaningful tail — the compaction is then byte-identical
    // to the tail-free behaviour.
    let messagesToKeep: Message[] | undefined
    let tailPrecedingUuid: UUID | undefined
    if (isMercuryCompactKeepTailEnabled()) {
      const tail = computeVerbatimRecentTail(messages)
      if (tail !== null && tail.keep.length > 0) {
        // The kept rounds land BEHIND the fresh summary, so their thinking
        // blocks — bound to the full history they were minted against — would
        // be rejected or dropped by the preserved-thinking check on the very
        // next request. Text and tool calls carry across; thinking does not.
        messagesToKeep = stripThinkingFromIndex(tail.keep, 0)
        tailPrecedingUuid = tail.precedingUuid
        logForDebugging(`compact: verbatim tail keeps ${tail.roundsKept} rounds (${tail.keep.length} messages)`)
      }
    }

    // Cache invalidation (sent-skill tracking is deliberately NOT reset).
    // The release is AWAITED: the close sweep completes before compaction
    // returns, so the next turn cannot reopen a document into it.
    // The ledger's whole entries, kept aside: a fold refused at the ceiling
    // below hands them back.
    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    await releaseLspDocumentsForContext('compact_full')
    const postCompactFileAttachments = await assembleAttachments(snapshot, context, messagesToKeep ?? [], 'compact_full', ledgerBeforeFold)
    const hookResults = await runSessionStartHooks(context)

    // Boundary marker: with a tail it sits BETWEEN the summarised head and
    // the kept tail, anchored to the last summarised message.
    const lastMessage = messages[messages.length - 1] as Message
    const anchor = messagesToKeep !== undefined ? tailPrecedingUuid : lastMessage.uuid
    const boundary = createCompactBoundaryMessage(boundaryTrigger, preCompactTokenCount, anchor)
    if (overflow !== undefined) boundary.compactMetadata.overflow = overflow
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size > 0) boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()

    // Run continuation capsule.
    const capsule = buildRunContinuationCapsule(owner, Object.keys(snapshot))
    const degraded = rawSummary.trim().length < DEGRADED_SUMMARY_LENGTH
    const summaryWithCapsule = capsule !== null ? `${rawSummary}\n\n${capsule}` : rawSummary

    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summaryWithCapsule,
          suppressFollowUpQuestions,
          getTranscriptPath(),
          /* recentMessagesPreserved */ !!messagesToKeep,
        ),
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]
    // The tail is re-attached AFTER the summary (mirroring the up_to
    // partial direction): head = first kept, anchor = last summary message,
    // tail = last kept.
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
    // Estimated separately: the call's usage is NOT the size of the
    // resulting context — and the round estimator is not its size either
    // (it skips the string-content summary and every attachment: the
    // receipt's "after" figure read "180.0k to 12.0k" for a fold that
    // landed near 58k, and the same figure rode the context-epoch ledger —
    // FN-018 rank 9; the whole-context estimator is the one owner now).
    let truePostCompactTokenCount = estimateContextTokens(buildPostCompactMessages(partial))
    // The post-compact ceiling: a fold that ends at or over the threshold
    // that triggered it sheds its reconstruction until it fits, and refuses
    // when the irreducible core alone is over — the next request would
    // only come back rejected, and the refill breaker would then blame a
    // single oversized input that never existed.
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
        // The read ledger was cleared for a fold that will not land:
        // hand it back so the session keeps what it had read.
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
    // NOTE: the cache-read baseline reset is deliberately absent.
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
    // Auto-compaction retries next turn; the notification only confuses.
    if (!isAutoCompact) notifyCompactionError(context, err)
    throw err
  } finally {
    restoreAfterCompaction(context)
  }
}

// ---------------------------------------------------------------------------
// Partial compaction
// ---------------------------------------------------------------------------

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
      // Old boundaries and summaries KEPT in the prefix: the new summary sits
      // after them so the backward scan still works.
      kept = allMessages.slice(0, pivotIndex).filter(message => !isProgressMessage(message))
    } else {
      // The new boundary sits BEFORE everything kept, so any older boundary
      // in the kept set would be found first by the backward scan. The kept
      // rounds land behind the summary: their thinking blocks are bound to
      // the summarised history and cannot replay (the 'from' direction keeps
      // its prefix in place, so nothing is stripped there).
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
    // up_to: only the summarised prefix (hits the cache directly), fork
    // context narrowed to match; from: the whole conversation.
    const apiMessages = direction === 'up_to' ? summarize : allMessages
    const response = await summarizeWithPtlRetry(apiMessages, cacheSafeParams, promptText, context)
    const rawSummary = validateSummary(response, false)

    const ledgerBeforeFold = [...context.readFileState.entries()]
    const snapshot = snapshotAndClearReadState(context)
    await releaseLspDocumentsForContext('compact_partial')
    const attachments = await assembleAttachments(snapshot, context, kept, 'compact_partial', ledgerBeforeFold)
    const hookResults = await runSessionStartHooks(context)

    // Boundary anchoring: progress messages are skipped (not loggable).
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
      // The POST-compact hook's message alone.
      userDisplayMessage: postHook.userDisplayMessage,
      preCompactTokenCount,
      postCompactTokenCount: callUsageTotal,
      compactionUsage: usage,
    }
    // The true post figure, as the full fold computes it: the summarisation
    // call's billed usage is never the resulting context's size, and the
    // summary card rendered it as tokensAfter while the receipt line
    // dropped it — two surfaces for one operation disagreeing
    // (FN-018 rank 17).
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
