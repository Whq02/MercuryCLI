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
import { getTokenUsage, tokenCountWithEstimation } from '../../utils/tokens.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { ownerFromToolUseContext } from '../run/resolveOwner.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import { markPostCompaction } from '../api/logging.js'
import type { OverflowSignal } from '../api/overflowSignal.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import {
  compactionBreakerAllows,
  type CompactionState,
  decideCompaction,
  percentUsedFromPercentLeft,
} from './compactionPolicy.js'
import {
  compactConversation,
  type CompactionResult,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { isMaintenanceLadderEnabled, runMaintenanceLadder } from './maintenanceLadder.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'


void notifyCompaction


export const MIN_AUTOCOMPACT_WINDOW = 100_000
export const MAX_AUTOCOMPACT_WINDOW = 1_000_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

const SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000
const MAX_CONSECUTIVE_FAILURES = 3
const RAPID_REFILL_TURN_WINDOW = 3
const RAPID_REFILL_LIMIT = 3

const SUMMARY_RESERVE_MAX_WINDOW_DIVISOR = 4
const WARNING_MIN_CEILING_NUMERATOR = 4
const WARNING_MIN_CEILING_DENOMINATOR = 5

export const AUTOCOMPACT_THRASH_MESSAGE =
  `Auto-compaction is looping: the context refilled within ${RAPID_REFILL_TURN_WINDOW} turns ` +
  `${RAPID_REFILL_LIMIT} times in a row. The usual cause is a single input larger than the ` +
  `window can hold — a file read or a tool output. Read it in smaller pieces, or start a ` +
  `fresh conversation with /clear.`

export type AutoCompactWindowSource = 'settings' | 'auto' | 'experiment' | 'model-default'

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
  consecutiveRapidRefills?: number
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
  const full = getBlockingLimit(model)
  const pctRaw = flagEnv('MERCURY_AUTOCOMPACT_PCT_OVERRIDE')
  if (pctRaw !== undefined && pctRaw !== '') {
    const pct = Number.parseFloat(pctRaw)
    if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
      const effective = getEffectiveContextWindowSize(model)
      return Math.min(Math.max(1, Math.floor((effective * pct) / 100)), full)
    }
  }
  return full
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) return false
  return getGlobalConfig().autoCompactEnabled
}

export function getBlockingLimit(model: string, settingsWindow?: number): number {
  let blockingLimit = getEffectiveContextWindowSize(model, settingsWindow) - MANUAL_COMPACT_BUFFER_TOKENS
  const overrideRaw = process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  if (overrideRaw !== undefined && overrideRaw !== '') {
    const override = Number.parseInt(overrideRaw, 10)
    if (Number.isFinite(override) && override > 0) blockingLimit = override
  }
  return blockingLimit
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
  const thresholdTokens = getAutoCompactThreshold(model)
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
}> {
  const notCompacted = { wasCompacted: false as const, consecutiveFailures: tracking?.consecutiveFailures }
  const forced = overflowSignal !== undefined
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return forced ? { ...notCompacted, refusal: 'compaction is disabled (DISABLE_COMPACT)' } : notCompacted
  }
  const failures = tracking?.consecutiveFailures ?? 0
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return forced ? { ...notCompacted, refusal: 'compaction has failed repeatedly and is paused for this session' } : notCompacted
  }
  if (suppressBreakerEnabled() && !compactionBreakerAllows(failures)) {
    logForDebugging('autoCompact: Mercury breaker suppressed a doomed retry')
    return forced ? { ...notCompacted, refusal: 'compaction has failed repeatedly and is paused for this session' } : notCompacted
  }

  const model = toolUseContext.options.mainLoopModel
  let measuredRawTokenCount: number | null = null
  let compact: boolean
  if (forced) {
    if (querySource === 'session_memory' || querySource === 'compact') {
      return { ...notCompacted, refusal: 'the summary forks never fold themselves' }
    }
    if (!isAutoCompactEnabled()) return { ...notCompacted, refusal: 'automatic compaction is off' }
    logForDebugging(
      `autoCompact: overflow fold forced (${overflowSignal.source} · ${overflowSignal.family} · ${overflowSignal.shape}${overflowSignal.actualTokens !== undefined && overflowSignal.limitTokens !== undefined ? ` · ${overflowSignal.actualTokens} > ${overflowSignal.limitTokens}` : ''})`,
    )
    compact = true
  } else {
    compact = await shouldAutoCompact(messages, model, querySource, snipTokensFreed, raw => {
      measuredRawTokenCount = raw
    })
  }

  if (!compact && advanceTriggerEnabled() && isAutoCompactEnabled()) {
    if (querySource !== 'session_memory' && querySource !== 'compact' && querySource !== 'context_agent') {
      try {
        const tokenCount = (measuredRawTokenCount ?? tokenCountWithEstimation(messages, model)) - snipTokensFreed
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

  const overflow = detectFixedPrefixOverflow(messages, model, snipTokensFreed)
  if (overflow !== null) {
    logForDebugging(
      `autoCompact: fixed prefix (~${overflow.prefixTokens} tokens) exceeds the threshold (${overflow.thresholdTokens}); compaction cannot help`,
    )
  }

  const refills = rapidRefillCount(tracking)
  if (refills >= RAPID_REFILL_LIMIT) {
    logForDebugging('autoCompact: rapid-refill breaker tripped')
    return { ...notCompacted, consecutiveRapidRefills: refills, rapidRefillBreakerTripped: true }
  }

  const threshold = getAutoCompactThreshold(model)
  const recompactionInfo: RecompactionInfo = {
    isRecompaction: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.compacted === true ? tracking.turnCounter : -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: threshold,
    querySource,
  }

  try {
    if (isMaintenanceLadderEnabled()) {
      const walked = await runMaintenanceLadder({
        messages,
        toolUseContext,
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
        runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId })
        if (walked.method === 'notes') {
          markPostCompaction()
          return { wasCompacted: true, compactionResult: walked.result, consecutiveRapidRefills: refills }
        }
        return {
          wasCompacted: true,
          compactionResult: walked.result,
          consecutiveFailures: 0,
          consecutiveRapidRefills: refills,
        }
      }
      return notCompacted
    }

    const viaMemory = await trySessionMemoryCompaction(messages, toolUseContext.agentId, threshold)
    if (viaMemory !== null) {
      setLastSummarizedMessageId(undefined)
      runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId })
      markPostCompaction()
      return { wasCompacted: true, compactionResult: viaMemory, consecutiveRapidRefills: refills }
    }

    const result = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true,
      undefined,
      true,
      recompactionInfo,
      overflowSignal,
    )
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup({ querySource, owner: toolUseContext.owner, agentId: toolUseContext.agentId })
    return {
      wasCompacted: true,
      compactionResult: result,
      consecutiveFailures: 0,
      consecutiveRapidRefills: refills,
    }
  } catch (err) {
    if (err instanceof Error && err.message === ERROR_MESSAGE_USER_ABORT) {
      return forced ? { ...notCompacted, refusal: ERROR_MESSAGE_USER_ABORT } : notCompacted
    }
    logError(err)
    const nextFailures = failures + 1
    if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
      logForDebugging(
        `autoCompact: ${nextFailures} consecutive failures — circuit breaker tripped for this session`,
        { level: 'warn' },
      )
    }
    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      ...(forced ? { refusal: err instanceof Error ? err.message : String(err) } : {}),
    }
  }
}
