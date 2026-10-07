import type { ToolPermissionContext } from '../../Tool.js'
import { lspPermissionNote, lspCliNote, lspHookNote } from '../../services/lsp/toolFamily.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { setSessionPermissionModeResolution } from '../../bootstrap/state.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { holdModeTransition, recordModeTransition, type ModeTransitionRoad } from './modeTransitions.js'
import {
  getSettings_DEPRECATED,
  getSettingsWithErrors,
  getSettingsForSource,
} from '../settings/settings.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import { DANGEROUS_BASH_PATTERNS, CROSS_PLATFORM_CODE_EXEC } from './dangerousPatterns.js'
import { modeBypassesPermissions, permissionModeTitle, permissionModeFromString } from './PermissionMode.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
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

export function findDangerousPermissions(
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


type MutableRuleMaps = {
  alwaysAllowRules: Record<string, string[]>
  strippedDangerousRules?: Record<string, string[]>
}

const VALID_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session'])

export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const allowRules = getAllowRulesFromContext(context)
  const dangerous = findDangerousPermissions(allowRules, [])
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
      `flow: setting aside ${perm.ruleDisplay} from ${perm.sourceDisplay} (a dangerous allow rule never applies in flow)`,
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


export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (fromMode === toMode) return context

  let next = context

  if (fromMode !== 'flow' && toMode === 'flow') {
    if (!isAutoModeGateEnabled()) {
      throw new Error('Flow is not available.')
    }
    next = stripDangerousPermissionsForAutoMode(next)
  } else if (fromMode === 'flow' && toMode !== 'flow') {
    next = restoreDangerousPermissions(next)
  }

  return next
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
        error: 'Sovereign Mode requires launching with --sovereign.',
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
  return { ok: true, mode }
}


function isAutoModeDisabledBySettings(): boolean {
  return getSettings_DEPRECATED().guardrails?.disableFlowMode === true
}

export function isAutoModeGateEnabled(): boolean {
  return !isAutoModeDisabledBySettings()
}

export type AutoModeUnavailableReason = 'settings'

export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  return null
}

export function getAutoModeUnavailableNotification(reason: AutoModeUnavailableReason): string {
  switch (reason) {
    case 'settings':
      return 'Flow is closed by your settings.'
  }
}


function isBypassDisabledBySettingsOrPolicy(): boolean {
  return getSettings_DEPRECATED().guardrails?.disableSovereignMode === true
}

export function isSovereignDisabled(): boolean {
  return isBypassDisabledBySettingsOrPolicy()
}

export function createSovereignDisabledContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let next = currentContext
  if (modeBypassesPermissions(currentContext.mode)) {
    recordModeTransition({ from: currentContext.mode, to: 'default', road: 'bypass-disabled' })
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  }
  return { ...(next as object), isBypassPermissionsModeAvailable: false } as ToolPermissionContext
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

export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli?: string
  dangerouslySkipPermissions: boolean
}): { mode: PermissionMode; notification?: string } {
  const resolution = resolveSessionPermissionMode({
    permissionModeCli,
    dangerouslySkipPermissions,
    envBypassArmed: flagEnabled('MERCURY_SKIP_PERMISSIONS'),
  })
  setSessionPermissionModeResolution(resolution)
  return resolution.notification === undefined
    ? { mode: resolution.mode }
    : { mode: resolution.mode, notification: resolution.notification }
}

export type SessionPermissionModeSource =
  | 'launch-flag'
  | 'mode-argument'
  | 'saved-settings'
  | 'session-birth'
  | 'session-choice'
  | 'default'

export type SessionPermissionModeResolution = {
  mode: PermissionMode
  source: SessionPermissionModeSource
  notification?: string
}

export function sessionPermissionModeSourceWords(source: SessionPermissionModeSource): string {
  switch (source) {
    case 'launch-flag':
      return 'the launch flag'
    case 'mode-argument':
      return 'the mode argument'
    case 'saved-settings':
      return 'your settings'
    case 'session-birth':
      return "the session's birth"
    case 'session-choice':
      return "the session's own choice"
    case 'default':
      return 'the default'
  }
}

export function describeSessionPermissionMode(resolution: {
  mode: PermissionMode
  source: SessionPermissionModeSource
}): string {
  return `${permissionModeTitle(resolution.mode)} · from ${sessionPermissionModeSourceWords(resolution.source)}`
}

export function resolveSessionPermissionMode({
  permissionModeCli,
  dangerouslySkipPermissions,
  envBypassArmed,
}: {
  permissionModeCli?: string
  dangerouslySkipPermissions: boolean
  envBypassArmed?: boolean
}): SessionPermissionModeResolution {
  const requested = permissionModeCli ? permissionModeFromString(permissionModeCli) : undefined
  const candidates: Array<{ mode: PermissionMode; source: SessionPermissionModeSource }> = []

  if (dangerouslySkipPermissions) {
    candidates.push({ mode: 'sovereign', source: envBypassArmed === true ? 'session-birth' : 'launch-flag' })
  }
  if (requested) candidates.push({ mode: requested, source: 'mode-argument' })
  const settingsMode = savedPermissionModeCandidate()
  if (settingsMode) candidates.push({ mode: settingsMode, source: 'saved-settings' })

  const ordered: PermissionMode[] = candidates.map(c => c.mode)
  const result = resolvePermissionModeCandidates(ordered, { dangerouslySkipPermissions })
  const winner = candidates.find(c => c.mode === result.mode) ?? { mode: result.mode as PermissionMode, source: 'default' as SessionPermissionModeSource }
  return { ...result, source: winner.source }
}

export function resolvePermissionModeCandidates(
  candidates: readonly PermissionMode[],
  { dangerouslySkipPermissions }: { dangerouslySkipPermissions: boolean },
): { mode: PermissionMode; notification?: string } {
  const sovereignDisabled = isBypassDisabledBySettingsOrPolicy()
  const settingsNotice = 'Sovereign Mode has been disabled by your settings.'

  let notification: string | undefined
  let resolvedMode: PermissionMode = 'default'
  for (const candidate of candidates) {
    if (candidate === 'sovereign') {
      if (sovereignDisabled) {
        notification = settingsNotice
        continue
      }
      if (!dangerouslySkipPermissions) {
        notification =
          'Sovereign Mode requires launching with --sovereign because it is a bypass-posture mode.'
        continue
      }
    }
    resolvedMode = candidate
    break
  }

  return notification ? { mode: resolvedMode, notification } : { mode: resolvedMode }
}

export function savedPermissionModeCandidate(): PermissionMode | undefined {
  const { settings, errors } = getSettingsWithErrors()
  const raw = settings.guardrails?.mode
  if (!raw) return errors.some(error => error.path === 'guardrails.mode') ? 'default' : undefined
  const mode = permissionModeFromString(raw)
  return mode
}

export function resolveSavedPermissionMode(): { mode: PermissionMode; notification?: string } | undefined {
  const saved = savedPermissionModeCandidate()
  if (saved === undefined) return undefined
  return resolvePermissionModeCandidates([saved], { dangerouslySkipPermissions: false })
}

export async function initializeToolPermissionContext(args: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  dangerousPermissions: DangerousPermissionInfo[]
  overlyBroadBashPermissions: DangerousPermissionInfo[]
}> {
  const { loadAllPermissionRulesFromDisk } = await import('./permissionsLoader.js')
  const { applyPermissionRulesToPermissionContext } = await import('./permissions.js')

  const allowRules = parseToolListFromCLI(args.allowedToolsCli).map(normalizeRuleString)
  const denyRules = parseToolListFromCLI(args.disallowedToolsCli)

  const bypassAvailable =
    (args.permissionMode === 'sovereign' || args.allowDangerouslySkipPermissions) &&
    !isBypassDisabledBySettingsOrPolicy()

  const diskRules = loadAllPermissionRulesFromDisk()

  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (args.permissionMode === 'flow') {
    dangerousPermissions = findDangerousPermissions(
      diskRules,
      allowRules,
    )
  }

  const warnings: string[] = []
  if (allowRules.includes('LSP')) warnings.push(lspCliNote('--allowed-tools'))
  if (denyRules.includes('LSP')) warnings.push(lspCliNote('--block-tools'))
  for (const rule of diskRules) {
    if (rule.ruleValue.toolName === 'LSP' && rule.ruleValue.ruleContent === undefined) {
      const note = lspPermissionNote(rule.source)
      if (!warnings.includes(note)) warnings.push(note)
    }
  }
  for (const source of getEnabledSettingSources()) {
    const hooks = getSettingsForSource(source)?.events?.hooks
    for (const [event, matchers] of Object.entries(hooks ?? {})) {
      for (const matcher of matchers ?? []) {
        const note = lspHookNote(event, matcher.matcher ?? '', source)
        if (note && !warnings.includes(note)) warnings.push(note)
        for (const hook of matcher.hooks) {
          if ('if' in hook && hook.if === 'LSP') {
            const conditionNote = lspHookNote(event, 'LSP', source)!
            if (!warnings.includes(conditionNote)) warnings.push(conditionNote)
          }
        }
      }
    }
  }

  let context = {
    mode: args.permissionMode,
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
