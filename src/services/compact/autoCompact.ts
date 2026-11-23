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
import { compactionBreakerAllows, decideCompaction, percentUsedFromPercentLeft, type CompactionState } from './compactionPolicy.js'
import {
  buildPostCompactMessages,
  compactConversation,
  compactionPausedForHistoryText,
  CompactionRefusedForHistoryError,
  ERROR_MESSAGE_USER_ABORT,
  estimateFixedRequestTokens,
  foldRemedyIsHeadless,
  isNothingToCompactMessage,
  isRefold,
  manualFoldHasNothingToFold,
  nothingToCompactLine,
  nothingToCompactReason,
  projectManualFold,
  withFoldStatus,
  type CompactionResult,
  type RecompactionInfo,
} from './compact.js'
import { crewmateCompactNothingWords } from '../../utils/cockpit/crewmateWords.js'
import { estimateMessageTokens } from './microCompact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction, shouldUseSessionMemoryCompaction } from './sessionMemoryCompact.js'
import { APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { calculateTokenWarningState, getAutoCompactThreshold, getAutoCompactThresholdWithFixed, getBlockingLimit, getEffectiveContextWindowSize, isAutoCompactEnabled, SUMMARY_RESERVE_MAX_WINDOW_DIVISOR, thresholdOverridden } from '../../utils/compact/autoCompactWindow.js'
import { passedOver } from '../../utils/passedOver.js'
import { isRecord } from '../../utils/isRecord.js'
export { MIN_AUTOCOMPACT_WINDOW, MAX_AUTOCOMPACT_WINDOW, WARNING_THRESHOLD_BUFFER_TOKENS, MANUAL_COMPACT_BUFFER_TOKENS, AUTOCOMPACT_BUFFER_TOKENS, autoCompactWindowIsInputLimit, resolveAutoCompactWindow, getEffectiveContextWindowSize, getTurnReserveTokens, getAutoCompactThreshold, getAutoCompactThresholdWithFixed, autoCompactDisabledReason, isAutoCompactEnabled, compactionSettingsText, getBlockingLimit, calculateTokenWarningState } from '../../utils/compact/autoCompactWindow.js'
export type { AutoCompactWindowSource, TokenWarningLevel } from '../../utils/compact/autoCompactWindow.js'


void notifyCompaction


const MAX_CONSECUTIVE_FAILURES = 3
const RAPID_REFILL_TURN_WINDOW = 2
const RAPID_REFILL_LIMIT = 3

export const COMPACTION_PAUSED_KEY = 'automatic compaction failed'

export function operatorCompactionAsked(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): boolean {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return false
  const task = toolUseContext.getAppState().tasks?.[agentId]
  return task?.type === 'local_agent' && task.compactRequested === true
}

function askingCrewmateName(toolUseContext: Pick<ToolUseContext, 'agentId' | 'getAppState'>): string {
  const agentId = toolUseContext.agentId
  const task = agentId === undefined ? undefined : toolUseContext.getAppState().tasks?.[agentId]
  return task?.description !== undefined && task.description !== '' ? task.description : String(agentId ?? 'the crewmate')
}

export function takeOperatorCompactionAsk(toolUseContext: Pick<ToolUseContext, 'agentId' | 'setAppState' | 'setAppStateForTasks'>): void {
  const agentId = toolUseContext.agentId
  if (agentId === undefined) return
  updateTaskState(agentId, toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState, task => {
    if (task.type !== 'local_agent' || task.compactRequested !== true) return task
    const { compactRequested: _taken, ...rest } = task
    return rest
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
      if (!isRecord(block)) continue
      if (block.type === 'document') documentBlockCount++
      else if (block.type === 'image') imageBlockCount++
      else if (block.type === 'tool_result' && Array.isArray(block.content)) countBlocks(block.content)
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
    const decision = decideCompaction({
      usage: pctUsed !== undefined ? { percentage: pctUsed } : null,
      state: currentAdvance,
      turn: turnCounter,
    })
    currentAdvance.lastFiredTurn = decision.state.lastFiredTurn
    currentAdvance.rearmed = decision.state.rearmed
    if (decision.action === 'compact') {
      logForDebugging(`autoCompact: advance trigger fired (${decision.reason})`)
      return true
    }
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
  recompactionInfo: RecompactionInfo
  overflowSignal: OverflowSignal | undefined
  summaryModel: string
}): Promise<{ compactionResult: CompactionResult; fromMemory: boolean }> {
  return withFoldStatus(
    opts.toolUseContext,
    async scoped => {
      const finish = (compactionResult: CompactionResult, fromMemory: boolean) => {
        setLastSummarizedMessageId(undefined)
        runPostCompactCleanup(
          { querySource: opts.querySource, owner: opts.owner, agentId: opts.toolUseContext.agentId },
          buildPostCompactMessages(compactionResult),
        )
        return { compactionResult, fromMemory }
      }
      if (opts.sessionMemoryArmed) {
        scoped.onCompactProgress?.({ type: 'stage', stage: 'session-memory' })
      }
      if (!opts.customInstructions) {
        const memoryTrigger = opts.asked && !opts.crewmateAsked ? 'manual' : 'auto'
        const memoryResult = await trySessionMemoryCompaction(
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
      const compactionResult = await compactConversation(
        opts.messages,
        scoped,
        opts.cacheSafeParams,
        true,
        opts.customInstructions,
        !opts.asked,
        opts.recompactionInfo,
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
type AutoCompactResult = {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
  rapidRefillBreakerTripped?: boolean
  measuredRawTokenCount?: number | null
  refusal?: string
  paused?: true
  declined?: true
}

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
  queuedCompact: ReturnType<typeof beginQueuedCompact> | undefined
}): AutoCompactResult {
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
    queuedCompact,
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
  if (asked && isNothingToCompactMessage(message)) {
    const refusal = crewmateAsked
      ? crewmateCompactNothingWords(askingCrewmateName(toolUseContext), message)
      : message
    if (!crewmateAsked) queuedCompact?.complete()
    return {
      wasCompacted: false,
      ...priorFailureField,
      measuredRawTokenCount,
      refusal,
      declined: true,
    }
  }
  logError(error)
  if (error instanceof CompactionRefusedForHistoryError) {
    logForDebugging(
      `autoCompact: the summary request was refused for a malformed history — automatic compaction is paused for the rest of this run: ${error.providerWords.slice(0, 160)}`,
      { level: 'warn' },
    )
    return {
      wasCompacted: false,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      measuredRawTokenCount,
      refusal: compactionPausedForHistoryText(error.providerWords, { nonInteractive }),
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

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed: number = 0,
  overflowSignal?: OverflowSignal,
): Promise<AutoCompactResult> {
  const priorFailures = tracking?.consecutiveFailures
  const forced = overflowSignal !== undefined
  const nonInteractive = () => foldRemedyIsHeadless(toolUseContext.options?.isNonInteractiveSession)
  const notCompacted = (extra?: {
    measuredRawTokenCount?: number | null
    refusal?: string
    paused?: true
    declined?: true
  }) => ({
    wasCompacted: false,
    ...(priorFailures !== undefined ? { consecutiveFailures: priorFailures } : {}),
    ...extra,
  })

  if (!flagEnabled('MERCURY_COMPACT')) {
    return notCompacted(forced ? { refusal: 'compaction is disabled (MERCURY_COMPACT=0)' } : undefined)
  }
  if (tracking?.rapidRefillPaused === true) {
    return notCompacted(forced ? { refusal: rapidRefillPauseText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  if ((priorFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    return notCompacted(forced ? { refusal: compactionBreakerText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  if (suppressBreakerEnabled() && !compactionBreakerAllows(priorFailures)) {
    logForDebugging('autoCompact: Mercury breaker suppressed a doomed retry')
    return notCompacted(forced ? { refusal: compactionBreakerText({ nonInteractive: nonInteractive() }) } : undefined)
  }
  const model = toolUseContext.options.engineModel
  const owner = ownerFromToolUseContext(toolUseContext)

  const operatorAsked = operatorCompactionAsked(toolUseContext)
  if (operatorAsked) {
    takeOperatorCompactionAsk(toolUseContext)
    logForDebugging(
      `autoCompact: crewmate ${toolUseContext.agentId} folds now — the operator asked for it from the crew view${
        forced ? ' (the overflow fold at this boundary is the one fold)' : ''
      }`,
    )
  }
  const crewmateAsked = operatorAsked && !forced

  let shouldCompact = false
  let measuredRawTokenCount: number | null = null
  let fixedTokens: number | undefined
  let heldByFixedMaterial = false
  const carry = cacheSafeParams.postFoldCarry ?? []
  const messagesForMeasure = carry.length > 0 ? [...messages, ...carry] : messages

  if (forced) {
    if (querySource === 'session_memory' || querySource === 'compact') {
      return notCompacted({ refusal: 'the summary forks never fold themselves' })
    }
    const parts: string[] = [overflowSignal.source, overflowSignal.family, overflowSignal.shape]
    if (overflowSignal.actualTokens !== undefined && overflowSignal.limitTokens !== undefined) {
      parts.push(`${overflowSignal.actualTokens} > ${overflowSignal.limitTokens}`)
    }
    logForDebugging(`autoCompact: overflow fold forced (${parts.join(' · ')})`)
    shouldCompact = true
  } else if (crewmateAsked) {
    shouldCompact = messages.length > 0
  } else {
    shouldCompact = await shouldAutoCompact(
      messagesForMeasure,
      model,
      querySource,
      snipTokensFreed,
      raw => {
        measuredRawTokenCount = raw
      },
    )
    if (shouldCompact && messages.length === 0) {
      return notCompacted({ measuredRawTokenCount })
    }
    if (shouldCompact && !thresholdOverridden()) {
      fixedTokens =
        readRequestGauge(messages, model)?.fixed.tokens ??
        (await estimateFixedRequestTokens(toolUseContext, cacheSafeParams))
      const effectiveUsage =
        (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForMeasure, model)) - snipTokensFreed
      const blockingLimit = getBlockingLimit(model)
      const oneTurnReserve = Math.ceil(blockingLimit / SUMMARY_RESERVE_MAX_WINDOW_DIVISOR)
      const fixedThreshold = getAutoCompactThresholdWithFixed(model, fixedTokens)
      if (fixedTokens + oneTurnReserve > blockingLimit) {
        heldByFixedMaterial = true
        shouldCompact = false
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurnReserve} tokens) exceeds the window's room (${blockingLimit} tokens)`,
        )
      } else if (effectiveUsage < fixedThreshold) {
        heldByFixedMaterial = true
        shouldCompact = false
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping at ${effectiveUsage} tokens — fixed material (~${fixedTokens} tokens) plus one turn (${oneTurnReserve} tokens) raises the fold point to ${fixedThreshold} tokens`,
        )
      }
    }
  }

  if (
    !shouldCompact &&
    !heldByFixedMaterial &&
    advanceTriggerEnabled() &&
    isAutoCompactEnabled() &&
    querySource !== 'session_memory' &&
    querySource !== 'compact' &&
    querySource !== 'context_agent'
  ) {
    const effectiveTokens =
      (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForMeasure, model)) - snipTokensFreed
    shouldCompact = tryAdvanceTrigger(owner, effectiveTokens, model, tracking?.turnCounter)
  }

  const queuedCompact =
    messages.length > 0 &&
    toolUseContext.agentId === undefined &&
    (querySource === 'sdk' || querySource?.startsWith('main_thread') === true)
      ? beginQueuedCompact(owner)
      : undefined
  let asked = crewmateAsked
  if (!shouldCompact && queuedCompact?.fresh === true) {
    shouldCompact = true
    asked = true
  }
  if (!shouldCompact) {
    return notCompacted({ measuredRawTokenCount })
  }

  if (fixedTokens === undefined) {
    fixedTokens =
      readRequestGauge(messages, model)?.fixed.tokens ??
      (await estimateFixedRequestTokens(toolUseContext, cacheSafeParams))
  }

  const fixedOverflow = detectFixedPrefixOverflow(messages, model, snipTokensFreed, fixedTokens)
  if (fixedOverflow !== null) {
    if (!forced && !asked && !thresholdOverridden()) {
      if (queuedCompact?.fresh === true) {
        asked = true
        logForDebugging(
          `autoCompact: fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
        )
      } else {
        noteFixedMaterialSkipOnce(
          owner,
          `autoCompact: skipping — fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
        )
        return notCompacted({ measuredRawTokenCount })
      }
    } else if (forced || asked) {
      logForDebugging(
        `autoCompact: fixed prefix (~${fixedOverflow.prefixTokens} tokens) exceeds the threshold (${fixedOverflow.thresholdTokens}); compaction cannot help`,
      )
    }
  }

  const fixedThreshold = getAutoCompactThresholdWithFixed(model, fixedTokens)
  let restoreFiles = true
  if (asked) {
    const projection = await projectManualFold(
      messages,
      toolUseContext,
      cacheSafeParams,
      getAutoCompactThreshold(model),
    )
    if (projection !== null) {
      const refold = isRefold(messages)
      const shouldDecline = refold
        ? manualFoldHasNothingToFold(projection)
        : projection.after >= projection.before
      if (shouldDecline) {
        const line = nothingToCompactLine(projection.context, nothingToCompactReason(projection, refold))
        const refusal = crewmateAsked
          ? crewmateCompactNothingWords(askingCrewmateName(toolUseContext), line)
          : line
        if (!crewmateAsked) queuedCompact?.complete()
        return notCompacted({ measuredRawTokenCount, refusal, declined: true })
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

  const recompactionInfo: RecompactionInfo = {
    isRecompaction: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.compacted === true ? tracking.turnCounter : -1,
    ...(tracking?.turnId !== undefined ? { previousCompactTurnId: tracking.turnId } : {}),
    autoCompactThreshold: fixedThreshold,
    ...(querySource !== undefined ? { querySource } : {}),
    ...(asked ? { restoreFiles, mustShrink: true } : {}),
  }

  const customInstructions = queuedCompact?.instructions
  const sessionMemoryArmed = !customInstructions && shouldUseSessionMemoryCompaction()
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
      recompactionInfo,
      overflowSignal,
      summaryModel: foldChoice.model,
    })

    queuedCompact?.complete()

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
      queuedCompact,
    })
  }
}
