import { resolve } from 'node:path'

import type { EditableSettingSource } from './constants.js'
import { getSettingsFilePathForSource, updateSettingsForSource } from './settings.js'
import type { SettingsJson } from './types.js'
import type { ValidationError } from './validation.js'

const EDITABLE_SOURCES: readonly EditableSettingSource[] = ['userSettings', 'projectSettings', 'localSettings']

export type UnknownKeyRemoval = { source: EditableSettingSource; file: string; keys: string[] }

function isObjectPath(path: string): boolean {
  return path === '' || path.split('.').every(segment => segment !== '' && !/^\d+$/.test(segment))
}

function fieldPaths(error: ValidationError): string[] {
  if (!isObjectPath(error.path)) return []
  return (error.unknownKeys ?? []).map(key => (error.path === '' ? key : `${error.path}.${key}`))
}

export function removableUnknownKeys(errors: ValidationError[]): UnknownKeyRemoval[] {
  const removals: UnknownKeyRemoval[] = []
  for (const source of EDITABLE_SOURCES) {
    const file = getSettingsFilePathForSource(source)
    if (file === undefined) continue
    const target = resolve(file)
    const inFile = errors.filter(error => error.file !== undefined && resolve(error.file) === target)
    if (inFile.length === 0 || inFile.some(error => error.severity !== 'warning')) continue
    const keys = [...new Set(inFile.flatMap(fieldPaths))]
    if (keys.length > 0) removals.push({ source, file, keys })
  }
  return removals
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deletionsFromFile(rawBase: Record<string, unknown>, keys: string[]): Partial<SettingsJson> {
  const partial: Record<string, unknown> = {}
  for (const key of keys) {
    const segments = key.split('.')
    const leaf = segments.pop() as string
    let holder: unknown = rawBase
    for (const segment of segments) holder = isPlainObject(holder) ? holder[segment] : undefined
    if (!isPlainObject(holder) || !(leaf in holder)) continue
    let cursor = partial
    for (const segment of segments) {
      const next = cursor[segment]
      if (isPlainObject(next)) {
        cursor = next
      } else {
        const fresh: Record<string, unknown> = {}
        cursor[segment] = fresh
        cursor = fresh
      }
    }
    cursor[leaf] = undefined
  }
  return partial as Partial<SettingsJson>
}

export function removeUnknownKeys(removals: UnknownKeyRemoval[]): Error | null {
  for (const removal of removals) {
    const { error } = updateSettingsForSource(removal.source, rawBase => deletionsFromFile(rawBase, removal.keys))
    if (error !== null) return error
  }
  return null
}
