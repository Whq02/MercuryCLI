import { isDeepStrictEqual } from 'node:util'
import { isRecord as configObject } from '../../../platform/primitives/isRecord.js'

type ConfigUndoSource = 'global' | 'localSettings' | 'userSettings' | 'app'
export type ConfigUndo = { source: ConfigUndoSource; path: string[]; previous: unknown }

export function configUndoLeaves(source: ConfigUndoSource, before: unknown, after: unknown, path: string[] = [], partial = false): ConfigUndo[] {
  if (isDeepStrictEqual(before, after)) return []
  if ((configObject(before) || before === undefined) && (configObject(after) || after === undefined)) {
    const old = before ?? {}
    const next = after ?? {}
    const keys = partial && after !== undefined ? Object.keys(next) : new Set([...Object.keys(old), ...Object.keys(next)])
    return [...keys].flatMap(key => configUndoLeaves(source, old[key], next[key], [...path, key], partial))
  }
  return [{ source, path, previous: structuredClone(before) }]
}

export function restoreConfigLeaf(current: Record<string, unknown>, path: string[], previous: unknown): Record<string, unknown> {
  const [key, ...tail] = path
  if (key === undefined) return current
  const restored = { ...current }
  const value = tail.length === 0 ? previous : restoreConfigLeaf(configObject(current[key]) ? current[key] : {}, tail, previous)
  if (value === undefined || (tail.length > 0 && configObject(value) && Object.keys(value).length === 0)) delete restored[key]
  else Object.defineProperty(restored, key, { value, enumerable: true, configurable: true, writable: true })
  return restored
}
