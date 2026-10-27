import { getSdkBetas } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { isMercurySubstrateProfileOn } from '../../utils/config/derived.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../../utils/model/capabilities.js'
import { awaitContextWindowSource } from '../../utils/model/contextWindowWarmup.js'
import { getTokenUsage, tokenCountWithEstimation, usageAnchorModel } from '../../utils/tokens.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { readRequestGauge } from '../run/requestGauge.js'
import { ownerFromToolUseContext } from '../run/resolveOwner.js'
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
  type RecompactionInfo,
  withFoldStatus,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { isMaintenanceLadderEnabled, runMaintenanceLadder } from './maintenanceLadder.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction, shouldUseSessionMemoryCompaction } from './sessionMemoryCompact.js'
import { APIUserAbortError } from '../api/sdkErrors.js'


void notifyCompaction


export const MIN_AUTOCOMPACT_WINDOW = 100_000
export const MAX_AUTOCOMPACT_WINDOW = 1_000_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const AUTOCOMPACT_BUFFER_TOKENS = 20_000

const SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000
const MAX_CONSECUTIVE_FAILURES = 3
const RAPID_REFILL_TURN_WINDOW = 2
const RAPID_REFILL_LIMIT = 3

const SUMMARY_RESERVE_MAX_WINDOW_DIVISOR = 4
const WARNING_MIN_CEILING_NUMERATOR = 4
const WARNING_MIN_CEILING_DENOMINATOR = 5

export const COMPACTION_PAUSED_KEY = 'automatic compaction failed'

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

export type AutoCompactWindowSource = 'settings' | 'auto' | 'experiment' | 'model-default'

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
  rapidRefillPaused?: true
}

export type TokenWarningLevel = 'ok' | 'warn' | 'compact' | 'blocked'


function modelMaxWindow(model: string): number {
  return getContextWindowForModel(model, getSdkBetas())
}

export function resolveAutoCompactWindow(
  model: string,
  settingsWindow?: number,
): { window: number; configured: number; source: AutoCompactWindowSource } {
  const modelMax = modelMaxWindow(model)
  const fromSettings = settingsWindow ?? getGlobalConfig().autoCompactWindow
  if (typeof fromSettings === 'number' && fromSettings > 0) {
    const configured = Math.min(Math.max(fromSettings, MIN_AUTOCOMPACT_WINDOW), MAX_AUTOCOMPACT_WINDOW)
    return { window: Math.min(configured, modelMax), configured, source: 'settings' }
  }
  return { window: modelMax, configured: modelMax, source: 'auto' }
}

export function getEffectiveContextWindowSize(model: string, settingsWindow?: number): number {
  const { window } = resolveAutoCompactWindow(model, settingsWindow)
  const reserve = Math.min(
    getModelMaxOutputTokens(model).upperLimit,
    SUMMARY_OUTPUT_RESERVE_TOKENS,
    Math.floor(window / SUMMARY_RESERVE_MAX_WINDOW_DIVISOR),
  )
  return window - reserve
}

export function getAutoCompactThreshold(model: string): number {
  return autoCompactThreshold(model, 0)
}

function pctOverride(): number | undefined {
  const pctRaw = flagEnv('MERCURY_AUTOCOMPACT_PCT_OVERRIDE')
  if (pctRaw === undefined || pctRaw === '') return undefined
  const pct = Number.parseFloat(pctRaw)
  return Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : undefined
}

function thresholdOverridden(): boolean {
  const limitRaw = process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  if (limitRaw !== undefined && limitRaw !== '') return true
  return pctOverride() !== undefined
}

function autoCompactThreshold(model: string, fixedTokens: number): number {
  const full = getBlockingLimit(model)
  const oneTurn = Math.ceil(full / SUMMARY_RESERVE_MAX_WINDOW_DIVISOR)
  const fixedFloor = Math.max(0, Math.ceil(fixedTokens)) + oneTurn
  const pct = pctOverride()
  if (pct !== undefined) {
    const effective = getEffectiveContextWindowSize(model)
    return Math.min(Math.max(1, Math.floor((effective * pct) / 100)), full)
  }
  return Math.max(1, full - AUTOCOMPACT_BUFFER_TOKENS, fixedFloor)
}

export function getAutoCompactThresholdWithFixed(model: string, fixedTokens: number): number {
  return autoCompactThreshold(model, fixedTokens)
}

export function autoCompactDisabledReason(): 'MERCURY_COMPACT=0' | 'MERCURY_AUTO_COMPACT=0' | 'turned off in /config' | null {
  if (!flagEnabled('MERCURY_COMPACT')) return 'MERCURY_COMPACT=0'
  if (!flagEnabled('MERCURY_AUTO_COMPACT')) return 'MERCURY_AUTO_COMPACT=0'
  return getGlobalConfig().autoCompactEnabled ? null : 'turned off in /config'
}

export function isAutoCompactEnabled(): boolean {
  return autoCompactDisabledReason() === null
}

export function compactionSettingsText(): string {
  const reason = autoCompactDisabledReason()
  if (reason === null) return 'auto-compact on'
  if (reason === 'MERCURY_COMPACT=0') return 'compaction disabled (MERCURY_COMPACT=0); emergency folding is disabled too'
  return `auto-compact ${reason === 'turned off in /config' ? reason : `off (${reason})`}; emergency folding remains enabled`
}

export function getBlockingLimit(model: string, settingsWindow?: number): number {
  let blockingLimit = getEffectiveContextWindowSize(model, settingsWindow) - MANUAL_COMPACT_BUFFER_TOKENS
  const overrideRaw = process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  if (overrideRaw !== undefined && overrideRaw !== '') {
    const override = Number.parseInt(overrideRaw, 10)
    if (Number.isFinite(override) && override > 0) blockingLimit = override
  }
  return Math.max(1, blockingLimit)
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
  settingsWindow?: number,
): { level: TokenWarningLevel; pctLeft?: number } {
  const autoCompact = isAutoCompactEnabled()
  const ceiling = autoCompact
    ? getAutoCompactThreshold(model)
    : getEffectiveContextWindowSize(model, settingsWindow)
  const warningThreshold = Math.max(
    ceiling - WARNING_THRESHOLD_BUFFER_TOKENS,
    Math.ceil((ceiling * WARNING_MIN_CEILING_NUMERATOR) / WARNING_MIN_CEILING_DENOMINATOR),
  )
  const blockingLimit = getBlockingLimit(model, settingsWindow)
  const window = modelMaxWindow(model)
  const pctLeft = window > 0 ? Math.max(0, Math.round(((ceiling - tokenUsage) / window) * 100)) : 0
  let level: TokenWarningLevel = 'ok'
  if (tokenUsage >= blockingLimit) level = 'blocked'
  else if (autoCompact && tokenUsage >= ceiling) level = 'compact'
  else if (tokenUsage >= warningThreshold) level = 'warn'
  return { level, pctLeft }
}


export type FoldModelChoice = { model: string; source: 'seated' | 'history'; count: number }

export function foldModelFor(messages: readonly Message[], seated: string, opts: { forced: boolean }): FoldModelChoice {
  const count = Math.max(tokenCountWithEstimation(messages, seated), tokenCountWithEstimation(messages))
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
  await awaitContextWindowSource(model)
  const tokenCount = tokenCountWithEstimation(messages, model) - snipTokensFreed
  onMeasured?.(tokenCount + snipTokensFreed)
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

const fixedMaterialSkipState = new OwnerScopedStore<{ noted: boolean }>({
  name: 'autocompact-fixed-material-skip',
  create: () => ({ noted: false }),
})


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
  let compact: boolean
  if (forced) {
    if (querySource === 'session_memory' || querySource === 'compact') {
      return { ...notCompacted, refusal: 'the summary forks never fold themselves' }
    }
    logForDebugging(
      `autoCompact: overflow fold forced (${overflowSignal.source} · ${overflowSignal.family} · ${overflowSignal.shape}${overflowSignal.actualTokens !== undefined && overflowSignal.limitTokens !== undefined ? ` · ${overflowSignal.actualTokens} > ${overflowSignal.limitTokens}` : ''})`,
    )
    compact = true
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
  if (!compact) return { ...notCompacted, measuredRawTokenCount }

  fixedTokens ??= await measureFixed()
  const overflow = detectFixedPrefixOverflow(messages, model, snipTokensFreed, fixedTokens)
  if (overflow !== null) {
    const message = `autoCompact: fixed prefix (~${overflow.prefixTokens} tokens) exceeds the threshold (${overflow.thresholdTokens}); compaction cannot help`
    if (!forced && !thresholdOverridden()) {
      noteFixedSkip(`autoCompact: skipping — fixed prefix (~${overflow.prefixTokens} tokens) exceeds the threshold (${overflow.thresholdTokens}); compaction cannot help`)
      return { ...notCompacted, measuredRawTokenCount }
    }
    logForDebugging(message)
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
  }

  const sessionMemoryArmed = shouldUseSessionMemoryCompaction()
  const foldModel = foldModelFor(messages, model, { forced })
  if (foldModel.source === 'history') {
    logForDebugging(
      `autoCompact: the summary is written by ${foldModel.model} — the seated ${model}'s window does not hold the history (about ${foldModel.count} tokens by Mercury's count)`,
    )
  }
  try {
    return await withFoldStatus(toolUseContext, async scoped => {
    if (isMaintenanceLadderEnabled()) {
      const walked = await runMaintenanceLadder({
        messages,
        toolUseContext: scoped,
        cacheSafeParams,
        querySource,
        recompactionInfo,
        overflow: overflow !== null,
      })
      logForDebugging(
        `maintenance ladder: ${walked.steps
          .map(s => (s.outcome === 'advanced' ? `${s.method}: ${s.reason}` : `${s.method}: APPLIED`))
          .join(' | ')}`,
      )
      if (walked.outcome === 'applied') {
        setLastSummarizedMessageId(undefined)
        runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId }, buildPostCompactMessages(walked.result))
        if (walked.method === 'notes') {
          return { wasCompacted: true, compactionResult: walked.result, consecutiveRapidRefills: refills, ...breaker }
        }
        return {
          wasCompacted: true,
          compactionResult: walked.result,
          consecutiveFailures: 0,
          consecutiveRapidRefills: refills,
          ...breaker,
        }
      }
      return { ...notCompacted, ...breaker }
    }

    if (sessionMemoryArmed) scoped.onCompactProgress?.({ type: 'stage', stage: 'session-memory' })
    const viaMemory = await trySessionMemoryCompaction(messages, scoped.agentId, threshold, scoped)
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
      undefined,
      true,
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
    }, { trigger: 'auto', sessionMemory: sessionMemoryArmed, microcompaction: false })
  } catch (err) {
    if (err instanceof APIUserAbortError) {
      return forced ? { ...notCompacted, refusal: ERROR_MESSAGE_USER_ABORT } : notCompacted
    }
    logError(err)
    const reason = err instanceof Error ? err.message : String(err)
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
