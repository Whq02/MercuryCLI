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
  pruned?: { cleared: number; tokensSaved: number; clearedIds: string[] }
}

export type MicrocompactTrigger = { pressure: true }


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

export function projectTimeBasedMicrocompact(
  messages: Message[],
  querySource: string | undefined,
  trigger?: MicrocompactTrigger,
): {
  messages: Message[]
  cleared: number
  tokensSaved: number
  gapMinutes: number
  clearedReadPaths: string[]
  clearedIds: string[]
} | null {
  const fired =
    trigger?.pressure === true
      ? { gapMinutes: 0, config: getTimeBasedMCConfig() }
      : evaluateTimeBasedTrigger(messages, querySource)
  if (fired === null) return null

  const compactableIds: string[] = []
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
  const firstCleared = projected.findIndex((message, index) => message !== messages[index])
  const withValidThinking = firstCleared === -1 ? projected : stripThinkingFromIndex(projected, firstCleared)
  return { messages: withValidThinking, cleared, tokensSaved, gapMinutes: fired.gapMinutes, clearedReadPaths, clearedIds }
}


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
  return owner ?? processMainOwner()
}

export const consumePendingCacheEdits: (owner?: OwnerKey) => PendingCacheEdits | null = function (
  owner,
) {
  const state = cacheEditStore.get(ownerOrMain(owner))
  const pending = state.pendingEdits
  state.pendingEdits = null
  return pending
}

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

export const markToolsSentToAPIState: (owner?: OwnerKey) => void = function (owner) {
  const state = cacheEditStore.peek(ownerOrMain(owner))
  if (state === undefined) return
  state.registeredToolIds = []
}

export const resetMicrocompactState: (owner?: OwnerKey) => void = function (owner) {
  const key = ownerOrMain(owner)
  const state = cacheEditStore.peek(key)
  if (state === undefined) return
  state.registeredToolIds = []
  state.pinnedEdits = []
  state.pendingEdits = null
}


export async function microcompactMessages(
  messages: Message[],
  _toolUseContext?: unknown,
  querySource?: string,
  invalidate?: {
    readFileState: Pick<FileStateCache, 'delete'>
  },
  trigger?: MicrocompactTrigger,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  const projected = projectTimeBasedMicrocompact(messages, querySource, trigger)
  if (projected !== null) {
    const config = getTimeBasedMCConfig()
    logForDebugging(
      trigger?.pressure === true
        ? `pressure microcompact (context overflow): cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`
        : `time-based microcompact: gap ${Math.round(projected.gapMinutes)}min ≥ ${config.thresholdMinutes}min — cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`,
    )
    suppressCompactWarning()
    resetMicrocompactState()
    if (invalidate) {
      for (const clearedPath of projected.clearedReadPaths) {
        invalidate.readFileState.delete(expandPath(clearedPath))
        invalidate.readFileState.delete(clearedPath)
      }
    }
    return {
      messages: projected.messages,
      pruned: { cleared: projected.cleared, tokensSaved: projected.tokensSaved, clearedIds: projected.clearedIds },
    }
  }

  return { messages }
}
