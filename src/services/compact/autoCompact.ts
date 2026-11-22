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
import {
  compactionBreakerAllows,
  type CompactionState,
  decideCompaction,
  percentUsedFromPercentLeft,
} from './compactionPolicy.js'
import {
  compactConversation,
  buildPostCompactMessages,
  compactionPausedForHistoryText,
  CompactionRefusedForHistoryError,
  estimateFixedRequestTokens,
  type CompactionResult,
  ERROR_MESSAGE_USER_ABORT,
  foldRemedyIsHeadless,
  isNothingToCompactMessage,
  isRefold,
  manualFoldHasNothingToFold,
  nothingToCompactLine,
  nothingToCompactReason,
  projectManualFold,
  type RecompactionInfo,
  withFoldStatus,
} from './compact.js'
import { crewmateCompactNothingWords } from '../../utils/cockpit/crewmateWords.js'
import { estimateMessageTokens } from './microCompact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction, shouldUseSessionMemoryCompaction } from './sessionMemoryCompact.js'
import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { calculateTokenWarningState, getAutoCompactThreshold, getAutoCompactThresholdWithFixed, getBlockingLimit, getEffectiveContextWindowSize, isAutoCompactEnabled, SUMMARY_RESERVE_MAX_WINDOW_DIVISOR, thresholdOverridden } from '../../utils/compact/autoCompactWindow.js'
import { passedOver } from '../../utils/passedOver.js'
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

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
  rapidRefillPaused?: true
}


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
  snipTokensFreed: number = 0,
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
  const notCompacted = { wasCompacted: false as const, consecutiveFailures: tracking?.consecutiveFailures }
  const forced = overflowSignal !== undefined
  if (!flagEnabled('MERCURY_COMPACT')) {
    return forced ? { ...notCompacted, refusal: 'compaction is disabled (MERCURY_COMPACT=0)' } : notCompacted
  }
  const failures = tracking?.consecutiveFailures ?? 0
  const nonInteractive = foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession)
  if (tracking?.rapidRefillPaused === true) {
    return forced ? { ...notCompacted, refusal: rapidRefillPauseText({ nonInteractive }) } : notCompacted
  }
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return forced ? { ...notCompacted, refusal: compactionBreakerText({ nonInteractive }) } : notCompacted
  }
  if (suppressBreakerEnabled() && !compactionBreakerAllows(failures)) {
    logForDebugging('autoCompact: Mercury breaker suppressed a doomed retry')
    return forced ? { ...notCompacted, refusal: compactionBreakerText({ nonInteractive }) } : notCompacted
  }

  const model = toolUseContext.options.engineModel
  let measuredRawTokenCount: number | null = null
  let fixedTokens: number | undefined
  let fixedMaterialHeld = false
  const measureFixed = async (): Promise<number> => readRequestGauge(messages, model)?.fixed.tokens ?? estimateFixedRequestTokens(toolUseContext, cacheSafeParams)
  const noteFixedSkip = (message: string): void => {
    const slot = fixedMaterialSkipState.get(ownerFromToolUseContext(toolUseContext))
    if (slot.noted) return
    slot.noted = true
    logForDebugging(message)
  }
  const askedByOperator = operatorCompactionAsked(toolUseContext)
  if (askedByOperator) {
    takeOperatorCompactionAsk(toolUseContext)
    logForDebugging(`autoCompact: crewmate ${String(toolUseContext.agentId)} folds now — the operator asked for it from the crew view${forced ? ' (the overflow fold at this boundary is the one fold)' : ''}`)
  }
  let asked = askedByOperator && !forced
  let compact: boolean
  if (forced) {
    if (querySource === 'session_memory' || querySource === 'compact') {
      return { ...notCompacted, refusal: 'the summary forks never fold themselves' }
    }
    logForDebugging(
      `autoCompact: overflow fold forced (${overflowSignal.source} · ${overflowSignal.family} · ${overflowSignal.shape}${overflowSignal.actualTokens !== undefined && overflowSignal.limitTokens !== undefined ? ` · ${overflowSignal.actualTokens} > ${overflowSignal.limitTokens}` : ''})`,
    )
    compact = true
  } else if (asked) {
    compact = messages.length > 0
  } else {
    compact = await shouldAutoCompact([...messages, ...(cacheSafeParams.postFoldCarry ?? [])], model, querySource, snipTokensFreed, raw => {
      measuredRawTokenCount = raw
    })
    if (compact && messages.length === 0) return { ...notCompacted, measuredRawTokenCount }
    if (compact && !thresholdOverridden()) {
      fixedTokens = await measureFixed()
      const tokenCount = (measuredRawTokenCount ?? tokenCountWithEstimation([...messages, ...(cacheSafeParams.postFoldCarry ?? [])], model)) - snipTokensFreed
      const blocking = getBlockingLimit(model)
      const oneTurn = Math.ceil(blocking / SUMMARY_RESERVE_MAX_WINDOW_DIVISOR)
      const threshold = getAutoCompactThresholdWithFixed(model, fixedTokens)
      if (fixedTokens + oneTurn > blocking) {
        noteFixedSkip(`autoCompact: skipping — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurn} tokens) exceeds the window's room (${blocking} tokens)`)
        compact = false
        fixedMaterialHeld = true
      } else if (tokenCount < threshold) {
        noteFixedSkip(`autoCompact: skipping at ${tokenCount} tokens — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurn} tokens) raises the fold point to ${threshold} tokens`)
        compact = false
        fixedMaterialHeld = true
      }
    }
  }

  if (!compact && !fixedMaterialHeld && advanceTriggerEnabled() && isAutoCompactEnabled()) {
    if (querySource !== 'session_memory' && querySource !== 'compact' && querySource !== 'context_agent') {
      try {
        const tokenCount = (measuredRawTokenCount ?? tokenCountWithEstimation([...messages, ...(cacheSafeParams.postFoldCarry ?? [])], model)) - snipTokensFreed
        const { pctLeft } = calculateTokenWarningState(tokenCount, model)
        const owner = ownerFromToolUseContext(toolUseContext)
        const slot = advanceState.get(owner)
        const decision = decideCompaction({
          usage: { percentage: percentUsedFromPercentLeft(pctLeft ?? 100) },
          state: slot,
          turn: tracking?.turnCounter,
        })
        slot.lastFiredTurn = decision.state.lastFiredTurn
        slot.rearmed = decision.state.rearmed
        if (decision.action === 'compact') compact = true
      } catch (err) {
        logError(err)
      }
    }
  }
  const queued = messages.length > 0 && toolUseContext.agentId === undefined && (querySource === 'sdk' || querySource?.startsWith('main_thread'))
    ? beginQueuedCompact(ownerFromToolUseContext(toolUseContext)) : undefined
  if (!compact && queued?.fresh) {
    asked = true
    compact = true
  }
  if (!compact) return { ...notCompacted, measuredRawTokenCount }

  fixedTokens ??= await measureFixed()
  const overflow = detectFixedPrefixOverflow(messages, model, snipTokensFreed, fixedTokens)
  if (overflow !== null) {
    const message = `autoCompact: fixed prefix (~${overflow.prefixTokens} tokens) exceeds the threshold (${overflow.thresholdTokens}); compaction cannot help`
    if (!forced && !asked && !thresholdOverridden()) {
      noteFixedSkip(`autoCompact: skipping — fixed prefix (~${overflow.prefixTokens} tokens) exceeds the threshold (${overflow.thresholdTokens}); compaction cannot help`)
      if (!queued?.fresh) return { ...notCompacted, measuredRawTokenCount }
      asked = true
    }
    logForDebugging(message)
  }

  let restoreFiles = true
  if (asked) {
    const projection = await projectManualFold(messages, toolUseContext, cacheSafeParams, getAutoCompactThreshold(model))
    const refold = isRefold(messages)
    if (projection !== null && (refold ? manualFoldHasNothingToFold(projection) : projection.after >= projection.before)) {
      const line = nothingToCompactLine(projection.context, nothingToCompactReason(projection, refold))
      if (!askedByOperator) queued?.complete()
      return { ...notCompacted, refusal: askedByOperator ? crewmateCompactNothingWords(askingCrewmateName(toolUseContext), line) : line, declined: true }
    }
    if (projection !== null) restoreFiles = projection.restoreFiles
  }
  const refills = rapidRefillCount(tracking)
  const tripped = refills >= RAPID_REFILL_LIMIT
  if (tripped) logForDebugging('autoCompact: rapid-refill breaker tripped — this fold lands, then automatic compaction pauses for the run')
  const breaker = tripped ? { rapidRefillBreakerTripped: true as const } : {}

  const threshold = getAutoCompactThresholdWithFixed(model, fixedTokens)
  const recompactionInfo: RecompactionInfo = {
    isRecompaction: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.compacted === true ? tracking.turnCounter : -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: threshold,
    querySource,
    ...(asked ? { restoreFiles, mustShrink: true } : {}),
  }

  const instructions = queued?.instructions
  const sessionMemoryArmed = instructions === undefined && shouldUseSessionMemoryCompaction()
  const foldModel = foldModelFor(messages, model, { forced })
  if (foldModel.source === 'history') {
    logForDebugging(
      `autoCompact: the summary is written by ${foldModel.model} — the seated ${model}'s window does not hold the history (about ${foldModel.count} tokens by Mercury's count)`,
    )
  }
  try {
    const folded = await withFoldStatus(toolUseContext, async scoped => {
    if (sessionMemoryArmed) scoped.onCompactProgress?.({ type: 'stage', stage: 'session-memory' })
    const viaMemory = instructions === undefined ? await trySessionMemoryCompaction(messages, scoped.agentId, threshold, scoped, asked && !askedByOperator ? 'manual' : 'auto') : null
    if (viaMemory !== null) {
      setLastSummarizedMessageId(undefined)
      runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId }, buildPostCompactMessages(viaMemory))
      return { wasCompacted: true, compactionResult: viaMemory, consecutiveRapidRefills: refills, ...breaker }
    }

    const result = await compactConversation(
      messages,
      scoped,
      cacheSafeParams,
      true,
      instructions,
      !asked,
      recompactionInfo,
      overflowSignal,
      foldModel.model,
    )
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId }, buildPostCompactMessages(result))
    return {
      wasCompacted: true,
      compactionResult: result,
      consecutiveFailures: 0,
      consecutiveRapidRefills: refills,
      ...breaker,
    }
    }, { trigger: asked ? 'manual' : 'auto', sessionMemory: sessionMemoryArmed, microcompaction: false })
    queued?.complete()
    return folded
  } catch (err) {
    if (err instanceof APIUserAbortError) {
      return forced ? { ...notCompacted, refusal: ERROR_MESSAGE_USER_ABORT } : notCompacted
    }
    const reason = err instanceof Error ? err.message : String(err)
    if (asked && isNothingToCompactMessage(reason)) {
      if (!askedByOperator) queued?.complete()
      return { ...notCompacted, refusal: askedByOperator ? crewmateCompactNothingWords(askingCrewmateName(toolUseContext), reason) : reason, declined: true }
    }
    logError(err)
    if (err instanceof CompactionRefusedForHistoryError) {
      logForDebugging(
        `autoCompact: the summary request was refused for a malformed history — automatic compaction is paused for the rest of this run: ${err.providerWords.slice(0, 160)}`,
        { level: 'warn' },
      )
      return {
        wasCompacted: false,
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        refusal: compactionPausedForHistoryText(err.providerWords, { nonInteractive: err.nonInteractive }),
        paused: true,
      }
    }
    const nextFailures = failures + 1
    if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
      logForDebugging(
        `autoCompact: ${nextFailures} consecutive failures — circuit breaker tripped for the rest of this run`,
        { level: 'warn' },
      )
    }
    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      refusal: reason,
      ...breaker,
    }
  }
}
