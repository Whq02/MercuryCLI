
import { getEnabledSettingSources, type SettingSource } from './constants.js'
import { getSettingsForSource, getSettingsWithErrors } from './settings.js'
import { getSessionSettingsCache } from './settingsCache.js'
import type { SettingsJson } from './types.js'
import type { ValidationError } from './validation.js'

export type ProvenanceSource = SettingSource

export interface KeyProvenance {
  winner: ProvenanceSource
  contributors: ProvenanceSource[]
  merged: boolean
}

export interface SettingsSnapshot {
  settings: Readonly<SettingsJson>
  errors: readonly ValidationError[]
  revision: number
  provenance: Readonly<Record<string, KeyProvenance>>
}

let lastSnapshot: SettingsSnapshot | null = null
let lastSettingsFingerprint: string | null = null
let revisionCounter = 0

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const NESTED_PROVENANCE_KEYS = new Set(['permissions', 'env'])

function collectPaths(settings: SettingsJson): string[] {
  const paths: string[] = []
  for (const key of Object.keys(settings)) {
    const value = (settings as Record<string, unknown>)[key]
    if (NESTED_PROVENANCE_KEYS.has(key) && isPlainObject(value)) {
      for (const nested of Object.keys(value)) {
        paths.push(`${key}.${nested}`)
      }
    } else {
      paths.push(key)
    }
  }
  return paths
}

function valueAtPath(settings: SettingsJson | null, path: string): unknown {
  if (!settings) return undefined
  const [head, tail] = path.split('.', 2) as [string, string | undefined]
  const top = (settings as Record<string, unknown>)[head]
  if (tail === undefined) return top
  return isPlainObject(top) ? top[tail] : undefined
}

function computeProvenance(
  effective: SettingsJson,
  perSource: Array<{ source: SettingSource; settings: SettingsJson }>,
): Record<string, KeyProvenance> {
  const provenance: Record<string, KeyProvenance> = {}
  for (const path of collectPaths(effective)) {
    const contributors: SettingSource[] = []
    for (const { source, settings } of perSource) {
      if (valueAtPath(settings, path) !== undefined) contributors.push(source)
    }
    if (contributors.length === 0) continue
    const winner = contributors[contributors.length - 1]!
    const effectiveValue = valueAtPath(effective, path)
    const merged =
      contributors.length > 1 &&
      (Array.isArray(effectiveValue) || isPlainObject(effectiveValue))
    provenance[path] = { winner, contributors, merged }
  }
  return provenance
}

export function getSettingsSnapshot(): SettingsSnapshot {
  if (lastSnapshot !== null && getSessionSettingsCache() !== null) {
    return lastSnapshot
  }

  const { settings, errors } = getSettingsWithErrors()
  const perSource: Array<{ source: SettingSource; settings: SettingsJson }> = []
  for (const source of getEnabledSettingSources()) {
    const sourceSettings = getSettingsForSource(source)
    if (sourceSettings && Object.keys(sourceSettings).length > 0) {
      perSource.push({ source, settings: sourceSettings })
    }
  }

  const fingerprint = JSON.stringify(settings)
  if (fingerprint !== lastSettingsFingerprint) {
    revisionCounter++
    lastSettingsFingerprint = fingerprint
  }

  lastSnapshot = deepFreeze({
    settings: structuredClone(settings),
    errors: structuredClone(errors),
    revision: revisionCounter,
    provenance: computeProvenance(settings, perSource),
  }) as SettingsSnapshot
  return lastSnapshot
}

export function settingsRevision(): number {
  return getSettingsSnapshot().revision
}

export function _resetSettingsSnapshotForTesting(): void {
  lastSnapshot = null
  lastSettingsFingerprint = null
  revisionCounter = 0
}
