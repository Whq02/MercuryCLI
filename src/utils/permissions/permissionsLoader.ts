/**
 * Reads permission rules out of settings sources and writes rule
 * additions/removals back. Honours the managed-rules-only policy and the
 * Mercury oversize-allow guard.
 */
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

/** The maximum serialized length of an allow rule that may reach disk. */
export const MAX_PERSISTED_ALLOW_RULE_LENGTH = 256

/** The three behaviours read, in this order. */
const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

/** The three editable settings sources. */
const EDITABLE_SOURCES: EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

function isEditableSource(source: PermissionRuleSource): source is EditableSettingSource {
  return (EDITABLE_SOURCES as string[]).includes(source)
}

/** Whether only managed (policy) rules may be loaded and nothing may persist. */
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  const policy = getSettingsForSource('policySettings') as { allowManagedPermissionRulesOnly?: boolean } | undefined
  return policy?.allowManagedPermissionRulesOnly === true
}

/** Whether the UI should offer "always allow" options (the negation above). */
export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

/** Convert a settings source's permission arrays into tagged rules. */
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

/** Load every enabled source's rules (policy only under managed-rules-only). */
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  const managedOnly = shouldAllowManagedPermissionRulesOnly()
  const sources = managedOnly
    ? (['policySettings'] as PermissionRuleSource[])
    : getEnabledSettingSources()
  return sources.flatMap((source: PermissionRuleSource) => getPermissionRulesForSource(source))
}

/** A rule known to come from an editable source. */
export type PermissionRuleFromEditableSettings = PermissionRule & { source: EditableSettingSource }

/** Lenient raw-JSON read that never validates and swallows every error. */
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

/** The permissions array for a behaviour from a settings object. */
function permissionsArray(settings: SettingsJson, behavior: PermissionBehavior): string[] {
  const permissions = (settings as { permissions?: Record<string, string[] | undefined> }).permissions
  return permissions?.[behavior] ?? []
}

/**
 * Add rules to an editable settings source. Refuses under managed-rules-only,
 * no-ops for an empty list, drops oversized allow rules (keeping them
 * session-only), de-duplicates against normalised existing entries, and
 * preserves unrecognised keys.
 */
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
      // If every rule was dropped, the in-memory grant stands: report success.
      if (kept.length === 0) return true
      serialized = kept
    }

    const existing = loadSettingsLenient(source)
    const currentArray = permissionsArray(existing, ruleBehavior)
    const normalisedExisting = new Set(
      currentArray.map(entry => permissionRuleValueToString(permissionRuleValueFromString(entry))),
    )
    const additions = serialized.filter(rule => !normalisedExisting.has(rule))
    if (additions.length === 0) return true // nothing new

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

/** Delete a rule from an editable settings source (normalised comparison). */
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
  if (filtered.length === array.length) return false // absence returns failure

  const permissions = { ...settings.permissions, [rule.ruleBehavior]: filtered }
  const { error } = updateSettingsForSource(rule.source, { ...settings, permissions } as SettingsJson)
  if (error) {
    logError(error)
    return false
  }
  return true
}

// SETTING_SOURCES is re-exported through the loader's surface for callers that
// enumerate every source.
export { SETTING_SOURCES }
