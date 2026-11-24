import type { ToolUseContext } from '../../tools/kit/tool.js'
import { beginQueuedFold } from '../../screen/composer/input-core/command-queue.js'
import type { AssistantMessage, Message } from '../message-shapes/message.js'
import { isMercurySubstrateProfileOn } from '../../platform/config/derived.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import type { CacheSafeParams } from '../../crew/agents/forkedAgent.js'
import { logError } from '../../platform/logs/errorLog.js'
import { awaitContextWindowSource } from '../context-window/contextWindowWarmup.js'
import { getTokenUsage, tokenCountWithEstimation, usageAnchorModel } from '../context-window/contextTokenCount.js'
import { flagEnabled, flagEnv } from '../../platform/substrate/flagRegistry.js'
import { registerOwnerScopedStore } from '../run-owner/ownerLifecycle.js'
import { OwnerScopedStore } from '../run-owner/ownerScopedStore.js'
import { readRequestGauge } from '../run/requestGauge.js'
import { ownerFromToolUseContext } from '../run-owner/resolveOwner.js'
import { updateTaskState } from '../task-framework/taskRegistry.js'
import { setLastSummarizedMessageId } from '../../sessions/session-memory/extractionState.js'
import type { OverflowSignal } from '../requests/overflowSignal.js'
import { notifyFold } from '../requests/promptCacheBreakDetection.js'
import { usabilityForRoute } from '../../models/roads/providerUsability.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import { foldBreakerAllows, decideFold, percentUsedFromPercentLeft, type FoldPolicyState } from './foldPolicy.js'
import {
  buildPostFoldMessages,
  foldConversation,
  foldPausedForHistoryText,
  FoldRefusedForHistoryError,
  ERROR_MESSAGE_USER_ABORT,
  estimateFixedRequestTokens,
  foldRemedyIsHeadless,
  isNothingToFoldMessage,
  isRefold,
  manualFoldHasNothingToFold,
  nothingToFoldLine,
  nothingToFoldReason,
  projectManualFold,
  withFoldStatus,
  type FoldResult,
  type RefoldInfo,
} from './foldConversation.js'
import { crewmateFoldNothingWords } from '../../screen/cockpit/crewmateWords.js'
import { estimateMessageTokens } from './pruneToolResults.js'
import { runPostFoldCleanup } from './postFoldCleanup.js'
import { trySessionNotesFold, shouldUseSessionNotesFold } from './sessionNotesFold.js'
import { APIUserAbortError } from '../request-parts/sdkErrors.js'
import { calculateTokenWarningState, getAutoFoldThreshold, getAutoFoldThresholdWithFixed, getBlockingLimit, getEffectiveContextWindowSize, isAutoFoldEnabled, SUMMARY_RESERVE_MAX_WINDOW_DIVISOR, thresholdOverridden } from '../compaction-window/autoFoldWindow.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export { MIN_AUTO_FOLD_WINDOW, MAX_AUTO_FOLD_WINDOW, WARNING_THRESHOLD_BUFFER_TOKENS, MANUAL_FOLD_BUFFER_TOKENS, AUTO_FOLD_BUFFER_TOKENS, autoFoldWindowIsInputLimit, resolveAutoFoldWindow, getEffectiveContextWindowSize, getTurnReserveTokens, getAutoFoldThreshold, getAutoFoldThresholdWithFixed, autoFoldDisabledReason, isAutoFoldEnabled, foldSettingsText, getBlockingLimit, calculateTokenWarningState } from '../compaction-window/autoFoldWindow.js'
export type { AutoFoldWindowSource, TokenWarningLevel } from '../compaction-window/autoFoldWindow.js'


void notifyFold


const MAX_CONSECUTIVE_FAILURES = 3
const RAPID_REFILL_TURN_WINDOW = 2
const RAPID_REFILL_LIMIT = 3

export const FOLD_PAUSED_KEY = 'automatic compaction failed'

type FoldableTask = { type?: string; compactRequested?: boolean; description?: string }

export function operatorFoldAsked(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): boolean {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return false
  const task = toolUseContext.getAppState().tasks?.[agentId] as FoldableTask | undefined
  return task?.type === 'local_agent' && task.compactRequested === true
}

function askingCrewmateName(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): string {
  const agentId = toolUseContext.agentId
  const task = agentId === undefined ? undefined : (toolUseContext.getAppState().tasks?.[agentId] as FoldableTask | undefined)
  return task?.description !== undefined && task.description !== '' ? task.description : String(agentId ?? 'the crewmate')
}

export function takeOperatorFoldAsk(toolUseContext: Pick<ToolUseContext, 'agentId' | 'setAppState' | 'setAppStateForTasks'>): void {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return
  updateTaskState(agentId, toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState, task => {
    if (task.type !== 'local_agent' || task.compactRequested !== true) return task
    const { compactRequested: _taken, ...rest } = task
    return rest
  })
}

export function foldBreakerText(opts: { nonInteractive: boolean }): string {
  const byHand = opts.nonInteractive ? 'The' : '/compact folds the conversation by hand; the'
  const next = opts.nonInteractive ? 'prompt' : 'message'
  return `${FOLD_PAUSED_KEY} ${MAX_CONSECUTIVE_FAILURES} times in a row and is paused for the rest of this run. ${byHand} next ${next} makes a fresh automatic attempt.`
}

export const AUTO_FOLD_THRASH_MESSAGE =
  `Auto-compaction is looping: the context refilled within ${RAPID_REFILL_TURN_WINDOW - 1} turn of each fold ` +
  `${RAPID_REFILL_LIMIT} times in a row — each turn brings in more than a fold can free, ` +
  `a file read or a tool output larger than the room a fold leaves.`

export function rapidRefillPauseText(opts: { nonInteractive: boolean }): string {
  const remedy = opts.nonInteractive
    ? 'read in smaller pieces, or start a fresh run'
    : 'read in smaller pieces, /compact folds the conversation by hand, and the next message makes a fresh automatic attempt'
  return `Automatic compaction is paused for the rest of this run; ${remedy}.`
}

export type AutoFoldTrackingState = {
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
    const { helperFoldModelId } = require('../../models/roads/local/tensorfoldHelper.js') as typeof import('../../models/roads/local/tensorfoldHelper.js')
    return helperFoldModelId()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function seatedLocalServing(seated: string): boolean {
  try {
    const { localRecordFor } = require('../../models/roads/local/localCatalogue.js') as typeof import('../../models/roads/local/localCatalogue.js')
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

export function rapidRefillCount(tracking?: AutoFoldTrackingState): number {
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
  const thresholdTokens = getAutoFoldThresholdWithFixed(model, fixedTokens)
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

export async function shouldAutoFold(
  messages: Message[],
  model: string,
  querySource?: string,
  snipTokensFreed: number = 0,
  onMeasured?: (rawTokenCount: number) => void,
): Promise<boolean> {
  if (querySource === 'session_memory' || querySource === 'compact') return false
  if (!isAutoFoldEnabled()) return false
  const tokenCount = tokenCountWithEstimation(messages, model) - snipTokensFreed
  const known = await awaitContextWindowSource(model, { estTokens: tokenCount + snipTokensFreed })
  onMeasured?.(tokenCount + snipTokensFreed)
  if (!known) {
    logForDebugging(`autoCompact: the window of ${model} is not known yet — no decision against the default`)
    return false
  }
  const threshold = getAutoFoldThreshold(model)
  const effective = getEffectiveContextWindowSize(model)
  logForDebugging(
    `autoCompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effective}${
      snipTokensFreed !== 0 ? ` snipAdjustment=${snipTokensFreed}` : ''
    }`,
  )
  const { level } = calculateTokenWarningState(tokenCount, model)
  return level === 'compact' || level === 'blocked'
}


function ctxFoldFlagOn(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION'))
}

function suppressBreakerEnabled(): boolean {
  return ctxFoldFlagOn() || isMercurySubstrateProfileOn()
}

function advanceTriggerEnabled(): boolean {
  return ctxFoldFlagOn()
}

const advanceState = new OwnerScopedStore<FoldPolicyState>({
  name: 'autocompact-advance',
  create: () => ({ lastFiredTurn: null, rearmed: true }),
})
registerOwnerScopedStore(advanceState)

const fixedMaterialSkipState = new OwnerScopedStore<{ noted: boolean }>({
  name: 'autocompact-fixed-material-skip',
  create: () => ({ noted: false }),
})
registerOwnerScopedStore(fixedMaterialSkipState)

function noteFixedMaterialSkipOnce(owner: ReturnType<typeof ownerFromToolUseContext>, message: string): void {
  const skipState = fixedMaterialSkipState.get(owner)
  if (!skipState.noted) {
    skipState.noted = true
    logForDebugging(message)
  }
}

function tryAdvanceTrigger(
  owner: ReturnType<typeof ownerFromToolUseContext>,
  effectiveTokens: number,
  model: string,
  turnCounter: number | undefined,
): boolean {
  try {
    const { pctLeft } = calculateTokenWarningState(effectiveTokens, model)
    const pctUsed = pctLeft !== undefined ? percentUsedFromPercentLeft(pctLeft) : undefined
    const currentAdvance = advanceState.get(owner)
    const decision = decideFold({
      usage: pctUsed !== undefined ? { percentage: pctUsed } : null,
      state: currentAdvance,
      turn: turnCounter,
    })
    currentAdvance.lastFiredTurn = decision.state.lastFiredTurn
    currentAdvance.rearmed = decision.state.rearmed
    if (decision.action === 'compact') return true
  } catch (error) {
    logError(error)
  }
  return false
}

async function runFoldAttempt(opts: {
  messages: Message[]
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource: string | undefined
  owner: ReturnType<typeof ownerFromToolUseContext>
  asked: boolean
  crewmateAsked: boolean
  customInstructions: string | undefined
  sessionMemoryArmed: boolean
  fixedThreshold: number
  refoldInfo: RefoldInfo
  overflowSignal: OverflowSignal | undefined
  summaryModel: string
}): Promise<{ compactionResult: FoldResult; fromMemory: boolean }> {
  return withFoldStatus(
    opts.toolUseContext,
    async scoped => {
      const finish = (compactionResult: FoldResult, fromMemory: boolean) => {
        setLastSummarizedMessageId(undefined)
        runPostFoldCleanup(
          { querySource: opts.querySource, agentId: opts.toolUseContext.agentId },
          buildPostFoldMessages(compactionResult),
        )
        return { compactionResult, fromMemory }
      }
      if (opts.sessionMemoryArmed) {
        scoped.onCompactProgress?.({ type: 'stage', stage: 'session-memory' })
      }
      if (!opts.customInstructions) {
        const memoryTrigger = opts.asked && !opts.crewmateAsked ? 'manual' : 'auto'
        const memoryResult = await trySessionNotesFold(
          opts.messages,
          opts.toolUseContext.agentId,
          opts.fixedThreshold,
          scoped,
          memoryTrigger,
        )
        if (memoryResult !== null) {
          return finish(memoryResult, true)
        }
      }
      const compactionResult = await foldConversation(
        opts.messages,
        scoped,
        opts.cacheSafeParams,
        true,
        opts.customInstructions,
        !opts.asked,
        opts.refoldInfo,
        opts.overflowSignal,
        opts.summaryModel,
      )
      return finish(compactionResult, false)
    },
    {
      trigger: opts.asked ? 'manual' : 'auto',
      sessionMemory: opts.sessionMemoryArmed,
      microcompaction: false,
    },
  )
}
type AutoFoldResult = Awaited<ReturnType<typeof autoFoldIfNeeded>>

function settleFoldError(opts: {
  error: unknown
  forced: boolean
  asked: boolean
  crewmateAsked: boolean
  nonInteractive: boolean
  priorFailures: number | undefined
  rapidRefillBreakerTripped: boolean
  measuredRawTokenCount: number | null
  toolUseContext: ToolUseContext
  queuedFold: ReturnType<typeof beginQueuedFold> | undefined
}): AutoFoldResult {
  const {
    error,
    forced,
    asked,
    crewmateAsked,
    nonInteractive,
    priorFailures,
    rapidRefillBreakerTripped,
    measuredRawTokenCount,
    toolUseContext,
    queuedFold,
  } = opts
  const priorFailureField = priorFailures !== undefined ? { consecutiveFailures: priorFailures } : {}
  if (error instanceof APIUserAbortError) {
    return {
      wasCompacted: false,
      ...priorFailureField,
      measuredRawTokenCount,
      ...(forced ? { refusal: ERROR_MESSAGE_USER_ABORT } : {}),
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (asked && isNothingToFoldMessage(message)) {
    const refusal = crewmateAsked
      ? crewmateFoldNothingWords(askingCrewmateName(toolUseContext), message)
      : message
    if (!crewmateAsked) queuedFold?.complete()
    return {
      wasCompacted: false,
      ...priorFailureField,
      measuredRawTokenCount,
      refusal,
      declined: true,
    }
  }
  logError(error)
  if (error instanceof FoldRefusedForHistoryError) {
    logForDebugging(
      `autoCompact: the summary request was refused for a malformed history — automatic compaction is paused for the rest of this run: ${error.providerWords.slice(0, 160)}`,
      { level: 'warn' },
    )
    return {
      wasCompacted: false,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      measuredRawTokenCount,
      refusal: foldPausedForHistoryText(error.providerWords, { nonInteractive }),
      paused: true,
    }
  }
  const nextFailures = (priorFailures ?? 0) + 1
  if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
    logForDebugging(
      `autoCompact: ${nextFailures} consecutive failures — circuit breaker tripped for the rest of this run`,
      { level: 'warn' },
    )
  }
  return {
    wasCompacted: false,
    consecutiveFailures: nextFailures,
    ...(rapidRefillBreakerTripped ? { rapidRefillBreakerTripped: true } : {}),
    measuredRawTokenCount,
    refusal: message,
  }
}

export async function autoFoldIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: string,
  tracking?: AutoFoldTrackingState,
  snipTokensFreed: number = 0,
  overflowSignal?: OverflowSignal,
): Promise<{
  wasCompacted: boolean
  compactionResult?: FoldResult
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
  rapidRefillBreakerTripped?: boolean
  measuredRawTokenCount?: number | null
  refusal?: string
  paused?: true
  declined?: true
}> {
  const priorFailures = tracking?.consecutiveFailures
  const forced = overflowSignal !== undefined
  const nonInteractive = () => foldRemedyIsHeadless(toolUseContext.options?.isNonInteractiveSession)
  const notFolded = (extra?: {
    measuredRawTokenCount?: number | null
    refusal?: string
    paused?: true
    declined?: true
  }): AutoFoldResult => ({
    wasCompacted: false,
    ...(priorFailures !== undefined ? { consecutiveFailures: priorFailures } : {}),
    ...extra,
  })

  if (!flagEnabled('MERCURY_COMPACT')) {
    return notFolded(forced ? { refusal: 'compaction is disabled (MERCURY_COMPACT=0)' } : undefined)
  }
  if (tracking?.rapidRefillPaused === true) {
    return notFolded(forced ? { refusal: rapidRefillPauseText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  if ((priorFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    return notFolded(forced ? { refusal: foldBreakerText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  if (suppressBreakerEnabled() && !foldBreakerAllows(priorFailures)) {
    logForDebugging('autoCompact: Mercury breaker suppressed a doomed retry')
    return notFolded(forced ? { refusal: foldBreakerText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  const model = toolUseContext.options.engineModel
  const owner = ownerFromToolUseContext(toolUseContext)

  const operatorAsked = operatorFoldAsked(toolUseContext)
  if (operatorAsked) {
    takeOperatorFoldAsk(toolUseContext)
    logForDebugging(
      `autoCompact: crewmate ${toolUseContext.agentId} folds now — the operator asked for it from the crew view${
        forced ? ' (the overflow fold at this boundary is the one fold)' : ''
      }`,
    )
  }
  const crewmateAsked = operatorAsked && !forced

  let shouldFold = false
  let measuredRawTokenCount: number | null = null
  let fixedTokens: number | undefined
  let heldByFixedMaterial = false
  const carry = cacheSafeParams.postFoldCarry ?? []
  const messagesForMeasure = carry.length > 0 ? [...messages, ...carry] : messages

  if (forced) {
    if (querySource === 'session_memory' || querySource === 'compact') {
      return notFolded({ refusal: 'the summary forks never fold themselves' })
    }
    const parts: string[] = [overflowSignal.source, overflowSignal.family, overflowSignal.shape]
    if (overflowSignal.actualTokens !== undefined && overflowSignal.limitTokens !== undefined) {
      parts.push(`${overflowSignal.actualTokens} > ${overflowSignal.limitTokens}`)
    }
    logForDebugging(`autoCompact: overflow fold forced (${parts.join(' · ')})`)
    shouldFold = true
  } else if (crewmateAsked) {
    shouldFold = messages.length > 0
  } else {
    shouldFold = await shouldAutoFold(
      messagesForMeasure,
      model,
      querySource,
      snipTokensFreed,
      raw => {
        measuredRawTokenCount = raw
      },
    )
    if (shouldFold && messages.length === 0) {
      return notFolded({ measuredRawTokenCount })
    }
    if (shouldFold && !thresholdOverridden()) {
      fixedTokens =
        readRequestGauge(messages, model)?.fixed.tokens ??
        (await estimateFixedRequestTokens(toolUseContext, cacheSafeParams))
      const effectiveUsage =
        (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForMeasure, model)) - snipTokensFreed
      const blockingLimit = getBlockingLimit(model)
      const oneTurnReserve = Math.ceil(blockingLimit / SUMMARY_RESERVE_MAX_WINDOW_DIVISOR)
      const fixedThreshold = getAutoFoldThresholdWithFixed(model, fixedTokens)
      if (fixedTokens + oneTurnReserve > blockingLimit) {
        heldByFixedMaterial = true
        shouldFold = false
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurnReserve} tokens) exceeds the window's room (${blockingLimit} tokens)`,
        )
      } else if (effectiveUsage < fixedThreshold) {
        heldByFixedMaterial = true
        shouldFold = false
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping at ${effectiveUsage} tokens — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurnReserve} tokens) raises the fold point to ${fixedThreshold} tokens`,
        )
      }
    }
  }

  if (
    !shouldFold &&
    !heldByFixedMaterial &&
    advanceTriggerEnabled() &&
    isAutoFoldEnabled() &&
    querySource !== 'session_memory' &&
    querySource !== 'compact' &&
    querySource !== 'context_agent'
  ) {
    const effectiveTokens =
      (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForMeasure, model)) - snipTokensFreed
    shouldFold = tryAdvanceTrigger(owner, effectiveTokens, model, tracking?.turnCounter)
  }

  const queuedFold =
    messages.length > 0 &&
    toolUseContext.agentId === undefined &&
    (querySource === 'sdk' || querySource?.startsWith('main_thread') === true)
      ? beginQueuedFold(owner)
      : undefined
  let asked = crewmateAsked
  if (!shouldFold && queuedFold?.fresh === true) {
    shouldFold = true
    asked = true
  }
  if (!shouldFold) {
    return notFolded({ measuredRawTokenCount })
  }

  if (fixedTokens === undefined) {
    fixedTokens =
      readRequestGauge(messages, model)?.fixed.tokens ??
      (await estimateFixedRequestTokens(toolUseContext, cacheSafeParams))
  }

  const fixedOverflow = detectFixedPrefixOverflow(messages, model, snipTokensFreed, fixedTokens)
  if (fixedOverflow !== null) {
    if (!forced && !asked && !thresholdOverridden()) {
      if (queuedFold?.fresh === true) {
        asked = true
        logForDebugging(
          `autoCompact: fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
        )
      } else {
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping — fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
        )
        return notFolded({ measuredRawTokenCount })
      }
    } else if (forced || asked) {
      logForDebugging(
        `autoCompact: fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
      )
    }
  }

  const fixedThreshold = getAutoFoldThresholdWithFixed(model, fixedTokens)
  let restoreFiles = true
  if (asked) {
    const projection = await projectManualFold(
      messages,
      toolUseContext,
      cacheSafeParams,
      getAutoFoldThreshold(model),
    )
    if (projection !== null) {
      const refold = isRefold(messages)
      const shouldDecline = refold
        ? manualFoldHasNothingToFold(projection)
        : projection.after >= projection.before
      if (shouldDecline) {
        const line = nothingToFoldLine(projection.context, nothingToFoldReason(projection, refold))
        const refusal = crewmateAsked
          ? crewmateFoldNothingWords(askingCrewmateName(toolUseContext), line)
          : line
        if (!crewmateAsked) queuedFold?.complete()
        return notFolded({ measuredRawTokenCount, refusal, declined: true })
      }
      restoreFiles = projection.restoreFiles
    }
  }

  const consecutiveRapidRefills = rapidRefillCount(tracking)
  const rapidRefillBreakerTripped = consecutiveRapidRefills >= RAPID_REFILL_LIMIT
  if (rapidRefillBreakerTripped) {
    logForDebugging(
      'autoCompact: rapid-refill breaker tripped — this fold lands, then automatic compaction pauses for the run',
    )
  }

  const refoldInfo: RefoldInfo = {
    isRecompaction: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.compacted === true ? tracking.turnCounter : -1,
    ...(tracking?.turnId !== undefined ? { previousCompactTurnId: tracking.turnId } : {}),
    autoCompactThreshold: fixedThreshold,
    ...(querySource !== undefined ? { querySource } : {}),
    ...(asked ? { restoreFiles, mustShrink: true } : {}),
  }

  const customInstructions = queuedFold?.instructions
  const sessionMemoryArmed = !customInstructions && shouldUseSessionNotesFold()
  const foldChoice = foldModelFor(messages, model, { forced })
  if (foldChoice.source === 'history') {
    logForDebugging(
      `autoCompact: the summary is written by ${foldChoice.model} — the seated ${model}'s window does not hold the history (about ${foldChoice.count} tokens by Mercury's count)`,
    )
  }

  try {
    const attempt = await runFoldAttempt({
      messages,
      toolUseContext,
      cacheSafeParams,
      querySource,
      owner,
      asked,
      crewmateAsked,
      customInstructions,
      sessionMemoryArmed,
      fixedThreshold,
      refoldInfo,
      overflowSignal,
      summaryModel: foldChoice.model,
    })

    queuedFold?.complete()

    return {
      wasCompacted: true,
      compactionResult: attempt.compactionResult,
      ...(attempt.fromMemory ? {} : { consecutiveFailures: 0 }),
      consecutiveRapidRefills,
      ...(rapidRefillBreakerTripped ? { rapidRefillBreakerTripped: true } : {}),
      measuredRawTokenCount,
    }
  } catch (error) {
    return settleFoldError({
      error,
      forced,
      asked,
      crewmateAsked,
      nonInteractive: nonInteractive(),
      priorFailures,
      rapidRefillBreakerTripped,
      measuredRawTokenCount,
      toolUseContext,
      queuedFold,
    })
  }
}
