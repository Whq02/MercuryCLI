// ============================================================================
//  settings/snapshot — the owned, immutable settings snapshot layer.
//
//  What it adds over the raw pipeline:
//    · an IMMUTABLE snapshot (deep-frozen) with a MONOTONIC REVISION — a
//      subscriber can cheaply detect "settings changed under me" and can
//      never observe a half-merged state (the snapshot is computed from one
//      complete pipeline pass);
//    · PER-KEY PROVENANCE — for every effective top-level key (and one level
//      inside `permissions` and `env`), which enabled source(s) contributed
//      and which one WON. This is what /doctor and diagnostics project
//      instead of re-deriving three different stories.
//
//  The revision advances exactly when the underlying session cache is
//  repopulated after a reset (settings write, watcher fan-out, programmatic
//  notify) AND the reloaded state differs. Same-content reloads keep the
//  revision — callers use it as a cheap change detector.
// ============================================================================

import { getEnabledSettingSources, type SettingSource } from './constants.js'
import { getSettingsForSource, getSettingsWithErrors } from './settings.js'
import { getSessionSettingsCache } from './settingsCache.js'
import type { SettingsJson } from './types.js'
import type { ValidationError } from './validation.js'

export type ProvenanceSource = SettingSource

export interface KeyProvenance {
  /** The source whose value WON for this key (highest-priority contributor). */
  winner: ProvenanceSource
  /** Every enabled source that contributed a value, low → high priority. */
  contributors: ProvenanceSource[]
  /** True when the effective value is a MERGE (array concat / object deep-
   *  merge) rather than the winner's value verbatim. */
  merged: boolean
}

export interface SettingsSnapshot {
  /** The effective merged settings (deep-frozen). */
  settings: Readonly<SettingsJson>
  /** Validation errors surfaced by the pipeline pass (deep-frozen). */
  errors: readonly ValidationError[]
  /** Monotonic: advances only when a reload observed different content. */
  revision: number
  /**
   * Effective-key provenance. Top-level keys, plus one nested level for
   * `permissions.*` and `env.*` (dot paths).
   */
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

/** The nested groups whose members get their own provenance rows. */
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
    if (contributors.length === 0) continue // synthetic keys
    const winner = contributors[contributors.length - 1]!
    const effectiveValue = valueAtPath(effective, path)
    // Merged when >1 contributor produced a composite (array concat or
    // object deep-merge) — scalars are always the winner's verbatim value.
    const merged =
      contributors.length > 1 &&
      (Array.isArray(effectiveValue) || isPlainObject(effectiveValue))
    provenance[path] = { winner, contributors, merged }
  }
  return provenance
}

/**
 * The current immutable settings snapshot. Cheap after the first call: the
 * snapshot is rebuilt only when the pipeline's session cache was reset since
 * the last build (write, watcher fan-out, programmatic notify).
 */
export function getSettingsSnapshot(): SettingsSnapshot {
  // The session cache is the pipeline's "a reload happened" signal: null
  // means someone reset it (fanOut / write) and the next read reloads disk.
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

/** Current revision without forcing a rebuild decision on the caller. */
export function settingsRevision(): number {
  return getSettingsSnapshot().revision
}

/** TEST-ONLY: reset module state so hermetic proofs start from revision 0. */
export function _resetSettingsSnapshotForTesting(): void {
  lastSnapshot = null
  lastSettingsFingerprint = null
  revisionCounter = 0
}
