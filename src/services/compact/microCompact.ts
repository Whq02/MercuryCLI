import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'
import { digestClearedToolResult, isClearedOrDigested } from './microCompactDigest.js'
import { isBelowPlaceholderFloor, isProtectedFromPruning } from './pruneProtections.js'
import { clearCompactWarningSuppression, suppressCompactWarning } from './compactWarningState.js'
import { getTimeBasedMCConfig } from './timeBasedMCConfig.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { PROVIDER_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'

/**
 * Pre-request context shaping: the time-gap-triggered tool-result clearing
 * path, token estimation, and the owner-scoped cache-edit state. The legacy
 * per-turn microcompact path is absent and the cache-editing path is dormant —
 * auto-compaction handles context pressure instead.
 */

/**
 * Mirrors the storage module's cleared placeholder byte-for-byte; a test
 * asserts the two copies equal. Contract data.
 */
export const TIME_BASED_MC_CLEARED_MESSAGE = '[stale tool result pruned — content cleared]'

export type PendingCacheEdits = {
  userMessageIndex: number
  block: unknown
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    trigger: string
    deletedToolIds: string[]
    baselineCacheDeletedTokens: number | null
  }
  /** What the clearing walk actually cleared this call (absent when it
   *  cleared nothing) — the pressure prune's receipt reads these numbers. */
  pruned?: { cleared: number; tokensSaved: number; clearedIds: string[] }
}

/** The clearing walk's two triggers: the landed time gap, or PRESSURE — a
 *  request that overflowed the window (the recovery ladder's first rung).
 *  Pressure skips the gap/enabled/main-thread gates (the overflow IS the
 *  trigger and the caller is the turn machine, which knows its source) and
 *  keeps everything else: the keep-recent window, the protection law, the
 *  placeholder floor, the placeholder itself. */
export type MicrocompactTrigger = { pressure: true }

// ---------------------------------------------------------------------------
// Token estimation (also used by session-memory compaction)
// ---------------------------------------------------------------------------

const MEDIA_BLOCK_TOKENS = 2000

function estimateToolResultTokens(content: unknown): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content) {
    const record = item as { type?: string; text?: unknown }
    if (record.type === 'text') {
      total += roughTokenCountEstimation(String(record.text ?? ''))
    } else if (record.type === 'image' || record.type === 'document') {
      total += MEDIA_BLOCK_TOKENS
    }
  }
  return total
}

function estimateBlockTokens(block: unknown): number {
  const record = block as Record<string, unknown>
  switch (record.type) {
    case 'text':
      return roughTokenCountEstimation(String(record.text ?? ''))
    case 'tool_result':
      return estimateToolResultTokens(record.content)
    case 'image':
    case 'document':
      return MEDIA_BLOCK_TOKENS
    case 'thinking':
      // The thinking text only — the JSON wrapper and signature are
      // metadata, not tokenised content.
      return roughTokenCountEstimation(String(record.thinking ?? ''))
    case 'redacted_thinking':
      return roughTokenCountEstimation(String(record.data ?? ''))
    case 'tool_use':
      return roughTokenCountEstimation(
        `${String(record.name ?? '')}${JSON.stringify(record.input ?? null)}`,
      )
    default:
      return roughTokenCountEstimation(JSON.stringify(record) ?? '')
  }
}

/** Conservative: the per-block sum × 4/3, rounded up. */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) total += estimateBlockTokens(block)
  }
  return Math.ceil((total * 4) / 3)
}

/**
 * The whole context's estimate — every row by its wire form (FN-015 rank
 * 26): block arrays per block, string content by its text, attachments by
 * their serialised form (what the API view expands them into), system rows
 * by their content line. Progress rows never reach the wire. The per-round
 * estimator above skips string-content rows and attachments by design (it
 * sizes tool rounds); a post-compact context is MOSTLY those rows, so its
 * size needs this one.
 */
export function estimateContextTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    switch (message.type) {
      case 'user':
      case 'assistant': {
        const content = (message as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) total += estimateBlockTokens(block)
        } else if (typeof content === 'string') {
          total += roughTokenCountEstimation(content)
        }
        break
      }
      case 'attachment':
        total += roughTokenCountEstimation(JSON.stringify((message as { attachment?: unknown }).attachment ?? null))
        break
      case 'system': {
        const content = (message as { content?: unknown }).content
        total += roughTokenCountEstimation(typeof content === 'string' ? content : '')
        break
      }
      default:
        break
    }
  }
  return Math.ceil((total * 4) / 3)
}

// ---------------------------------------------------------------------------
// The time-based trigger
// ---------------------------------------------------------------------------

const MAIN_THREAD_PREFIX = 'repl_main_thread'

function isMainThreadSource(querySource: string | undefined): boolean {
  return querySource === undefined || querySource.startsWith(MAIN_THREAD_PREFIX)
}

export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: string | undefined,
): { gapMinutes: number; config: ReturnType<typeof getTimeBasedMCConfig> } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled) return null
  // Stricter than the main-thread predicate: analysis-only callers
  // (/context, /compact, context analysis) pass NO source and must not
  // trigger a real change.
  if (querySource === undefined) return null
  if (!isMainThreadSource(querySource)) return null

  let lastAssistant: Message | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === 'assistant') {
      lastAssistant = messages[index]
      break
    }
  }
  if (lastAssistant === undefined) return null
  const timestamp = Date.parse((lastAssistant as { timestamp?: string }).timestamp ?? '')
  const gapMinutes = (Date.now() - timestamp) / 60_000
  if (!Number.isFinite(gapMinutes)) return null
  if (gapMinutes < config.thresholdMinutes) return null
  return { gapMinutes, config }
}

const COMPACTABLE_TOOL_NAMES = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  PROVIDER_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * Pure projection, zero side effects — the request planner's inspect mode
 * and the live apply path share it so `/context` can never diverge from the
 * request.
 */
export function projectTimeBasedMicrocompact(
  messages: Message[],
  querySource: string | undefined,
  trigger?: MicrocompactTrigger,
): {
  messages: Message[]
  cleared: number
  tokensSaved: number
  /** 0 under the pressure trigger (no gap was measured). */
  gapMinutes: number
  /** File paths (as the tool input spelled them) whose FileReadTool results
   *  this projection cleared — the read-dedup ledger must stop vouching for
   *  them (delivery truth: a cleared result is no longer "above"). */
  clearedReadPaths: string[]
  /** The tool-use ids whose results were cleared, in encounter order. */
  clearedIds: string[]
} | null {
  const fired =
    trigger?.pressure === true
      ? { gapMinutes: 0, config: getTimeBasedMCConfig() }
      : evaluateTimeBasedTrigger(messages, querySource)
  if (fired === null) return null

  // Compactable tool-use ids in encounter order. The NAMED protection law
  // (pruneProtections) is consulted per use: a protected class never joins
  // the candidate list, whatever the allow-list says.
  const compactableIds: string[] = []
  // FileReadTool uses by id — when one of these results is actually cleared
  // below, its file path joins clearedReadPaths so the caller can invalidate
  // the read-dedup entry (the "file unchanged" stub must never point at a
  // result this clear just removed from the model's view).
  const readPathById = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; id?: string; name?: string; input?: unknown }
      if (record.type === 'tool_use' && typeof record.id === 'string' && typeof record.name === 'string') {
        if (
          COMPACTABLE_TOOL_NAMES.has(record.name) &&
          !isProtectedFromPruning(record.name, record.input)
        ) {
          compactableIds.push(record.id)
          if (record.name === FILE_READ_TOOL_NAME) {
            const filePath = (record.input as { file_path?: unknown } | undefined)?.file_path
            if (typeof filePath === 'string') readPathById.set(record.id, filePath)
          }
        }
      }
    }
  }

  // Keep the last max(1, keepRecent): a configured zero must NOT clear
  // everything (no working context) and must NOT (via a negative slice
  // offset) clear nothing.
  const keepCount = Math.max(1, fired.config.keepRecent)
  const clearSet = new Set(compactableIds.slice(0, Math.max(0, compactableIds.length - keepCount)))
  if (clearSet.size === 0) return null

  let tokensSaved = 0
  let cleared = 0
  const clearedReadPaths: string[] = []
  const clearedIds: string[] = []
  const projected = messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return message
    let touched = false
    const rebuilt = content.map(rawBlock => {
      const block = rawBlock as { type?: string; tool_use_id?: string; content?: never }
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        clearSet.has(block.tool_use_id) &&
        !isClearedOrDigested(block.content) &&
        // The floor law: a result the placeholder would not undercut
        // stays — blanking it is a net token loss.
        !isBelowPlaceholderFloor(estimateToolResultTokens(block.content))
      ) {
        touched = true
        cleared++
        tokensSaved += estimateToolResultTokens(block.content)
        clearedIds.push(block.tool_use_id)
        const readPath = readPathById.get(block.tool_use_id)
        if (readPath !== undefined) clearedReadPaths.push(readPath)
        return { ...block, content: digestClearedToolResult(block.content) }
      }
      return rawBlock
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...(message as { message: object }).message, content: rebuilt },
    } as Message
  })

  if (tokensSaved === 0) return null
  // A cleared result is an edit of an earlier turn: every thinking block
  // after the first cleared message is bound to the un-cleared bytes and
  // would be rejected or dropped by the preserved-thinking check. Strip that
  // run here so the request is valid by construction (the blocks before the
  // first clear keep their prefix and stay).
  const firstCleared = projected.findIndex((message, index) => message !== messages[index])
  const withValidThinking = firstCleared === -1 ? projected : stripThinkingFromIndex(projected, firstCleared)
  return { messages: withValidThinking, cleared, tokensSaved, gapMinutes: fired.gapMinutes, clearedReadPaths, clearedIds }
}

// ---------------------------------------------------------------------------
// Owner-scoped cache-edit state (inert while cache editing stays dormant)
// ---------------------------------------------------------------------------

type CacheEditState = {
  registeredToolIds: string[]
  pinnedEdits: PendingCacheEdits[]
  pendingEdits: PendingCacheEdits | null
}

const cacheEditStore = new OwnerScopedStore<CacheEditState>({
  name: 'microcompact-cache-edits',
  create: () => ({ registeredToolIds: [], pinnedEdits: [], pendingEdits: null }),
})

function ownerOrMain(owner: OwnerKey | undefined): OwnerKey {
  // Callers written before owners were threaded pass none and are served
  // the process main owner.
  return owner ?? processMainOwner()
}

/** Returns and clears the pending edits block. */
export const consumePendingCacheEdits: (owner?: OwnerKey) => PendingCacheEdits | null = function (
  owner,
) {
  const state = cacheEditStore.get(ownerOrMain(owner))
  const pending = state.pendingEdits
  state.pendingEdits = null
  return pending
}

/** Empty when the owner has no cached state. */
export const getPinnedCacheEdits: (owner?: OwnerKey) => PendingCacheEdits[] = function (owner) {
  const state = cacheEditStore.peek(ownerOrMain(owner))
  return state === undefined ? [] : state.pinnedEdits
}

export const pinCacheEdits: (
  userMessageIndex: number,
  block: unknown,
  owner?: OwnerKey,
) => void = function (userMessageIndex, block, owner) {
  const state = cacheEditStore.get(ownerOrMain(owner))
  state.pinnedEdits.push({ userMessageIndex, block })
}

/** Mark registered tools as sent after a successful response. */
export const markToolsSentToAPIState: (owner?: OwnerKey) => void = function (owner) {
  const state = cacheEditStore.peek(ownerOrMain(owner))
  if (state === undefined) return
  state.registeredToolIds = []
}

/**
 * Reset ONE owner's state — peeks rather than creating, and no-ops when
 * there is no slot. When a subagent compacts, the reset lands on its slot
 * only and leaves the main thread's pinned edits standing.
 */
export const resetMicrocompactState: (owner?: OwnerKey) => void = function (owner) {
  const key = ownerOrMain(owner)
  const state = cacheEditStore.peek(key)
  if (state === undefined) return
  state.registeredToolIds = []
  state.pinnedEdits = []
  state.pendingEdits = null
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function microcompactMessages(
  messages: Message[],
  _toolUseContext?: unknown,
  querySource?: string,
  invalidate?: {
    /** The read-dedup ledger (ToolUseContext.readFileState). Threaded by the
     *  APPLY-mode request plan only — inspection stays side-effect free. */
    readFileState: Pick<FileStateCache, 'delete'>
  },
  trigger?: MicrocompactTrigger,
): Promise<MicrocompactResult> {
  // A new attempt is starting.
  clearCompactWarningSuppression()

  const projected = projectTimeBasedMicrocompact(messages, querySource, trigger)
  if (projected !== null) {
    // Live-wrapper side effects.
    const config = getTimeBasedMCConfig()
    logForDebugging(
      trigger?.pressure === true
        ? `pressure microcompact (context overflow): cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`
        : `time-based microcompact: gap ${Math.round(projected.gapMinutes)}min ≥ ${config.thresholdMinutes}min — cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`,
    )
    suppressCompactWarning()
    // The cleared entries invalidate tool ids registered on earlier turns.
    // No owner is threaded here: the process main owner's slot resets.
    resetMicrocompactState()
    // Delivery truth: a cleared FileReadTool result no longer rides the
    // model's view, so the read-dedup ledger must stop vouching for it —
    // otherwise the next Read of that window answers the "file unchanged,
    // lean on the earlier result above" stub while the earlier result is
    // the cleared placeholder (the dead-turn incident's read
    // half: reads "rejected as duplicates" whose content never reached the
    // model again). Both spellings are deleted: the read keyed the entry
    // under expandPath(input) at read-time cwd; the raw spelling covers a
    // relative input whose cwd has since moved.
    if (invalidate) {
      for (const clearedPath of projected.clearedReadPaths) {
        invalidate.readFileState.delete(expandPath(clearedPath))
        invalidate.readFileState.delete(clearedPath)
      }
    }
    // NOTE: the cache-break deletion notifier is deliberately
    // NOT called here — its call site was removed; restoring it is an
    // operator decision.
    return {
      messages: projected.messages,
      pruned: { cleared: projected.cleared, tokensSaved: projected.tokensSaved, clearedIds: projected.clearedIds },
    }
  }

  return { messages }
}
