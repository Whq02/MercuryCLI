import { resolve } from 'node:path'

import type { EditableSettingSource } from './constants.js'
import { getSettingsFilePathForSource, updateSettingsForSource } from './settings.js'
import type { SettingsJson } from './types.js'
import type { ValidationError } from './validation.js'

const EDITABLE_SOURCES: readonly EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

export type UnknownKeyRemoval = { source: EditableSettingSource; file: string; keys: string[] }

export function removableUnknownKeys(errors: ValidationError[]): UnknownKeyRemoval[] {
  const removals: UnknownKeyRemoval[] = []
  for (const source of EDITABLE_SOURCES) {
    const file = getSettingsFilePathForSource(source)
    if (file === undefined) continue
    const target = resolve(file)
    const inFile = errors.filter(error => error.file !== undefined && resolve(error.file) === target)
    if (inFile.length === 0 || inFile.some(error => error.severity !== 'warning')) continue
    const keys = [...new Set(inFile.flatMap(error => (error.path === '' ? error.unknownKeys ?? [] : [])))]
    if (keys.length > 0) removals.push({ source, file, keys })
  }
  return removals
}

export function removeUnknownKeys(removals: UnknownKeyRemoval[]): Error | null {
  for (const removal of removals) {
    const deletions = Object.fromEntries(removal.keys.map(key => [key, undefined])) as Partial<SettingsJson>
    const { error } = updateSettingsForSource(removal.source, deletions)
    if (error !== null) return error
  }
  return null
}
