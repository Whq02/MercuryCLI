import { readFileSync } from 'node:fs'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, isENOENT } from '../errors.js'
import { stripBOM } from '../jsonRead.js'
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
import { getLaunchSettingSources, isCheckoutSourceHeldForTrust, SETTING_SOURCES } from '../settings/constants.js'
import type { EditableSettingSource, SettingSource } from '../settings/constants.js'
import type { SettingsJson } from '../settings/types.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'
import { normaliseRuleReasons, ruleSpelling } from './ruleReason.js'
import { notBuilt } from '../../pi/holes.js'

export const MAX_PERSISTED_ALLOW_RULE_LENGTH = 256

const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

const EDITABLE_SOURCES: EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

function isEditableSource(source: PermissionRuleSource): source is EditableSettingSource {
  return (EDITABLE_SOURCES as string[]).includes(source)
}

export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return notBuilt('src/utils/permissions/permissionsLoader.ts:35')
}

export function shouldShowAlwaysAllowOptions(): boolean {
  return notBuilt('src/utils/permissions/permissionsLoader.ts:39')
}

function getPermissionRulesForSource(source: SettingSource): PermissionRule[] {
  return notBuilt('src/utils/permissions/permissionsLoader.ts:43')
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
  arg0: { ruleValues: PermissionRuleValue[]; ruleBehavior: PermissionBehavior },
  source: EditableSettingSource,
): boolean {
  return notBuilt('src/utils/permissions/permissionsLoader.ts:95')
}

export function deletePermissionRuleFromSettings(rule: PermissionRuleFromEditableSettings): boolean {
  return notBuilt('src/utils/permissions/permissionsLoader.ts:147')
}

export { SETTING_SOURCES }
