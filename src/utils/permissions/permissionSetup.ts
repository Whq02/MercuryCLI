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
import { notBuilt, unbuilt } from '../../pi/holes.js'


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

const POWERSHELL_DANGEROUS_NAMES: string[] = unbuilt('src/utils/permissions/permissionSetup.ts:63')

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
  return notBuilt('src/utils/permissions/permissionSetup.ts:122')
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
  return notBuilt('src/utils/permissions/permissionSetup.ts:218')
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
  return notBuilt('src/utils/permissions/permissionSetup.ts:267')
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
    next = { ...(next as object), mode: 'default' } as ToolPermissionContext
  }
  return { ...(next as object), isBypassPermissionsModeAvailable: false } as ToolPermissionContext
}


export function parseToolListFromCLI(tools: string[]): string[] {
  return notBuilt('src/utils/permissions/permissionSetup.ts:335')
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
  return notBuilt('src/utils/permissions/permissionSetup.ts:482')
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
