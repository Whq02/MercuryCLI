/**
 * Startup permission-context construction, dangerous-rule detection and
 * stripping, mode-transition side effects, and auto-mode gating.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import {
  isAutoModeActive,
  isAutoModeCircuitBroken,
  setAutoModeActive,
  setAutoModeCircuitBroken,
  getAutoModeFlagCli,
} from './autoModeState.js'
import { setHasExitedPlanMode, setNeedsAutoModeExitAttachment } from '../../bootstrap/state.js'
import { isAutopilotEnabled } from '../autopilot/autopilotGates.js'
import { logForDebugging } from '../debug.js'
import {
  checkFeatureGate_CACHED_MAY_BE_STALE,
  checkSecurityRestrictionGate,
  getDynamicConfig_BLOCKS_ON_INIT,
  getDynamicConfig_CACHED_MAY_BE_STALE,
} from '../../services/analytics/featureGates.js'
import { getMainLoopModel } from '../model/model.js'
import { modelSupportsAutoMode } from '../betas.js'
import {
  getSettings_DEPRECATED,
  hasAutoModeOptIn,
} from '../settings/settings.js'
import { DANGEROUS_BASH_PATTERNS, CROSS_PLATFORM_CODE_EXEC } from './dangerousPatterns.js'
import { modeBypassesPermissions, permissionModeFromString } from './PermissionMode.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  WorkingDirectorySource,
  } from '../../types/permissions.js'

// ─────────────────────────────────────────────────────────────────────────────
// Dangerous allow rules
// ─────────────────────────────────────────────────────────────────────────────

/** Whether content (trimmed, lower-cased) matches a dangerous pattern in any shape. */
function contentMatchesDangerousPattern(content: string | undefined, patterns: string[]): boolean {
  if (content === undefined || content.trim() === '' || content.trim() === '*') {
    return true // tool-wide is dangerous
  }
  const c = content.trim().toLowerCase()
  return patterns.some(p => {
    const pl = p.toLowerCase()
    return (
      c === pl ||
      c === `${pl}:*` ||
      c === `${pl}*` ||
      c === `${pl} *` ||
      (c.startsWith(`${pl} -`) && c.endsWith('*'))
    )
  })
}

/** A Bash allow rule that would auto-approve arbitrary code execution. */
export function isDangerousBashPermission(toolName: string, ruleContent?: string): boolean {
  if (toolName !== BASH_TOOL_NAME) return false
  return contentMatchesDangerousPattern(ruleContent, DANGEROUS_BASH_PATTERNS)
}

/** This slice's OWN PowerShell dangerous-name list (not shared/derived). */
const POWERSHELL_DANGEROUS_NAMES: string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'iex',
  'invoke-expression',
  'icm',
  'invoke-command',
  'start-process',
  'saps',
  'start',
  'start-job',
  'sajb',
  'start-threadjob',
  'register-objectevent',
  'register-engineevent',
  'register-wmievent',
  'register-scheduledjob',
  'new-pssession',
  'nsn',
  'enter-pssession',
  'etsn',
  'add-type',
  'new-object',
]

/** A PowerShell allow rule that would auto-approve code execution (also .exe forms). */
export function isDangerousPowerShellPermission(toolName: string, ruleContent?: string): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) return false
  if (contentMatchesDangerousPattern(ruleContent, POWERSHELL_DANGEROUS_NAMES)) return true
  // Also test the .exe spelling, appended to the FIRST word only.
  const withExe = POWERSHELL_DANGEROUS_NAMES.map(name => {
    const [first, ...rest] = name.split(' ')
    return [`${first}.exe`, ...rest].join(' ')
  })
  return contentMatchesDangerousPattern(ruleContent, withExe)
}

/** ANY allow rule for the agent tool is dangerous. The second parameter is ignored. */
export function isDangerousTaskPermission(toolName: string, _ruleContent?: string): boolean {
  return toolName === AGENT_TOOL_NAME
}

/** A record describing one dangerous or overly-broad permission. */
export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  ruleDisplay: string
  sourceDisplay: string
}

function ruleDisplay(value: PermissionRuleValue): string {
  return value.ruleContent ? `${value.toolName}(${value.ruleContent})` : `${value.toolName}(*)`
}

function sourceDisplay(source: PermissionRuleSource): string {
  return source
}

const CLI_SPEC_RE = /^([^(]+)(?:\(([^)]*)\))?$/

/** Scan loaded allow rules and CLI specs for classifier-dangerous permissions. */
export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const found: DangerousPermissionInfo[] = []
  for (const rule of rules) {
    if (rule.ruleBehavior !== 'allow') continue
    const { toolName, ruleContent } = rule.ruleValue
    if (
      isDangerousBashPermission(toolName, ruleContent) ||
      isDangerousPowerShellPermission(toolName, ruleContent) ||
      isDangerousTaskPermission(toolName, ruleContent)
    ) {
      found.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: ruleDisplay(rule.ruleValue),
        sourceDisplay: sourceDisplay(rule.source),
      })
    }
  }
  for (const spec of cliAllowedTools) {
    const match = CLI_SPEC_RE.exec(spec.trim())
    if (!match) continue
    const toolName = (match[1] ?? '').trim()
    const ruleContent = match[2]?.trim()
    if (
      isDangerousBashPermission(toolName, ruleContent) ||
      isDangerousPowerShellPermission(toolName, ruleContent) ||
      isDangerousTaskPermission(toolName, ruleContent)
    ) {
      found.push({
        ruleValue: { toolName, ruleContent: ruleContent || undefined },
        source: 'cliArg',
        ruleDisplay: ruleContent ? `${toolName}(${ruleContent})` : `${toolName}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }
  return found
}

/** A tool-wide Bash allow rule (no content) is overly broad. */
export function isOverlyBroadBashAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === BASH_TOOL_NAME && !ruleValue.ruleContent
}

/** A tool-wide PowerShell allow rule (no content) is overly broad. */
export function isOverlyBroadPowerShellAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === POWERSHELL_TOOL_NAME && !ruleValue.ruleContent
}

export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  _cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  // Detection is folded out in this build — always empty.
  void rules
  return []
}

export function findOverlyBroadPowerShellPermissions(
  _rules: PermissionRule[],
  _cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// Strip / restore for auto mode
// ─────────────────────────────────────────────────────────────────────────────

type MutableRuleMaps = {
  alwaysAllowRules: Record<string, string[]>
  strippedDangerousRules?: Record<string, string[]>
}

const VALID_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session'])

/** Remove specific dangerous permissions from the context, grouped by destination. */
export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  const next = cloneContext(context)
  const maps = next as unknown as MutableRuleMaps
  for (const perm of dangerousPermissions) {
    if (!VALID_DESTINATIONS.has(perm.source)) continue // policy/flag/command cannot be edited
    const serialized = permissionRuleValueToString(perm.ruleValue)
    const arr = maps.alwaysAllowRules[perm.source] ?? []
    maps.alwaysAllowRules[perm.source] = arr.filter(
      entry => permissionRuleValueToString(permissionRuleValueFromString(entry)) !== serialized,
    )
  }
  return next
}

/** Strip dangerous allow rules and stash them (always leaving the stash present). */
export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const allowRules = getAllowRulesFromContext(context)
  const dangerous = findDangerousClassifierPermissions(allowRules, [])
  const next = cloneContext(context)
  const maps = next as unknown as MutableRuleMaps

  if (dangerous.length === 0) {
    if (!maps.strippedDangerousRules) maps.strippedDangerousRules = {}
    return next
  }

  const stash: Record<string, string[]> = { ...(maps.strippedDangerousRules ?? {}) }
  for (const perm of dangerous) {
    if (!VALID_DESTINATIONS.has(perm.source)) continue
    logForDebugging(
      `auto mode: removing ${perm.ruleDisplay} from ${perm.sourceDisplay} (would bypass the classifier)`,
    )
    const serialized = permissionRuleValueToString(perm.ruleValue)
    const arr = maps.alwaysAllowRules[perm.source] ?? []
    maps.alwaysAllowRules[perm.source] = arr.filter(
      entry => permissionRuleValueToString(permissionRuleValueFromString(entry)) !== serialized,
    )
    stash[perm.source] = [...(stash[perm.source] ?? []), serialized]
  }
  maps.strippedDangerousRules = stash
  return next
}

/** Re-add stashed rules under their original destinations, then empty the stash. */
export function restoreDangerousPermissions(context: ToolPermissionContext): ToolPermissionContext {
  const maps = context as unknown as MutableRuleMaps
  if (!maps.strippedDangerousRules) return context
  const next = cloneContext(context)
  const nextMaps = next as unknown as MutableRuleMaps
  for (const [source, rules] of Object.entries(maps.strippedDangerousRules)) {
    if (rules.length === 0) continue
    nextMaps.alwaysAllowRules[source] = [...(nextMaps.alwaysAllowRules[source] ?? []), ...rules]
  }
  nextMaps.strippedDangerousRules = {}
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode transitions
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a mode uses the flow classifier. */
function modeUsesClassifier(mode: PermissionMode): boolean {
  return mode === 'flow' || (mode === 'strategy' && isAutoModeActive())
}

/** The mode-transition side effects (the caller sets the mode afterwards). */
export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (fromMode === toMode) return context // no-op

  let next = context

  if (fromMode === 'strategy') {
    setHasExitedPlanMode(true)
    next = clearPrePlanMode(next)
  }
  if (toMode === 'strategy' && fromMode !== 'strategy') {
    return prepareContextForPlanMode(next)
  }

  const wasClassifier = modeUsesClassifier(fromMode)
  const willClassifier = modeUsesClassifier(toMode)

  if (!wasClassifier && willClassifier) {
    if (!isAutoModeGateEnabled()) {
      throw new Error('Flow is not available.')
    }
    setAutoModeActive(true)
    next = stripDangerousPermissionsForAutoMode(next)
  } else if (wasClassifier && !willClassifier) {
    setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    next = restoreDangerousPermissions(next)
  }

  return next
}

/** Stash the current mode as the pre-strategy mode (no-op if already in strategy). */
export function prepareContextForPlanMode(context: ToolPermissionContext): ToolPermissionContext {
  if (context.mode === 'strategy') return context
  logForDebugging(`strategy mode entry: stashing pre-strategy mode ${context.mode}`)
  return { ...(context as object), prePlanMode: context.mode } as ToolPermissionContext
}

/** Clear the stashed pre-plan mode, preserving reference equality when empty. */
function clearPrePlanMode(context: ToolPermissionContext): ToolPermissionContext {
  if ((context as { prePlanMode?: PermissionMode }).prePlanMode === undefined) return context
  const next = { ...(context as object) } as { prePlanMode?: PermissionMode }
  delete next.prePlanMode
  return next as ToolPermissionContext
}

/** Always false in this build. */
export function isDefaultPermissionModeAuto(): boolean {
  return false
}
/** Always false in this build. */
export function shouldPlanUseAutoMode(): boolean {
  return false
}
/** Identity in this build. */
export function transitionPlanAutoMode(context: ToolPermissionContext): ToolPermissionContext {
  return context
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarded mode setter
// ─────────────────────────────────────────────────────────────────────────────

export type SetPermissionModeResult = { ok: true; mode: PermissionMode } | { ok: false; error: string }

type UpdateAppState = (
  updater: (context: ToolPermissionContext) => ToolPermissionContext,
) => void

/** The guarded mode setter used by the carousel and SDK set_permission_mode. */
export function setPermissionModeWithGuards(
  mode: PermissionMode,
  context: ToolPermissionContext,
  updateAppState: UpdateAppState,
): SetPermissionModeResult {
  const validation = validateModeEntry(mode, context)
  if (!validation.ok) return validation

  updateAppState(current => {
    if (current.mode === mode) return current // no-op when unchanged
    const transitioned = transitionPermissionMode(current.mode, mode, current)
    return { ...(transitioned as object), mode } as ToolPermissionContext
  })
  return { ok: true, mode }
}

/** Validate a mode entry, producing a distinct message per refusal.
 *  Exported for the seat runner's control door (the apollo/autopilot twin
 *  arms): the door applies THIS eligibility — the opt-in flag, the policy
 *  kill, the bypass launch flag — so the interactive guard and the wire
 *  door can never drift apart (the consent-backdoor law keeps one owner). */
export function validateModeEntry(mode: PermissionMode, context: ToolPermissionContext): SetPermissionModeResult {
  const bypassAvailable = (context as { isBypassPermissionsModeAvailable?: boolean }).isBypassPermissionsModeAvailable === true

  if (mode === 'sovereign') {
    if (isBypassDisabledBySettingsOrPolicy()) {
      return { ok: false, error: 'Sovereign Mode is disabled by settings or organisation policy.' }
    }
    if (!bypassAvailable) {
      return {
        ok: false,
        error: 'Sovereign Mode requires launching with --dangerously-skip-permissions.',
      }
    }
  }
  if (mode === 'flow') {
    if (!isAutoModeGateEnabled()) {
      const reason = getAutoModeUnavailableReason()
      const suffix = reason ? ` ${getAutoModeUnavailableNotification(reason)}` : ''
      return { ok: false, error: `Flow is not available.${suffix}` }
    }
  }
  if (mode === 'autopilot') {
    if (!isAutopilotEnabled()) {
      return {
        ok: false,
        error: 'Autopilot requires the MERCURY_AUTOPILOT opt-in to be armed.',
      }
    }
    if (isBypassDisabledBySettingsOrPolicy()) {
      return { ok: false, error: 'Autopilot is disabled because sovereign mode is disabled by settings or policy.' }
    }
    if (!bypassAvailable) {
      return {
        ok: false,
        error:
          'Cannot set permission mode to autopilot because the session was not launched with --dangerously-skip-permissions',
      }
    }
  }
  return { ok: true, mode }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-mode availability gating
// ─────────────────────────────────────────────────────────────────────────────

/** The remote auto-mode config shape. */
type AutoModeConfig = {
  enabled?: 'enabled' | 'disabled' | 'opt-in'
  model?: string
  twoStageClassifier?: boolean | 'fast' | 'thinking'
  forceExternalPermissions?: boolean
  jsonlTranscript?: boolean
}

const AUTO_MODE_CONFIG_KEY = 'mercury_auto_mode_config'

/**
 * The default enabled state when no remote config is cached. It is
 * 'disabled', which is exactly why the IfCached variant below is
 * load-bearing: this build has no remote-config sink, so the ordinary reader
 * would report 'disabled' on every call and hide auto mode for good; only a
 * genuinely cached disable may close the gate.
 */
const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'disabled'

/**
 * Lazy access to the auto-mode state module, resolved through require so a
 * static import cycle is avoided; optional-chained at the call sites.
 */
const autoModeStateModule =
  (require('./autoModeState.js') as typeof import('./autoModeState.js') | null) ?? null

/** The cached remote config, distinguishing "no cache" from a cached value. */
function getCachedAutoModeConfigIfPresent(): AutoModeConfig | undefined {
  return getDynamicConfig_CACHED_MAY_BE_STALE<AutoModeConfig | undefined>(AUTO_MODE_CONFIG_KEY, undefined)
}

/** Disabled-by-settings when either disable spelling equals 'disable'. */
function isAutoModeDisabledBySettings(): boolean {
  const settings = getSettings_DEPRECATED() as {
    disableAutoMode?: string
    permissions?: { disableAutoMode?: string }
  }
  return settings.disableAutoMode === 'disable' || settings.permissions?.disableAutoMode === 'disable'
}

/** The synchronous auto-mode gate. */
export function isAutoModeGateEnabled(): boolean {
  if (isAutoModeCircuitBroken()) return false
  // Only a genuinely cached disable closes this gate (the IfCached variant,
  // not the default-disabled getAutoModeEnabledState).
  if (getAutoModeEnabledStateIfCached() === 'disabled') return false
  if (isAutoModeDisabledBySettings()) return false
  return true
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

/** The synchronous unavailability reason (settings → circuit-breaker → cached disable). */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  if (isAutoModeCircuitBroken()) return 'circuit-breaker'
  if (getAutoModeEnabledStateIfCached() === 'disabled') return 'circuit-breaker'
  return null
}

/** A short user-facing notification for an unavailability reason. */
export function getAutoModeUnavailableNotification(reason: AutoModeUnavailableReason): string {
  switch (reason) {
    case 'settings':
      return 'Auto mode is disabled by your settings.'
    case 'circuit-breaker':
      return 'Auto mode is temporarily unavailable.'
    case 'model':
      return 'Auto mode is unavailable for this model.'
  }
}

export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

/** The remote-config enabled state (defaulting to disabled when absent/unrecognised). */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  const cached = getCachedAutoModeConfigIfPresent()
  const value = cached?.enabled
  return value === 'enabled' || value === 'opt-in' ? value : AUTO_MODE_ENABLED_DEFAULT
}

/** The enabled state only if a config is genuinely cached. */
export function getAutoModeEnabledStateIfCached(): AutoModeEnabledState | undefined {
  const cached = getCachedAutoModeConfigIfPresent()
  if (!cached) return undefined
  const value = cached.enabled
  return value === 'enabled' || value === 'opt-in' ? value : 'disabled'
}

/** Whether auto mode was opted into via any source. */
export function hasAutoModeOptInAnySource(): boolean {
  return getAutoModeFlagCli() || hasAutoModeOptIn()
}

export type AutoModeGateCheckResult = {
  updateContext: (context: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

/** The async auto-mode verification: returns a transform over the context. */
export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  const config = await getDynamicConfig_BLOCKS_ON_INIT<AutoModeConfig | undefined>(AUTO_MODE_CONFIG_KEY, undefined)
  const disabledBySettings = isAutoModeDisabledBySettings()
  const circuitBroken = config?.enabled === 'disabled' || disabledBySettings
  // The verify path is the only circuitBroken setter (behavior-affecting).
  autoModeStateModule?.setAutoModeCircuitBroken(circuitBroken)

  const modelSupported = modelSupportsAutoMode(getMainLoopModel())
  const optedIn = hasAutoModeOptInAnySource()
  const carouselAvailable =
    !circuitBroken && !disabledBySettings && modelSupported && (config?.enabled === 'enabled' || optedIn)

  logForDebugging(
    `auto mode gate: circuitBroken=${circuitBroken} settingsDisabled=${disabledBySettings} modelSupported=${modelSupported} optedIn=${optedIn} → carousel=${carouselAvailable}`,
  )

  const wasAuto = currentContext.mode === 'flow'
  const wasPlanWithAuto = currentContext.mode === 'strategy' && isAutoModeActive()

  // Explicit-entry availability drops the opt-in requirement.
  const explicitAvailable = !circuitBroken && !disabledBySettings && modelSupported
  if (explicitAvailable) {
    return {
      updateContext: context => setAutoAvailability(context, carouselAvailable),
    }
  }

  // Determine the reason and return a kick-out transform.
  const reason: AutoModeUnavailableReason = disabledBySettings
    ? 'settings'
    : circuitBroken
      ? 'circuit-breaker'
      : 'model'
  logForDebugging(`auto mode unavailable: ${reason}`)

  const notification =
    wasAuto || wasPlanWithAuto ? getAutoModeUnavailableNotification(reason) : undefined

  return {
    updateContext: context => kickOutOfAuto(context, carouselAvailable),
    notification,
  }
}

function setAutoAvailability(context: ToolPermissionContext, available: boolean): ToolPermissionContext {
  if ((context as { isAutoModeAvailable?: boolean }).isAutoModeAvailable === available) return context
  return { ...(context as object), isAutoModeAvailable: available } as ToolPermissionContext
}

function kickOutOfAuto(context: ToolPermissionContext, available: boolean): ToolPermissionContext {
  const mode = context.mode
  if (mode !== 'flow' && !(mode === 'strategy' && isAutoModeActive())) {
    return setAutoAvailability(context, available)
  }
  setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  let next = restoreDangerousPermissions(context)
  if (mode === 'flow') {
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  } else {
    next = clearPrePlanMode({ ...(next as object), prePlanMode: 'default' } as ToolPermissionContext)
  }
  return setAutoAvailability(next, available)
}

// ─────────────────────────────────────────────────────────────────────────────
// Bypass killswitch
// ─────────────────────────────────────────────────────────────────────────────

const BYPASS_DISABLE_GATE = 'mercury_disable_bypass_permissions_mode'

function isBypassDisabledBySettingsOrPolicy(): boolean {
  const settings = getSettings_DEPRECATED() as { permissions?: { disableBypassPermissionsMode?: string } }
  return settings.permissions?.disableBypassPermissionsMode === 'disable'
}

/** Sync: whether bypass is disabled by settings/policy or a cached gate. */
export function isBypassPermissionsModeDisabled(): boolean {
  return isBypassDisabledBySettingsOrPolicy()
}

/**
 * Produce the "bypass disabled" context form. If the current mode has bypass
 * semantics (which covers autopilot too, so an org kill dethrones autopilot
 * as well) it is first reset to default, then the flag is cleared.
 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let next = currentContext
  if (modeBypassesPermissions(currentContext.mode)) {
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  }
  return { ...(next as object), isBypassPermissionsModeAvailable: false } as ToolPermissionContext
}

/** Async entry: given a context, trigger a graceful shutdown when bypass is disabled. */
export async function checkAndDisableBypassPermissions(context: ToolPermissionContext): Promise<void> {
  if (!(context as { isBypassPermissionsModeAvailable?: boolean }).isBypassPermissionsModeAvailable) return
  if (await checkSecurityRestrictionGate(BYPASS_DISABLE_GATE)) {
    logForDebugging('bypass permissions disabled by org policy; shutting down')
    try {
      const { gracefulShutdown } = await import('../gracefulShutdown.js')
      await gracefulShutdown(1, 'bypass_permissions_disabled')
    } catch {
      process.exit(1)
    }
  }
}

export async function shouldDisableBypassPermissions(): Promise<boolean> {
  return checkSecurityRestrictionGate(BYPASS_DISABLE_GATE)
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup construction
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a CLI tool list, splitting on commas/spaces except inside parentheses. */
export function parseToolListFromCLI(tools: string[]): string[] {
  const joined = tools.join(',')
  const result: string[] = []
  let current = ''
  let depth = 0
  for (const ch of joined) {
    if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
      current += ch
    } else if ((ch === ',' || ch === ' ') && depth === 0) {
      if (current.trim() !== '') result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '') result.push(current.trim())
  return result
}

/** Parse base tools: a preset name yields the preset list, else a custom list. */
export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  // No named preset resolver in this slice's surface; a custom list is parsed.
  return parseToolListFromCLI(baseTools)
}

/** The initial mode from CLI plus an optional notification. */
export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli?: string
  dangerouslySkipPermissions: boolean
}): { mode: PermissionMode; notification?: string } {
  const requested = permissionModeCli ? permissionModeFromString(permissionModeCli) : undefined
  const candidates: PermissionMode[] = []

  if (dangerouslySkipPermissions) {
    if (requested === 'autopilot') candidates.push('autopilot')
    candidates.push('sovereign')
  }
  if (requested) candidates.push(requested)
  const settingsMode = settingsDefaultMode()
  if (settingsMode) candidates.push(settingsMode)

  // Disablement of bypass is the OR of a remote feature gate (higher
  // precedence) and the setting; the notification differs by cause.
  const growthBookDisableBypassPermissionsMode = checkFeatureGate_CACHED_MAY_BE_STALE(
    'mercury_disable_bypass_permissions_mode',
  )
  const settingDisableBypassPermissionsMode = isBypassDisabledBySettingsOrPolicy()
  const disableBypassPermissionsMode =
    growthBookDisableBypassPermissionsMode || settingDisableBypassPermissionsMode
  const orgPolicyNotice = 'Sovereign Mode has been disabled by your organization.'
  const settingsNotice = 'Sovereign Mode has been disabled by your settings.'

  let notification: string | undefined
  let resolvedMode: PermissionMode = 'default'
  for (const candidate of candidates) {
    if (candidate === 'sovereign') {
      if (disableBypassPermissionsMode) {
        notification = growthBookDisableBypassPermissionsMode ? orgPolicyNotice : settingsNotice
        continue
      }
      if (!dangerouslySkipPermissions) {
        // A settings defaultMode (or bare --permission-mode spelling) must
        // not arm bypass posture: the launch flag is the road the consent
        // card and the posture record hang off.
        notification =
          'Sovereign Mode requires launching with --dangerously-skip-permissions because it is a bypass-posture mode.'
        continue
      }
    }
    if (candidate === 'autopilot') {
      if (!isAutopilotEnabled()) {
        notification = 'Autopilot requires the MERCURY_AUTOPILOT opt-in.'
        continue
      }
      if (disableBypassPermissionsMode) {
        notification = growthBookDisableBypassPermissionsMode ? orgPolicyNotice : settingsNotice
        continue
      }
      if (!dangerouslySkipPermissions) {
        notification = 'Autopilot requires launching with --dangerously-skip-permissions because it is a bypass-posture mode.'
        continue
      }
    }
    // A surviving candidate wins, carrying whatever notification accumulated.
    resolvedMode = candidate
    break
  }

  const result: { mode: PermissionMode; notification?: string } = notification
    ? { mode: resolvedMode, notification }
    : { mode: resolvedMode }

  // A session that BOOTS into flow must arm the same safety state a runtime
  // transition arms, or the dangerous always-allow rules would never be stripped.
  if (
    result.mode === 'flow'
  ) {
    autoModeStateModule?.setAutoModeActive(true)
  }
  return result
}

function settingsDefaultMode(): PermissionMode | undefined {
  const settings = getSettings_DEPRECATED() as { permissions?: { defaultMode?: string } }
  const raw = settings.permissions?.defaultMode
  if (!raw) return undefined
  const mode = permissionModeFromString(raw)
  // (No hosted-remote mode restriction exists — Mercury never runs as a
  // hosted remote.)
  return mode
}

/** Build the initial tool-permission context. */
export async function initializeToolPermissionContext(args: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  addDirs?: string[]
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  dangerousPermissions: DangerousPermissionInfo[]
  overlyBroadBashPermissions: DangerousPermissionInfo[]
  /** Every admitted additional directory (flag + remembered), resolved, in
   *  admission order — the workspace/instruction-roots list the boot sets.
   *  (Named `admitted…` deliberately: the boot-config family owns the
   *  censused added-directories field identifier — one owner.) */
  admittedDirectories: string[]
}> {
  const { loadAllPermissionRulesFromDisk } = await import('./permissionsLoader.js')
  const { applyPermissionRulesToPermissionContext } = await import('./permissions.js')
  // The shared workspace-directory validator (its own header names this
  // boot-time pass as a consumer beside the /add-dir command).
  const { validateDirectoryForWorkspace, resolveWithoutTrailingSeparator } = await import('../../commands/add-dir/validation.js')

  const allowRules = parseToolListFromCLI(args.allowedToolsCli).map(normalizeRuleString)
  const denyRules = parseToolListFromCLI(args.disallowedToolsCli)

  const bypassAvailable =
    (args.permissionMode === 'sovereign' || args.allowDangerouslySkipPermissions) &&
    !isBypassDisabledBySettingsOrPolicy()

  const diskRules = loadAllPermissionRulesFromDisk()

  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (args.permissionMode === 'flow') {
    dangerousPermissions = findDangerousClassifierPermissions(
      diskRules,
      allowRules,
    )
  }

  // Boot-time --add-dir directories enter the SAME map the in-session
  // /add-dir admit writes — before this pass the flag reached the workspace
  // list but never the tool-permission context, so the granted read scope
  // (and the nested guides keyed on it) only arrived after an in-session
  // admit. Each candidate runs the shared validator (resolution + existence
  // + containment against cwd and the admissions so far); an invalid entry
  // warns and is skipped — the boot never aborts on one (the validator's
  // own boot-pass contract).
  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<string, AdditionalWorkingDirectory>()
  // The WORKSPACE list (instruction roots, bare-mode law): every VALID
  // directory the operator named, in admission order — including one already
  // contained in a working root (its permission scope exists, so it skips
  // the map, but "never refuse a directory the operator named" governs the
  // workspace side).
  const admittedWorkspaceDirs: string[] = []
  const admitDirectory = async (
    dir: string,
    source: WorkingDirectorySource,
    origin: string,
  ): Promise<void> => {
    let result: Awaited<ReturnType<typeof validateDirectoryForWorkspace>>
    try {
      result = await validateDirectoryForWorkspace(
        dir,
        { additionalWorkingDirectories } as unknown as ToolPermissionContext,
      )
    } catch (error) {
      // An exotic stat failure must not abort the whole start.
      warnings.push(`${origin} ${dir}: unreadable (${error instanceof Error ? error.message : String(error)}) — skipped`)
      return
    }
    if (result.resultType === 'success') {
      additionalWorkingDirectories.set(result.absolutePath, {
        path: result.absolutePath,
        source,
      })
      if (!admittedWorkspaceDirs.includes(result.absolutePath)) {
        admittedWorkspaceDirs.push(result.absolutePath)
      }
    } else if (result.resultType === 'alreadyInWorkingDirectory') {
      // Contained in an already-granted root — the permission scope exists;
      // the workspace list still records the explicit naming.
      const resolved = resolveWithoutTrailingSeparator(dir)
      if (!admittedWorkspaceDirs.includes(resolved)) {
        admittedWorkspaceDirs.push(resolved)
      }
    } else if (result.resultType !== 'emptyPath') {
      warnings.push(
        `${origin} ${dir}: ${result.resultType === 'notADirectory' ? 'not a directory' : 'path not found'} — skipped`,
      )
    }
  }
  for (const dir of args.addDirs ?? []) {
    await admitDirectory(dir, 'cliArg', '--add-dir')
  }

  // The boot reader for `permissions.additionalDirectories` — the key
  // `/add-dir --remember` persists. It had a writer and no reader: a
  // remembered directory returned to neither the workspace nor the
  // permission context at the next boot. Every enabled settings source is
  // read (policy only under managed-rules-only, mirroring the rules
  // loader), each directory admitted the way the flag path admits, and
  // attributed to its source.
  const { shouldAllowManagedPermissionRulesOnly } = await import('./permissionsLoader.js')
  const { getSettingsForSource } = await import('../settings/settings.js')
  const { getEnabledSettingSources } = await import('../settings/constants.js')
  const directorySources = shouldAllowManagedPermissionRulesOnly()
    ? (['policySettings'] as const)
    : getEnabledSettingSources()
  for (const source of directorySources) {
    let remembered: string[] = []
    try {
      const settings = getSettingsForSource(source as never) as
        | { permissions?: { additionalDirectories?: unknown } }
        | undefined
      const raw = settings?.permissions?.additionalDirectories
      if (Array.isArray(raw)) remembered = raw.filter((d): d is string => typeof d === 'string')
    } catch {
      // An unreadable source contributes nothing — never aborts the start.
      continue
    }
    for (const dir of remembered) {
      await admitDirectory(dir, source as WorkingDirectorySource, `permissions.additionalDirectories (${source})`)
    }
  }

  let context = {
    mode: args.permissionMode,
    additionalWorkingDirectories,
    alwaysAllowRules: { cliArg: allowRules },
    alwaysDenyRules: { cliArg: denyRules },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: bypassAvailable,
    // The auto-availability flag is set unconditionally from the sync gate.
    ...{ isAutoModeAvailable: isAutoModeGateEnabled() },
  } as unknown as ToolPermissionContext

  context = applyPermissionRulesToPermissionContext(context, diskRules)

  return {
    toolPermissionContext: context,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions: [],
    admittedDirectories: admittedWorkspaceDirs,
  }
}

function normalizeRuleString(rule: string): string {
  const value = permissionRuleValueFromString(rule)
  return value.ruleContent ? `${value.toolName}(${value.ruleContent})` : value.toolName
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function cloneContext(context: ToolPermissionContext): ToolPermissionContext {
  const c = context as unknown as {
    alwaysAllowRules?: Record<string, string[]>
    strippedDangerousRules?: Record<string, string[]>
  }
  return {
    ...(context as object),
    alwaysAllowRules: cloneMap(c.alwaysAllowRules),
    strippedDangerousRules: c.strippedDangerousRules ? cloneMap(c.strippedDangerousRules) : undefined,
  } as unknown as ToolPermissionContext
}

function cloneMap(map?: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(map ?? {})) out[key] = [...value]
  return out
}

function getAllowRulesFromContext(context: ToolPermissionContext): PermissionRule[] {
  const bySource = (context as unknown as { alwaysAllowRules?: Record<string, string[]> }).alwaysAllowRules ?? {}
  const rules: PermissionRule[] = []
  for (const [source, entries] of Object.entries(bySource)) {
    for (const entry of entries) {
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(entry),
      })
    }
  }
  return rules
}
