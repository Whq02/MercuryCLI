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
import { entriesOf } from '../entriesOf.js'

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
  road: ModeTransitionRoad = 'permission-answer',
): ToolPermissionContext {
  switch (update.type) {
    case 'addRules': {
      const next = structuredCloneContext(context)
      const mapKey = ruleMapKey(update.behavior)
      const existing = next[mapKey][update.destination] ?? []
      const serialized = update.rules.map(ruleString)
      next[mapKey][update.destination] = [...existing, ...serialized]
      stampReasons(next, update.destination, update.rules)
      logUpdate(update.type, update.destination, update.behavior, serialized)
      return next
    }
    case 'replaceRules': {
      const next = structuredCloneContext(context)
      const mapKey = ruleMapKey(update.behavior)
      const previous = next[mapKey][update.destination] ?? []
      dropReasons(next, update.destination, previous)
      const serialized = update.rules.map(ruleString)
      next[mapKey][update.destination] = serialized
      stampReasons(next, update.destination, update.rules)
      logUpdate(update.type, update.destination, update.behavior, serialized)
      return next
    }
    case 'removeRules': {
      const next = structuredCloneContext(context)
      const mapKey = ruleMapKey(update.behavior)
      const existing = next[mapKey][update.destination] ?? []
      const serialized = update.rules.map(ruleString)
      const toRemove = new Set(serialized)
      next[mapKey][update.destination] = existing.filter(entry => !toRemove.has(entry))
      dropReasons(next, update.destination, toRemove)
      logUpdate(update.type, update.destination, update.behavior, serialized)
      return next
    }
    case 'setMode': {
      const next = structuredCloneContext(context)
      if (context.mode === 'apollo') {
        holdModeTransition({
          from: context.mode,
          to: update.mode,
          road,
          detail: `setMode at the ${update.destination} scope — Apollo Mode leaves only through the review card or the operator's own mode change`,
        })
        return next
      }
      if (context.mode !== update.mode) {
        recordModeTransition({
          from: context.mode,
          to: update.mode,
          road,
          detail: `setMode at the ${update.destination} scope`,
        })
      }
      next.mode = update.mode
      logForDebugging(`permission update setMode → ${update.mode} (${update.destination})`)
      return next
    }
    default:
      return context
  }
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
  road?: ModeTransitionRoad,
): ToolPermissionContext {
  let current = context
  for (const update of updates) {
    current = applyPermissionUpdate(current, update, road)
  }
  return current
}

export type PersistVerdict = { error: Error | null }
const LANDED: PersistVerdict = { error: null }

function rawPermissionArray(base: Record<string, unknown>, key: string): string[] {
  const permissions = base.guardrails
  if (typeof permissions !== 'object' || permissions === null) return []
  const raw = (permissions as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
}

function isEditableDestination(
  destination: PermissionUpdateDestination,
): destination is EditableSettingSource {
  return (
    destination === 'userSettings' ||
    destination === 'projectSettings' ||
    destination === 'localSettings'
  )
}

export function persistPermissionUpdate(update: PermissionUpdate): PersistVerdict {
  if (!isEditableDestination(update.destination)) {
    return LANDED
  }
  switch (update.type) {
    case 'addRules': {
      const serialized = update.rules.map(ruleString)
      if (update.behavior === 'allow') {
        noteAllowRulesGranted(update.destination, serialized)
      }
      const key = settingsBehaviorKey(update.behavior)
      return writePartial(update.destination, rawBase => {
        const existing = rawPermissionArray(rawBase, key)
        const merged = [...existing]
        for (const rule of serialized) {
          if (!merged.includes(rule)) {
            merged.push(rule)
          }
        }
        return guardrailsPatch(key, merged)
      })
    }
    case 'replaceRules': {
      const serialized = update.rules.map(ruleString)
      if (update.behavior === 'allow') {
        noteAllowRulesGranted(update.destination, serialized)
      }
      const key = settingsBehaviorKey(update.behavior)
      return writePartial(update.destination, guardrailsPatch(key, serialized))
    }
    case 'removeRules': {
      const key = settingsBehaviorKey(update.behavior)
      const toRemove = new Set(update.rules.map(ruleString))
      return writePartial(update.destination, rawBase => {
        const existing = rawPermissionArray(rawBase, key)
        const remaining = existing.filter(entry => {
          try {
            const normalized = ruleString(permissionRuleValueFromString(entry))
            return !toRemove.has(normalized)
          } catch (error) {
            passedOver(error)
            return true
          }
        })
        return guardrailsPatch(key, remaining)
      })
    }
    case 'setMode': {
      return writePartial(update.destination, { guardrails: { mode: update.mode } })
    }
    default:
      return LANDED
  }
}

export function persistPermissionUpdates(updates: PermissionUpdate[]): PersistVerdict {
  let firstError: Error | null = null
  for (const update of updates) {
    const verdict = persistPermissionUpdate(update)
    if (firstError === null && verdict.error !== null) {
      firstError = verdict.error
    }
  }
  return firstError === null ? LANDED : { error: firstError }
}

function directoryRulePattern(dirPath: string): string | undefined {
  const normalized = dirPath.replace(/\\/g, '/')
  if (normalized === '/') return undefined
  const driveMatch = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
  if (driveMatch) {
    const rest = driveMatch[2]!.replace(/\/+$/, '')
    if (rest === '') return undefined
    return `//${driveMatch[1]!.toUpperCase()}/${rest}/**`
  }
  const prefixed = normalized.startsWith('/') ? `/${normalized}` : normalized
  return `${prefixed}/**`
}

export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  const pattern = directoryRulePattern(dirPath)
  if (pattern === undefined) return undefined
  return {
    type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: pattern }],
    behavior: 'allow',
    destination,
  }
}

export function createEditRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  const pattern = directoryRulePattern(dirPath)
  if (pattern === undefined) return undefined
  return {
    type: 'addRules',
    rules: [{ toolName: 'Edit', ruleContent: pattern }],
    behavior: 'allow',
    destination,
  }
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
  const held: ToolPermissionContext['alwaysAllowRules'] = map ?? {}
  for (const [key, value] of entriesOf(held)) out[key] = [...value]
  return out
}

function cloneReasonMap(map: NonNullable<ToolPermissionContext['ruleReasons']>): MutableRuleReasonsBySource {
  const out: MutableRuleReasonsBySource = {}
  for (const [key, value] of entriesOf(map)) out[key] = { ...value }
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
