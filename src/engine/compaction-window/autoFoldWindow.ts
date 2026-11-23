import { getSdkBetas } from '../../boot/process-state/processState.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { getContextWindowForModel, getModelInputCeiling, getModelMaxOutputTokens } from '../../models/facts/capabilities.js'
import { flagEnabled, flagEnv } from '../../platform/substrate/flagRegistry.js'

export const MIN_AUTOCOMPACT_WINDOW = 100_000
export const MAX_AUTOCOMPACT_WINDOW = 1_000_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const AUTOCOMPACT_BUFFER_TOKENS = 20_000

const SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000

export const SUMMARY_RESERVE_MAX_WINDOW_DIVISOR = 4
const WARNING_MIN_CEILING_NUMERATOR = 4
const WARNING_MIN_CEILING_DENOMINATOR = 5

export type AutoCompactWindowSource = 'settings' | 'auto' | 'experiment' | 'model-default'

export type TokenWarningLevel = 'ok' | 'warn' | 'compact' | 'blocked'

function modelMaxWindow(model: string): number {
  return getModelInputCeiling(model, getSdkBetas())
}

export function autoCompactWindowIsInputLimit(model: string, window: number): boolean {
  return window === modelMaxWindow(model) && window < getContextWindowForModel(model, getSdkBetas())
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

export function getTurnReserveTokens(model: string): number {
  return Math.min(getModelMaxOutputTokens(model).upperLimit, AUTOCOMPACT_BUFFER_TOKENS, Math.floor(resolveAutoCompactWindow(model).window / 8))
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

export function thresholdOverridden(): boolean {
  const limitRaw = flagEnv('MERCURY_BLOCKING_LIMIT_OVERRIDE')
  if (limitRaw !== undefined && limitRaw !== '') return true
  return pctOverride() !== undefined
}

function autoCompactThreshold(model: string, fixedTokens: number): number {
  const blockingLimit = getBlockingLimit(model)
  const pct = pctOverride()
  if (pct !== undefined) {
    const effectiveWindow = getEffectiveContextWindowSize(model)
    return Math.min(Math.max(1, Math.floor((effectiveWindow * pct) / 100)), blockingLimit)
  }
  const fixedFloor = Math.ceil(Math.max(0, fixedTokens)) + Math.ceil(blockingLimit / 4)
  return Math.max(1, blockingLimit - getTurnReserveTokens(model), fixedFloor)
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
  const overrideRaw = flagEnv('MERCURY_BLOCKING_LIMIT_OVERRIDE')
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
  const autoEnabled = isAutoCompactEnabled()
  const ceiling = autoEnabled ? getAutoCompactThreshold(model) : getEffectiveContextWindowSize(model, settingsWindow)
  const warningThreshold = Math.max(
    ceiling - WARNING_THRESHOLD_BUFFER_TOKENS,
    Math.ceil((ceiling * WARNING_MIN_CEILING_NUMERATOR) / WARNING_MIN_CEILING_DENOMINATOR),
  )
  const blockingLimit = getBlockingLimit(model, settingsWindow)
  const fullWindow = getContextWindowForModel(model, getSdkBetas())
  const pctLeft = fullWindow > 0 ? Math.max(0, Math.round(((ceiling - tokenUsage) / fullWindow) * 100)) : 0
  if (tokenUsage >= blockingLimit) return { level: 'blocked', pctLeft }
  if (autoEnabled && tokenUsage >= ceiling) return { level: 'compact', pctLeft }
  if (tokenUsage >= warningThreshold) return { level: 'warn', pctLeft }
  return { level: 'ok', pctLeft }
}
