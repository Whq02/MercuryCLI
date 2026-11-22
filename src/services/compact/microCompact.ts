import { isThinkingBlock } from '../messages/apiFilters.js'
import type { DeadThinkingMark } from '../../types/message.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import { registerOwnerScopedStore } from '../../utils/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../utils/run/ownerScopedStore.js'
import { estimateContentTokens, roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { stripThinkingFromIndex } from '../messages/apiFilters.js'
import { digestClearedToolResult, isClearedOrDigested } from './microCompactDigest.js'
import { isBelowPlaceholderFloor, isProtectedFromPruning, PROTECT_NEWEST_TOOL_OUTPUT_TOKENS, PRUNE_MINIMUM_SAVING_TOKENS } from './pruneProtections.js'
import { clearCompactWarningSuppression, suppressCompactWarning } from './compactWarningState.js'
import { getTimeBasedMCConfig } from './timeBasedMCConfig.js'
import { REPEATED_RESULT_TAG } from '../../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tools/fileRead.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export const TIME_BASED_MC_CLEARED_MESSAGE = '[stale tool result pruned — content cleared]'

type PendingCacheEdits = {
  userMessageIndex: number
  block: unknown
}

type MicrocompactResult = Unbuilt

type MicrocompactTrigger = Unbuilt

export function estimateMessageTokens(messages: Message[]): number {
  return notBuilt('src/services/compact/microCompact.ts:46')
}

export function estimateContextTokens(messages: Message[], model?: string): number {
  return roughTokenCountEstimationForMessages(messages, model)
}


const MAIN_THREAD_PREFIX = 'main_thread'

function isMainThreadSource(querySource: string | undefined): boolean {
  return querySource === undefined || querySource.startsWith(MAIN_THREAD_PREFIX)
}

function evaluateTimeBasedTrigger(
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

const PERSISTED_PATH_PHRASE = 'Full output saved to: '

function persistedReferenceOf(content: unknown): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(item => ((item as { type?: string }).type === 'text' ? String((item as { text?: unknown }).text ?? '') : '')).join('\n')
        : ''
  const at = text.indexOf(PERSISTED_PATH_PHRASE)
  if (at === -1) return undefined
  const start = text.lastIndexOf('\n', at) + 1
  const end = text.indexOf('\n', at)
  return text.slice(start, end === -1 ? undefined : end)
}

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
  deadMarks: DeadThinkingMark[]
} | null {
  return notBuilt('src/services/compact/microCompact.ts:108')
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
registerOwnerScopedStore(cacheEditStore)

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
  return notBuilt('src/services/compact/microCompact.ts:310')
}
