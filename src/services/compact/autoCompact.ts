import type { ToolUseContext } from '../../Tool.js'
import { beginQueuedCompact } from '../../input-core/command-queue.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { isMercurySubstrateProfileOn } from '../../utils/config/derived.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { CacheSafeParams } from '../agents/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { awaitContextWindowSource } from '../context/contextWindowWarmup.js'
import { getTokenUsage, tokenCountWithEstimation, usageAnchorModel } from '../context/tokens.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { registerOwnerScopedStore } from '../../utils/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../utils/run/ownerScopedStore.js'
import { readRequestGauge } from '../run/requestGauge.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { usabilityForRoute } from '../providers/providerUsability.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import type { CompactionState } from './compactionPolicy.js'
import type { CompactionResult } from './compact.js'
import { crewmateCompactNothingWords } from '../../utils/cockpit/crewmateWords.js'
import { estimateMessageTokens } from './microCompact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction, shouldUseSessionMemoryCompaction } from './sessionMemoryCompact.js'
import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { calculateTokenWarningState, getAutoCompactThreshold, getAutoCompactThresholdWithFixed, getBlockingLimit, getEffectiveContextWindowSize, isAutoCompactEnabled, SUMMARY_RESERVE_MAX_WINDOW_DIVISOR, thresholdOverridden } from '../../utils/compact/autoCompactWindow.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
export { MIN_AUTOCOMPACT_WINDOW, MAX_AUTOCOMPACT_WINDOW, WARNING_THRESHOLD_BUFFER_TOKENS, MANUAL_COMPACT_BUFFER_TOKENS, AUTOCOMPACT_BUFFER_TOKENS, autoCompactWindowIsInputLimit, resolveAutoCompactWindow, getEffectiveContextWindowSize, getTurnReserveTokens, getAutoCompactThreshold, getAutoCompactThresholdWithFixed, autoCompactDisabledReason, isAutoCompactEnabled, compactionSettingsText, getBlockingLimit, calculateTokenWarningState } from '../../utils/compact/autoCompactWindow.js'
export type { AutoCompactWindowSource, TokenWarningLevel } from '../../utils/compact/autoCompactWindow.js'


void notifyCompaction


const MAX_CONSECUTIVE_FAILURES = 3
const RAPID_REFILL_TURN_WINDOW = 2
const RAPID_REFILL_LIMIT = 3

export const COMPACTION_PAUSED_KEY = 'automatic compaction failed'

type CompactableTask = { type?: string; compactRequested?: boolean; description?: string }

export function operatorCompactionAsked(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): boolean {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return false
  const task = toolUseContext.getAppState().tasks?.[agentId] as CompactableTask | undefined
  return task?.type === 'local_agent' && task.compactRequested === true
}

function askingCrewmateName(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): string {
  const agentId = toolUseContext.agentId
  const task = agentId === undefined ? undefined : (toolUseContext.getAppState().tasks?.[agentId] as CompactableTask | undefined)
  return task?.description !== undefined && task.description !== '' ? task.description : String(agentId ?? 'the crewmate')
}

export function takeOperatorCompactionAsk(toolUseContext: Pick<ToolUseContext, 'agentId' | 'setAppState' | 'setAppStateForTasks'>): void {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return
  updateTaskState(agentId, toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState, task => {
    if ((task as CompactableTask).compactRequested !== true) return task
    const { compactRequested: _taken, ...rest } = task as typeof task & CompactableTask
    return rest as typeof task
  })
}

export function compactionBreakerText(opts: { nonInteractive: boolean }): string {
  const byHand = opts.nonInteractive ? 'The' : '/compact folds the conversation by hand; the'
  const next = opts.nonInteractive ? 'prompt' : 'message'
  return `${COMPACTION_PAUSED_KEY} ${MAX_CONSECUTIVE_FAILURES} times in a row and is paused for the rest of this run. ${byHand} next ${next} makes a fresh automatic attempt.`
}

export const AUTOCOMPACT_THRASH_MESSAGE =
  `Auto-compaction is looping: the context refilled within ${RAPID_REFILL_TURN_WINDOW - 1} turn of each fold ` +
  `${RAPID_REFILL_LIMIT} times in a row — each turn brings in more than a fold can free, ` +
  `a file read or a tool output larger than the room a fold leaves.`

export function rapidRefillPauseText(opts: { nonInteractive: boolean }): string {
  const remedy = opts.nonInteractive
    ? 'read in smaller pieces, or start a fresh run'
    : 'read in smaller pieces, /compact folds the conversation by hand, and the next message makes a fresh automatic attempt'
  return `Automatic compaction is paused for the rest of this run; ${remedy}.`
}

export type AutoCompactTrackingState = Unbuilt


export type FoldModelChoice = { model: string; source: 'seated' | 'history' | 'helper'; count: number; reason?: string }

function helperFoldModel(): string | undefined {
  try {
    const { helperCompactionModelId } = require('../providers/local/tensorfoldHelper.js') as typeof import('../providers/local/tensorfoldHelper.js')
    return helperCompactionModelId()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function seatedLocalServing(seated: string): boolean {
  try {
    const { localRecordFor } = require('../providers/local/localCatalogue.js') as typeof import('../providers/local/localCatalogue.js')
    const record = localRecordFor(seated)
    return record !== undefined && record.loaded !== false
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function foldModelFor(messages: readonly Message[], seated: string, opts: { forced: boolean }): FoldModelChoice {
  const count = Math.max(tokenCountWithEstimation(messages, seated), tokenCountWithEstimation(messages))
  const helper = helperFoldModel()
  if (helper !== undefined && helper !== seated) {
    if (seatedLocalServing(seated) && count < getBlockingLimit(seated)) {
      logForDebugging(`compaction: the seated ${seated} is the strongest serving local model and holds the history (about ${count} tokens by Mercury's count) — it folds, not the helper ${helper}`)
      return { model: seated, source: 'seated', count }
    }
    if (count < getBlockingLimit(helper)) return { model: helper, source: 'helper', count }
    const reason = `the helper ${helper}'s window does not hold the history (about ${count} tokens by Mercury's count) — the seated ${seated} folds it`
    logForDebugging(`compaction: ${reason}`)
    if (!opts.forced && count < getBlockingLimit(seated)) return { model: seated, source: 'seated', count, reason }
  }
  const onSeat: FoldModelChoice = { model: seated, source: 'seated', count }
  if (!opts.forced && count < getBlockingLimit(seated)) return onSeat
  const stamped = usageAnchorModel(messages)
  if (stamped === undefined || stamped === seated) return onSeat
  const route = declaredRouteOf(stamped)
  if (route === null || !usabilityForRoute(route).usable) return onSeat
  if (count >= getBlockingLimit(stamped)) return onSeat
  return { model: stamped, source: 'history', count }
}

export function rapidRefillCount(tracking?: AutoCompactTrackingState): number {
  if (!tracking) return 0
  if (tracking.compacted && tracking.turnCounter < RAPID_REFILL_TURN_WINDOW) {
    return (tracking.consecutiveRapidRefills ?? 0) + 1
  }
  return 0
}

export function detectFixedPrefixOverflow(
  messages: Message[],
  model: string,
  snipTokensFreed: number = 0,
  fixedTokens: number = 0,
): { prefixTokens: number; thresholdTokens: number; documentBlockCount: number; imageBlockCount: number } | null {
  let lastUsage: ReturnType<typeof getTokenUsage> | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    lastUsage = getTokenUsage(messages[index])
    if (lastUsage !== undefined) break
  }
  if (lastUsage === undefined) return null
  const totalInput =
    (lastUsage.input_tokens ?? 0) +
    (lastUsage.cache_read_input_tokens ?? 0) +
    (lastUsage.cache_creation_input_tokens ?? 0)
  const estimate = estimateMessageTokens(messages)
  const prefixTokens = Math.min(
    Math.max(0, totalInput - snipTokensFreed - estimate),
    getEffectiveContextWindowSize(model),
  )
  const thresholdTokens = getAutoCompactThresholdWithFixed(model, fixedTokens)
  if (prefixTokens <= thresholdTokens) return null

  let documentBlockCount = 0
  let imageBlockCount = 0
  const countBlocks = (blocks: unknown[]): void => {
    for (const block of blocks) {
      const record = block as { type?: string; content?: unknown }
      if (record.type === 'document') documentBlockCount++
      else if (record.type === 'image') imageBlockCount++
      else if (record.type === 'tool_result' && Array.isArray(record.content)) countBlocks(record.content)
    }
  }
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = (message as AssistantMessage).message.content
    if (Array.isArray(content)) countBlocks(content)
  }
  return { prefixTokens, thresholdTokens, documentBlockCount, imageBlockCount }
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: string,
  snipTokensFreed: number = 0,
  onMeasured?: (rawTokenCount: number) => void,
): Promise<boolean> {
  if (querySource === 'session_memory' || querySource === 'compact') return false
  if (!isAutoCompactEnabled()) return false
  const tokenCount = tokenCountWithEstimation(messages, model) - snipTokensFreed
  const known = await awaitContextWindowSource(model, { estTokens: tokenCount + snipTokensFreed })
  onMeasured?.(tokenCount + snipTokensFreed)
  if (!known) {
    logForDebugging(`autoCompact: the window of ${model} is not known yet — no decision against the default`)
    return false
  }
  const threshold = getAutoCompactThreshold(model)
  const effective = getEffectiveContextWindowSize(model)
  logForDebugging(
    `autoCompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effective}${
      snipTokensFreed !== 0 ? ` snipAdjustment=${snipTokensFreed}` : ''
    }`,
  )
  const { level } = calculateTokenWarningState(tokenCount, model)
  return level === 'compact' || level === 'blocked'
}


function ctxCompactionFlagOn(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION'))
}

function suppressBreakerEnabled(): boolean {
  return ctxCompactionFlagOn() || isMercurySubstrateProfileOn()
}

function advanceTriggerEnabled(): boolean {
  return ctxCompactionFlagOn()
}

const advanceState = new OwnerScopedStore<CompactionState>({
  name: 'autocompact-advance',
  create: () => ({ lastFiredTurn: null, rearmed: true }),
})
registerOwnerScopedStore(advanceState)

const fixedMaterialSkipState = new OwnerScopedStore<{ noted: boolean }>({
  name: 'autocompact-fixed-material-skip',
  create: () => ({ noted: false }),
})
registerOwnerScopedStore(fixedMaterialSkipState)


export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
  overflowSignal?: OverflowSignal,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
  rapidRefillBreakerTripped?: boolean
  measuredRawTokenCount?: number | null
  refusal?: string
  paused?: true
  declined?: true
}> {
  return notBuilt('src/services/compact/autoCompact.ts:268')
}
