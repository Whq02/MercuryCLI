import { readFileSync } from 'node:fs'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, isENOENT } from '../errors.js'
import { stripBOM } from '../jsonRead.js'
import { safeResolvePath } from '../fsOperations.js'
import { getFsImplementation } from '../fsOperations.js'
import { isOneOf } from '../isOneOf.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from '../../types/permissions.js'
import {
  getSettingsForSource,
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { getLaunchSettingSources, isCheckoutSourceHeldForTrust, SETTING_SOURCES } from '../settings/constants.js'
import type { EditableSettingSource, SettingSource } from '../settings/constants.js'
import type { SettingsJson } from '../settings/types.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import { normaliseRuleReasons, ruleSpelling } from './ruleReason.js'

export const MAX_PERSISTED_ALLOW_RULE_LENGTH = 256

const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

const EDITABLE_SOURCES: EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

function isEditableSource(source: PermissionRuleSource): source is EditableSettingSource {
  return isOneOf(EDITABLE_SOURCES, source)
}

export function shouldAllowManagedPermissionRulesOnly(): boolean {
  const settings = getSettingsForSource('policySettings')
  return settings?.guardrails?.managedOnly === true
}

export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

function getPermissionRulesForSource(source: SettingSource): PermissionRule[] {
  const settings = getSettingsForSource(source)
  const guardrails = settings?.guardrails
  if (!guardrails) return []
  const held = isCheckoutSourceHeldForTrust(source)
  const reasons = held ? {} : normaliseRuleReasons(guardrails.reasons)
  const rules: PermissionRule[] = []
  for (const behavior of BEHAVIORS) {
    if (held && behavior === 'allow') continue
    const entries = guardrails[behavior]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const parsed = permissionRuleValueFromString(entry)
      const spelling = ruleSpelling(parsed)
      const reason = Object.hasOwn(reasons, spelling) ? reasons[spelling] : undefined
      rules.push({
        source,
        ruleBehavior: behavior,
        ruleValue: reason !== undefined ? { ...parsed, reason } : parsed,
      })
    }
  }
  return rules
}

export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  const managedOnly = shouldAllowManagedPermissionRulesOnly()
  const sources: SettingSource[] = managedOnly
    ? ['policySettings']
    : getLaunchSettingSources()
  return sources.flatMap(source => getPermissionRulesForSource(source))
}

export type PermissionRuleFromEditableSettings = PermissionRule & { source: EditableSettingSource }

function loadSettingsLenient(source: EditableSettingSource): SettingsJson {
  let path: string | undefined
  try {
    path = getSettingsFilePathForSource(source)
    if (!path) return {} as SettingsJson
    const resolved = safeResolvePath(getFsImplementation(), path).resolvedPath
    const text = stripBOM(readFileSync(resolved, 'utf8'))
    if (text.trim() === '') return {} as SettingsJson
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed as SettingsJson
    return {} as SettingsJson
  } catch (error) {
    if (!isENOENT(error)) {
      logError(new Error(`the settings file ${path ?? source} could not be read before a permission rule was added to it: ${error instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(error)}`))
    }
    return {} as SettingsJson
  }
}

function guardrailsArray(settings: SettingsJson, behavior: PermissionBehavior): string[] {
  const guardrails = (settings as { guardrails?: Record<string, string[] | undefined> }).guardrails
  return guardrails?.[behavior] ?? []
}

export function addPermissionRulesToSettings(
  { ruleValues, ruleBehavior }: { ruleValues: PermissionRuleValue[]; ruleBehavior: PermissionBehavior },
  source: EditableSettingSource,
): boolean {
  if (shouldAllowManagedPermissionRulesOnly()) return false
  if (ruleValues.length === 0) return true
  const rawStrings = ruleValues.map(permissionRuleValueToString)
  let strings = rawStrings
  if (ruleBehavior === 'allow') {
    const kept: string[] = []
    const dropped: string[] = []
    for (const entry of rawStrings) {
      if (entry.length > MAX_PERSISTED_ALLOW_RULE_LENGTH) {
        dropped.push(entry)
      } else {
        kept.push(entry)
      }
    }
    if (dropped.length > 0) {
      const snippets = dropped.map(entry => `${entry.slice(0, 40)}… (${entry.length} chars)`).join('; ')
      logForDebugging(`dropped ${dropped.length} oversized allow rule(s) from disk (session-only): ${snippets}`)
    }
    if (kept.length === 0) return true
    strings = kept
  }
  try {
    const currentSettings = loadSettingsLenient(source)
    const existing = guardrailsArray(currentSettings, ruleBehavior)
    const existingNormalized = new Set(existing.map(entry => ruleSpelling(permissionRuleValueFromString(entry))))
    const newRules = strings.filter(entry => !existingNormalized.has(ruleSpelling(permissionRuleValueFromString(entry))))
    if (newRules.length === 0) return true
    const currentGuardrails =
      typeof currentSettings.guardrails === 'object' && currentSettings.guardrails !== null
        ? currentSettings.guardrails
        : {}
    const { error } = updateSettingsForSource(source, {
      ...currentSettings,
      guardrails: {
        ...currentGuardrails,
        [ruleBehavior]: [...existing, ...newRules],
      },
    })
    if (error) {
      logError(error)
      return false
    }
    return true
  } catch (error) {
    logError(error)
    return false
  }
}

export function deletePermissionRuleFromSettings(rule: PermissionRuleFromEditableSettings): boolean {
  if (!isEditableSource(rule.source)) return false
  const settings = getSettingsForSource(rule.source)
  const guardrails = settings?.guardrails
  if (!guardrails) return false
  const existing = guardrails[rule.ruleBehavior]
  if (!Array.isArray(existing)) return false
  const target = ruleSpelling(permissionRuleValueFromString(ruleSpelling(rule.ruleValue)))
  const updated = existing.filter(entry => ruleSpelling(permissionRuleValueFromString(entry)) !== target)
  if (updated.length === existing.length) return false
  const { error } = updateSettingsForSource(rule.source, {
    ...settings,
    guardrails: {
      ...guardrails,
      [rule.ruleBehavior]: updated,
    },
  })
  if (error) {
    logError(error)
    return false
  }
  return true
}

export { SETTING_SOURCES }
