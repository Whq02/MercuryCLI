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
import { holdModeTransition, recordModeTransition, type ModeTransitionRoad } from './modeTransitions.js'
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


function contentMatchesDangerousPattern(content: string | undefined, patterns: string[]): boolean {
  if (content === undefined || content.trim() === '' || content.trim() === '*') {
    return true
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

export function isDangerousBashPermission(toolName: string, ruleContent?: string): boolean {
  if (toolName !== BASH_TOOL_NAME) return false
  return contentMatchesDangerousPattern(ruleContent, DANGEROUS_BASH_PATTERNS)
}

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

export function isDangerousPowerShellPermission(toolName: string, ruleContent?: string): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) return false
  if (contentMatchesDangerousPattern(ruleContent, POWERSHELL_DANGEROUS_NAMES)) return true
  const withExe = POWERSHELL_DANGEROUS_NAMES.map(name => {
    const [first, ...rest] = name.split(' ')
    return [`${first}.exe`, ...rest].join(' ')
  })
  return contentMatchesDangerousPattern(ruleContent, withExe)
}

export function isDangerousTaskPermission(toolName: string, _ruleContent?: string): boolean {
  return toolName === AGENT_TOOL_NAME
}

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

export function isOverlyBroadBashAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === BASH_TOOL_NAME && !ruleValue.ruleContent
}

export function isOverlyBroadPowerShellAllowRule(ruleValue: PermissionRuleValue): boolean {
  return ruleValue.toolName === POWERSHELL_TOOL_NAME && !ruleValue.ruleContent
}

export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  _cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  void rules
  return []
}

export function findOverlyBroadPowerShellPermissions(
  _rules: PermissionRule[],
  _cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  return []
}


type MutableRuleMaps = {
  alwaysAllowRules: Record<string, string[]>
  strippedDangerousRules?: Record<string, string[]>
}

const VALID_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session'])

export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  const next = cloneContext(context)
  const maps = next as unknown as MutableRuleMaps
  for (const perm of dangerousPermissions) {
    if (!VALID_DESTINATIONS.has(perm.source)) continue
    const serialized = permissionRuleValueToString(perm.ruleValue)
    const arr = maps.alwaysAllowRules[perm.source] ?? []
    maps.alwaysAllowRules[perm.source] = arr.filter(
      entry => permissionRuleValueToString(permissionRuleValueFromString(entry)) !== serialized,
    )
  }
  return next
}

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


function modeUsesClassifier(mode: PermissionMode): boolean {
  return mode === 'flow' || (mode === 'strategy' && isAutoModeActive())
}

export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (fromMode === toMode) return context

  let next = context

  if (fromMode === 'strategy') {
    setHasExitedPlanMode(true)
    next = clearPreStrategyMode(next)
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

export function prepareContextForPlanMode(context: ToolPermissionContext): ToolPermissionContext {
  if (context.mode === 'strategy') return context
  logForDebugging(`strategy mode entry: stashing pre-strategy mode ${context.mode}`)
  return { ...(context as object), preStrategyMode: context.mode } as ToolPermissionContext
}

function clearPreStrategyMode(context: ToolPermissionContext): ToolPermissionContext {
  if ((context as { preStrategyMode?: PermissionMode }).preStrategyMode === undefined) return context
  const next = { ...(context as object) } as { preStrategyMode?: PermissionMode }
  delete next.preStrategyMode
  return next as ToolPermissionContext
}

export function isDefaultPermissionModeAuto(): boolean {
  return false
}
export function shouldPlanUseAutoMode(): boolean {
  return false
}
export function transitionPlanAutoMode(context: ToolPermissionContext): ToolPermissionContext {
  return context
}


export type SetPermissionModeResult = { ok: true; mode: PermissionMode } | { ok: false; error: string }

type UpdateAppState = (
  updater: (context: ToolPermissionContext) => ToolPermissionContext,
) => void

export function setPermissionModeWithGuards(
  mode: PermissionMode,
  context: ToolPermissionContext,
  updateAppState: UpdateAppState,
  road: ModeTransitionRoad = 'carousel',
): SetPermissionModeResult {
  const validation = validateModeEntry(mode, context)
  if (!validation.ok) {
    if (context.mode !== mode) holdModeTransition({ from: context.mode, to: mode, road, detail: validation.error })
    return validation
  }

  updateAppState(current => {
    if (current.mode === mode) return current
    const transitioned = transitionPermissionMode(current.mode, mode, current)
    recordModeTransition({ from: current.mode, to: mode, road })
    return { ...(transitioned as object), mode } as ToolPermissionContext
  })
  return { ok: true, mode }
}

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


type AutoModeConfig = {
  enabled?: 'enabled' | 'disabled' | 'opt-in'
  forceExternalPermissions?: boolean
}

const AUTO_MODE_CONFIG_KEY = 'mercury_auto_mode_config'

const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'disabled'

const autoModeStateModule =
  (require('./autoModeState.js') as typeof import('./autoModeState.js') | null) ?? null

function getCachedAutoModeConfigIfPresent(): AutoModeConfig | undefined {
  return getDynamicConfig_CACHED_MAY_BE_STALE<AutoModeConfig | undefined>(AUTO_MODE_CONFIG_KEY, undefined)
}

function isAutoModeDisabledBySettings(): boolean {
  const settings = getSettings_DEPRECATED() as { permissions?: { disableFlowMode?: boolean } }
  return settings.permissions?.disableFlowMode === true
}

export function isAutoModeGateEnabled(): boolean {
  if (isAutoModeCircuitBroken()) return false
  if (getAutoModeEnabledStateIfCached() === 'disabled') return false
  if (isAutoModeDisabledBySettings()) return false
  return true
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  if (isAutoModeCircuitBroken()) return 'circuit-breaker'
  if (getAutoModeEnabledStateIfCached() === 'disabled') return 'circuit-breaker'
  return null
}

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

export function getAutoModeEnabledState(): AutoModeEnabledState {
  const cached = getCachedAutoModeConfigIfPresent()
  const value = cached?.enabled
  return value === 'enabled' || value === 'opt-in' ? value : AUTO_MODE_ENABLED_DEFAULT
}

export function getAutoModeEnabledStateIfCached(): AutoModeEnabledState | undefined {
  const cached = getCachedAutoModeConfigIfPresent()
  if (!cached) return undefined
  const value = cached.enabled
  return value === 'enabled' || value === 'opt-in' ? value : 'disabled'
}

export function hasAutoModeOptInAnySource(): boolean {
  return getAutoModeFlagCli() || hasAutoModeOptIn()
}

export type AutoModeGateCheckResult = {
  updateContext: (context: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  const config = await getDynamicConfig_BLOCKS_ON_INIT<AutoModeConfig | undefined>(AUTO_MODE_CONFIG_KEY, undefined)
  const disabledBySettings = isAutoModeDisabledBySettings()
  const circuitBroken = config?.enabled === 'disabled' || disabledBySettings
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

  const explicitAvailable = !circuitBroken && !disabledBySettings && modelSupported
  if (explicitAvailable) {
    return {
      updateContext: context => setAutoAvailability(context, carouselAvailable),
    }
  }

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
    recordModeTransition({ from: 'flow', to: 'default', road: 'flow-unavailable' })
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  } else {
    next = clearPreStrategyMode({ ...(next as object), preStrategyMode: 'default' } as ToolPermissionContext)
  }
  return setAutoAvailability(next, available)
}


const BYPASS_DISABLE_GATE = 'mercury_disable_bypass_permissions_mode'

function isBypassDisabledBySettingsOrPolicy(): boolean {
  const settings = getSettings_DEPRECATED() as { permissions?: { disableSovereignMode?: boolean } }
  return settings.permissions?.disableSovereignMode === true
}

export function isBypassPermissionsModeDisabled(): boolean {
  return isBypassDisabledBySettingsOrPolicy()
}

export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let next = currentContext
  if (modeBypassesPermissions(currentContext.mode)) {
    recordModeTransition({ from: currentContext.mode, to: 'default', road: 'bypass-disabled' })
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  }
  return { ...(next as object), isBypassPermissionsModeAvailable: false } as ToolPermissionContext
}

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

export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  return parseToolListFromCLI(baseTools)
}

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

  const gateDisablesSovereign = checkFeatureGate_CACHED_MAY_BE_STALE(
    'mercury_disable_bypass_permissions_mode',
  )
  const settingDisablesSovereign = isBypassDisabledBySettingsOrPolicy()
  const sovereignDisabled =
    gateDisablesSovereign || settingDisablesSovereign
  const orgPolicyNotice = 'Sovereign Mode has been disabled by your organization.'
  const settingsNotice = 'Sovereign Mode has been disabled by your settings.'

  let notification: string | undefined
  let resolvedMode: PermissionMode = 'default'
  for (const candidate of candidates) {
    if (candidate === 'sovereign') {
      if (sovereignDisabled) {
        notification = gateDisablesSovereign ? orgPolicyNotice : settingsNotice
        continue
      }
      if (!dangerouslySkipPermissions) {
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
      if (sovereignDisabled) {
        notification = gateDisablesSovereign ? orgPolicyNotice : settingsNotice
        continue
      }
      if (!dangerouslySkipPermissions) {
        notification = 'Autopilot requires launching with --dangerously-skip-permissions because it is a bypass-posture mode.'
        continue
      }
    }
    resolvedMode = candidate
    break
  }

  const result: { mode: PermissionMode; notification?: string } = notification
    ? { mode: resolvedMode, notification }
    : { mode: resolvedMode }

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
  return mode
}

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
  admittedDirectories: string[]
}> {
  const { loadAllPermissionRulesFromDisk } = await import('./permissionsLoader.js')
  const { applyPermissionRulesToPermissionContext } = await import('./permissions.js')
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

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<string, AdditionalWorkingDirectory>()
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
    ...{ isAutoModeAvailable: isAutoModeGateEnabled() },
  } as unknown as ToolPermissionContext

  context = applyPermissionRulesToPermissionContext(context, diskRules)
  recordModeTransition({ from: null, to: context.mode, road: 'boot' })

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
