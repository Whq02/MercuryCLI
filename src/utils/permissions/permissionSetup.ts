import type { ToolPermissionContext } from '../../Tool.js'
import { lspPermissionNote, lspCliNote, lspHookNote } from '../lsp/toolFamily.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { POWERSHELL_TOOL_NAME } from '../../constants/tools/powershell.js'
import { setSessionPermissionModeResolution } from '../../bootstrap/state.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { holdModeTransition, recordModeTransition, type ModeTransitionRoad } from './modeTransitions.js'
import { forgetLateAllowRules } from './lateAllowRules.js'
import {
  getInitialSettings,
  getSettingsWithErrors,
  getSettingsForSource,
} from '../settings/settings.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import { DANGEROUS_BASH_PATTERNS, CROSS_PLATFORM_CODE_EXEC, PROGRAM_WRAPPERS } from './dangerousPatterns.js'
import { modeBypassesPermissions, permissionModeTitle, permissionModeFromString } from './PermissionMode.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  ToolPermissionRulesBySource,
} from '../../types/permissions.js'
import { applyPermissionRulesToPermissionContext } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'


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
  return contentMatchesDangerousPattern(ruleContent, DANGEROUS_BASH_PATTERNS) || runsAnotherProgram(ruleContent)
}

const PROGRAM_STARTING_TOOLS: ReadonlySet<string> = new Set(['Monitor', 'Service', 'Journey', 'Debug', 'Eval', 'Launch', 'Test'])

function runsAnotherProgram(ruleContent: string | undefined): boolean {
  const content = (ruleContent ?? '').trim().toLowerCase()
  return PROGRAM_WRAPPERS.some(wrapper => content === wrapper || content === `${wrapper}*` || (content.startsWith(`${wrapper} `) && content.endsWith('*')))
}

function startsProgramsUnread(toolName: string, ruleContent?: string): boolean {
  if (!PROGRAM_STARTING_TOOLS.has(toolName)) return false
  if (ruleContent === undefined || ruleContent.trim() === '' || ruleContent.trim() === '*') return true
  return toolName === 'Monitor' && isDangerousBashPermission(BASH_TOOL_NAME, ruleContent)
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

function isDangerousRule(toolName: string, ruleContent?: string): boolean {
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent) ||
    startsProgramsUnread(toolName, ruleContent)
  )
}

export function findDangerousPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []
  for (const rule of rules) {
    if (rule.ruleBehavior !== 'allow') continue
    if (!isDangerousRule(rule.ruleValue.toolName, rule.ruleValue.ruleContent)) continue
    dangerous.push({
      ruleValue: rule.ruleValue,
      source: rule.source,
      ruleDisplay: ruleDisplay(rule.ruleValue),
      sourceDisplay: sourceDisplay(rule.source),
    })
  }
  for (const spec of cliAllowedTools) {
    const match = CLI_SPEC_RE.exec(spec.trim())
    if (!match) continue
    const toolName = match[1]!.trim()
    if (toolName === '') continue
    const rawContent = match[2]?.trim()
    const ruleContent = rawContent !== undefined && rawContent !== '' ? rawContent : undefined
    if (!isDangerousRule(toolName, ruleContent)) continue
    const ruleValue: PermissionRuleValue =
      ruleContent === undefined ? { toolName } : { toolName, ruleContent }
    dangerous.push({
      ruleValue,
      source: 'cliArg',
      ruleDisplay: ruleDisplay(ruleValue),
      sourceDisplay: '--allowed-tools',
    })
  }
  return dangerous
}


type ReadonlyRuleMap = ToolPermissionContext['alwaysAllowRules']

type ClonedContext = Omit<ToolPermissionContext, 'alwaysAllowRules' | 'strippedDangerousRules'> & {
  alwaysAllowRules: ToolPermissionRulesBySource
  strippedDangerousRules?: ToolPermissionRulesBySource
}

const VALID_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session'])

export function stripDangerousPermissionsForFlow(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const allowRules = getAllowRulesFromContext(context)
  const dangerous = findDangerousPermissions(allowRules, [])
  const next = cloneContext(context)

  if (dangerous.length === 0) {
    if (!next.strippedDangerousRules) next.strippedDangerousRules = {}
    return next
  }

  const stash: ToolPermissionRulesBySource = { ...(next.strippedDangerousRules ?? {}) }
  for (const perm of dangerous) {
    if (!VALID_DESTINATIONS.has(perm.source)) continue
    logForDebugging(
      `flow: setting aside ${perm.ruleDisplay} from ${perm.sourceDisplay} (a dangerous allow rule never applies in flow)`,
    )
    const serialized = permissionRuleValueToString(perm.ruleValue)
    const arr = next.alwaysAllowRules[perm.source] ?? []
    next.alwaysAllowRules[perm.source] = arr.filter(
      entry => permissionRuleValueToString(permissionRuleValueFromString(entry)) !== serialized,
    )
    stash[perm.source] = [...new Set([...(stash[perm.source] ?? []), serialized])]
  }
  next.strippedDangerousRules = stash
  return next
}

export function restoreDangerousPermissions(context: ToolPermissionContext): ToolPermissionContext {
  if (!context.strippedDangerousRules) return context
  const next = cloneContext(context)
  for (const [source, rules] of Object.entries(context.strippedDangerousRules)) {
    if (!rules || rules.length === 0) continue
    const key = source as PermissionRuleSource
    next.alwaysAllowRules[key] = [...(next.alwaysAllowRules[key] ?? []), ...rules]
  }
  next.strippedDangerousRules = {}
  return next
}


export function transitionPermissionMode(
  fromMode: PermissionMode,
  toMode: PermissionMode,
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (fromMode === toMode) return context
  if (toMode === 'flow') {
    if (!isFlowGateEnabled()) throw new Error('Flow is not available.')
    return stripDangerousPermissionsForFlow(context)
  }
  if (fromMode === 'flow') {
    return restoreDangerousPermissions(context)
  }
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
    return { ...transitioned, mode }
  })
  return { ok: true, mode }
}

export function validateModeEntry(mode: PermissionMode, context: ToolPermissionContext): SetPermissionModeResult {
  if (mode === 'sovereign') {
    if (isBypassDisabledBySettingsOrPolicy()) {
      return { ok: false, error: 'Sovereign Mode is disabled by settings or organisation policy.' }
    }
    if (context.isBypassPermissionsModeAvailable !== true) {
      return { ok: false, error: 'Sovereign Mode requires launching with --sovereign.' }
    }
  }
  if (mode === 'flow' && !isFlowGateEnabled()) {
    const reason = getFlowUnavailableReason()
    const error =
      reason !== null
        ? `Flow is not available. ${getFlowUnavailableNotification(reason)}`
        : 'Flow is not available.'
    return { ok: false, error }
  }
  return { ok: true, mode }
}


function isFlowDisabledBySettings(): boolean {
  return getInitialSettings().guardrails?.disableFlowMode === true
}

export function isFlowGateEnabled(): boolean {
  return !isFlowDisabledBySettings()
}

export type FlowUnavailableReason = 'settings'

export function getFlowUnavailableReason(): FlowUnavailableReason | null {
  if (isFlowDisabledBySettings()) return 'settings'
  return null
}

export function getFlowUnavailableNotification(reason: FlowUnavailableReason): string {
  switch (reason) {
    case 'settings':
      return 'Flow is closed by your settings.'
  }
}


function isBypassDisabledBySettingsOrPolicy(): boolean {
  return getInitialSettings().guardrails?.disableSovereignMode === true
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
    next = { ...next, mode: 'default' }
  }
  return { ...next, isBypassPermissionsModeAvailable: false }
}


export function parseToolListFromCLI(tools: string[]): string[] {
  const joined = tools.join(',')
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (ch === ',' || ch === ' ')) {
      const piece = joined.slice(start, i).trim()
      if (piece !== '') out.push(piece)
      start = i + 1
    }
  }
  const tail = joined.slice(start).trim()
  if (tail !== '') out.push(tail)
  return out
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
  const typedPosture = requested !== undefined && !modeBypassesPermissions(requested)
  const candidates: Array<{ mode: PermissionMode; source: SessionPermissionModeSource }> = []

  if (dangerouslySkipPermissions && !typedPosture) {
    candidates.push({ mode: 'sovereign', source: envBypassArmed === true ? 'session-birth' : 'launch-flag' })
  }
  if (requested) candidates.push({ mode: requested, source: 'mode-argument' })
  const settingsMode = savedPermissionModeCandidate()
  if (settingsMode) candidates.push({ mode: settingsMode, source: 'saved-settings' })

  const ordered: PermissionMode[] = candidates.map(c => c.mode)
  const result = resolvePermissionModeCandidates(ordered, { dangerouslySkipPermissions: dangerouslySkipPermissions && !typedPosture })
  const winner = candidates.find(c => c.mode === result.mode) ?? { mode: result.mode, source: 'default' as SessionPermissionModeSource }
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
  const allowedTools = parseToolListFromCLI(args.allowedToolsCli).map(normalizeRuleString)
  const disallowedTools = parseToolListFromCLI(args.disallowedToolsCli)
  const baseTools = args.baseToolsCli !== undefined ? parseToolListFromCLI(args.baseToolsCli) : undefined
  const diskRules = loadAllPermissionRulesFromDisk()
  const isBypassPermissionsModeAvailable =
    (modeBypassesPermissions(args.permissionMode) || args.allowDangerouslySkipPermissions) &&
    !isBypassDisabledBySettingsOrPolicy()
  const isFlowAvailable = isFlowGateEnabled()
  const dangerousPermissions =
    args.permissionMode === 'flow' ? findDangerousPermissions(diskRules, allowedTools) : []

  const warnings: string[] = []
  const seenWarnings = new Set<string>()
  const addWarning = (note: string | undefined): void => {
    if (note !== undefined && note !== '' && !seenWarnings.has(note)) {
      seenWarnings.add(note)
      warnings.push(note)
    }
  }
  if (allowedTools.includes('LSP')) addWarning(lspCliNote('--allowed-tools'))
  if (disallowedTools.includes('LSP')) addWarning(lspCliNote('--block-tools'))
  for (const rule of diskRules) {
    if (rule.ruleValue.toolName === 'LSP' && rule.ruleValue.ruleContent === undefined) {
      addWarning(lspPermissionNote(rule.source))
    }
  }
  for (const source of getEnabledSettingSources()) {
    const hooks = getSettingsForSource(source)?.events?.hooks
    if (!hooks) continue
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        addWarning(lspHookNote(event, entry.match ?? '', source))
      }
    }
  }

  const initialContext: ToolPermissionContext = {
    mode: args.permissionMode,
    ...(baseTools !== undefined ? { baseTools } : {}),
    alwaysAllowRules: { cliArg: allowedTools },
    alwaysDenyRules: { cliArg: disallowedTools },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable,
    isFlowAvailable,
  }
  const toolPermissionContext = applyPermissionRulesToPermissionContext(initialContext, diskRules)
  forgetLateAllowRules()
  recordModeTransition({ from: null, to: args.permissionMode, road: 'boot' })

  return {
    toolPermissionContext,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions: [],
  }
}

function normalizeRuleString(rule: string): string {
  const value = permissionRuleValueFromString(rule)
  return value.ruleContent ? `${value.toolName}(${value.ruleContent})` : value.toolName
}


function cloneContext(context: ToolPermissionContext): ClonedContext {
  return {
    ...context,
    alwaysAllowRules: cloneMap(context.alwaysAllowRules),
    strippedDangerousRules: context.strippedDangerousRules ? cloneMap(context.strippedDangerousRules) : undefined,
  }
}

function cloneMap(map?: ReadonlyRuleMap): ToolPermissionRulesBySource {
  const out: ToolPermissionRulesBySource = {}
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value !== undefined) out[key as PermissionRuleSource] = [...value]
  }
  return out
}

function getAllowRulesFromContext(context: ToolPermissionContext): PermissionRule[] {
  const bySource = context.alwaysAllowRules ?? {}
  const rules: PermissionRule[] = []
  for (const [source, entries] of Object.entries(bySource)) {
    for (const entry of entries ?? []) {
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(entry),
      })
    }
  }
  return rules
}
