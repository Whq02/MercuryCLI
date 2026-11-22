import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type {
  PermissionBehavior,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../types/permissions.js'
import { updateSettingsForSource, type SettingsPatch } from '../settings/settings.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import { holdModeTransition, type ModeTransitionRoad, recordModeTransition } from './modeTransitions.js'
import { noteAllowRulesGranted } from './lateAllowRules.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'

function ruleMapKey(behavior: PermissionBehavior): 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules' {
  if (behavior === 'allow') return 'alwaysAllowRules'
  if (behavior === 'deny') return 'alwaysDenyRules'
  return 'alwaysAskRules'
}

function settingsBehaviorKey(behavior: PermissionBehavior): 'allow' | 'deny' | 'ask' {
  if (behavior === 'allow') return 'allow'
  if (behavior === 'deny') return 'deny'
  return 'ask'
}

type MutableRulesBySource = {
  [K in PermissionRuleSource]?: string[]
}

type MutableRuleReasonsBySource = {
  [K in PermissionRuleSource]?: Record<string, string>
}

type MutableContext = Omit<
  ToolPermissionContext,
  'mode' | 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules' | 'ruleReasons'
> & {
  alwaysAllowRules: MutableRulesBySource
  alwaysDenyRules: MutableRulesBySource
  alwaysAskRules: MutableRulesBySource
  ruleReasons?: MutableRuleReasonsBySource
  mode: ToolPermissionContext['mode']
}

function ruleString(value: PermissionRuleValue): string {
  return permissionRuleValueToString(value)
}

function stampReasons(next: MutableContext, destination: PermissionUpdateDestination, rules: PermissionRuleValue[]): void {
  for (const rule of rules) {
    if (rule.reason === undefined) continue
    const reasons = next.ruleReasons ?? (next.ruleReasons = {})
    const forSource = reasons[destination] ?? (reasons[destination] = {})
    forSource[ruleString(rule)] = rule.reason
  }
}

function dropReasons(next: MutableContext, destination: PermissionUpdateDestination, spellings: Iterable<string>): void {
  const forSource = next.ruleReasons?.[destination]
  if (forSource === undefined) return
  for (const spelling of spellings) delete forSource[spelling]
  if (Object.keys(forSource).length === 0) delete next.ruleReasons![destination]
  if (Object.keys(next.ruleReasons!).length === 0) delete next.ruleReasons
}

export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
  road?: ModeTransitionRoad,
): ToolPermissionContext {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:79')
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
  road?: ModeTransitionRoad,
): ToolPermissionContext {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:133')
}

export type PersistVerdict = { error: Error | null }
const LANDED: PersistVerdict = { error: null }

function rawPermissionArray(base: Record<string, unknown>, key: string): string[] {
  const permissions = base.guardrails
  if (typeof permissions !== 'object' || permissions === null) return []
  const raw = (permissions as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
}

export function persistPermissionUpdate(update: PermissionUpdate): PersistVerdict {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:151')
}

export function persistPermissionUpdates(updates: PermissionUpdate[]): PersistVerdict {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:194')
}

export function createReadRuleSuggestion(
  dirPath: string,
  destination?: PermissionUpdateDestination,
): PermissionUpdate | undefined {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:203')
}

export function createEditRuleSuggestion(
  dirPath: string,
  destination?: PermissionUpdateDestination,
): PermissionUpdate | undefined {
  return notBuilt('src/utils/permissions/PermissionUpdate.ts:227')
}


function guardrailsPatch(behaviorKey: 'allow' | 'deny' | 'ask', rules: string[]): SettingsPatch {
  const guardrails: Partial<Record<'allow' | 'deny' | 'ask', string[]>> = {}
  guardrails[behaviorKey] = rules
  return { guardrails }
}

function structuredCloneContext(context: ToolPermissionContext): MutableContext {
  return {
    ...context,
    alwaysAllowRules: cloneRuleMap(context.alwaysAllowRules),
    alwaysDenyRules: cloneRuleMap(context.alwaysDenyRules),
    alwaysAskRules: cloneRuleMap(context.alwaysAskRules),
    ...(context.ruleReasons === undefined ? {} : { ruleReasons: cloneReasonMap(context.ruleReasons) }),
    mode: context.mode,
  }
}

function cloneRuleMap(map: ToolPermissionContext['alwaysAllowRules'] | undefined): MutableRulesBySource {
  const out: MutableRulesBySource = {}
  for (const [key, value] of Object.entries(map ?? {}) as Array<[PermissionRuleSource, readonly string[]]>) out[key] = [...value]
  return out
}

function cloneReasonMap(map: NonNullable<ToolPermissionContext['ruleReasons']>): MutableRuleReasonsBySource {
  const out: MutableRuleReasonsBySource = {}
  for (const [key, value] of Object.entries(map) as Array<[PermissionRuleSource, Readonly<Record<string, string>>]>) out[key] = { ...value }
  return out
}

function writePartial(
  source: EditableSettingSource,
  partial: SettingsPatch | ((rawBase: Record<string, unknown>) => SettingsPatch),
): PersistVerdict {
  const verdict = updateSettingsForSource(source, partial)
  if (verdict.error !== null) {
    logForDebugging(
      `permission update not saved to ${source}: ${verdict.error.message} — it applies for this session only`,
      { level: 'error' },
    )
  }
  return verdict
}

function logUpdate(
  type: string,
  destination: string,
  behavior: string,
  rules: string[],
): void {
  logForDebugging(
    `permission update ${type} · ${destination} · ${behavior} · ${rules.length} rule(s): ${rules.join(', ')}`,
  )
}
