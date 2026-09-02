import { readFileSync } from 'node:fs'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { safeResolvePath } from '../fsOperations.js'
import { getFsImplementation } from '../fsOperations.js'
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
import { getEnabledSettingSources, SETTING_SOURCES } from '../settings/constants.js'
import type { EditableSettingSource } from '../settings/constants.js'
import type { SettingsJson } from '../settings/types.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'

export const MAX_PERSISTED_ALLOW_RULE_LENGTH = 256

const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

const EDITABLE_SOURCES: EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

function isEditableSource(source: PermissionRuleSource): source is EditableSettingSource {
  return (EDITABLE_SOURCES as string[]).includes(source)
}

export function shouldAllowManagedPermissionRulesOnly(): boolean {
  const policy = getSettingsForSource('policySettings') as { allowManagedPermissionRulesOnly?: boolean } | undefined
  return policy?.allowManagedPermissionRulesOnly === true
}

export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

export function getPermissionRulesForSource(source: PermissionRuleSource): PermissionRule[] {
  const settings = getSettingsForSource(source as never) as
    | { permissions?: Record<string, string[] | undefined> }
    | undefined
  const permissions = settings?.permissions
  if (!permissions) return []
  const rules: PermissionRule[] = []
  for (const behavior of BEHAVIORS) {
    for (const entry of permissions[behavior] ?? []) {
      rules.push({ source, ruleBehavior: behavior, ruleValue: permissionRuleValueFromString(entry) })
    }
  }
  return rules
}

export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  const managedOnly = shouldAllowManagedPermissionRulesOnly()
  const sources = managedOnly
    ? (['policySettings'] as PermissionRuleSource[])
    : getEnabledSettingSources()
  return sources.flatMap((source: PermissionRuleSource) => getPermissionRulesForSource(source))
}

export type PermissionRuleFromEditableSettings = PermissionRule & { source: EditableSettingSource }

function loadSettingsLenient(source: EditableSettingSource): SettingsJson {
  try {
    const path = getSettingsFilePathForSource(source)
    if (!path) return {} as SettingsJson
    const resolved = safeResolvePath(getFsImplementation(), path).resolvedPath
    const text = readFileSync(resolved, 'utf8')
    if (text.trim() === '') return {} as SettingsJson
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed as SettingsJson
    return {} as SettingsJson
  } catch {
    return {} as SettingsJson
  }
}

function permissionsArray(settings: SettingsJson, behavior: PermissionBehavior): string[] {
  const permissions = (settings as { permissions?: Record<string, string[] | undefined> }).permissions
  return permissions?.[behavior] ?? []
}

export function addPermissionRulesToSettings(
  { ruleValues, ruleBehavior }: { ruleValues: PermissionRuleValue[]; ruleBehavior: PermissionBehavior },
  source: EditableSettingSource,
): boolean {
  if (shouldAllowManagedPermissionRulesOnly()) return false
  if (ruleValues.length === 0) return true

  try {
    let serialized = ruleValues.map(permissionRuleValueToString)

    if (ruleBehavior === 'allow') {
      const kept: string[] = []
      const dropped: string[] = []
      for (const rule of serialized) {
        if (rule.length > MAX_PERSISTED_ALLOW_RULE_LENGTH) dropped.push(rule)
        else kept.push(rule)
      }
      if (dropped.length > 0) {
        logForDebugging(
          `dropped ${dropped.length} oversized allow rule(s) from disk (session-only): ${dropped
            .map(rule => `${rule.slice(0, 40)}… (${rule.length} chars)`)
            .join('; ')}`,
        )
      }
      if (kept.length === 0) return true
      serialized = kept
    }

    const existing = loadSettingsLenient(source)
    const currentArray = permissionsArray(existing, ruleBehavior)
    const normalisedExisting = new Set(
      currentArray.map(entry => permissionRuleValueToString(permissionRuleValueFromString(entry))),
    )
    const additions = serialized.filter(rule => !normalisedExisting.has(rule))
    if (additions.length === 0) return true

    const permissions = {
      ...((existing as { permissions?: Record<string, unknown> }).permissions ?? {}),
      [ruleBehavior]: [...currentArray, ...additions],
    }
    const { error } = updateSettingsForSource(source, { ...existing, permissions } as SettingsJson)
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
  const settings = getSettingsForSource(rule.source) as
    | { permissions?: Record<string, string[] | undefined> }
    | undefined
  if (!settings?.permissions) return false
  const array = settings.permissions[rule.ruleBehavior]
  if (!array) return false

  const target = permissionRuleValueToString(rule.ruleValue)
  const filtered = array.filter(
    entry => permissionRuleValueToString(permissionRuleValueFromString(entry)) !== target,
  )
  if (filtered.length === array.length) return false

  const permissions = { ...settings.permissions, [rule.ruleBehavior]: filtered }
  const { error } = updateSettingsForSource(rule.source, { ...settings, permissions } as SettingsJson)
  if (error) {
    logError(error)
    return false
  }
  return true
}

export { SETTING_SOURCES }
