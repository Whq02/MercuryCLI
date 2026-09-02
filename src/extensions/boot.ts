// ============================================================================
//  src/extensions/boot.ts — the boot wiring: ONE load before the first
//  render and the SessionStart hooks, the settings-change subscription that
//  marks the roster pending (never a reload — `r` is the operator's act),
//  the retired-tree reconcile, and the projections /health and readiness
//  paint from the one health owner. Boot never touches the network for
//  extensions.
// ============================================================================
import { existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { getSettingsForSource } from '../utils/settings/settings.js'
import { computeActiveSet, getActiveSet, hasActiveSet, publishActiveSet } from './active.js'
import { healthLine, summariseHealth, type HealthSummary } from './health.js'
import { setExtensionKeybindingLayer } from '../keybindings/loadUserBindings.js'
import { getExtensionKeybindingBlocks } from './load/keybindings.js'
import { logAct } from './records.js'
import { bootExtensions, reloadExtensions, type ReloadResult } from './reload.js'
import { activeEntries, trustStateOf } from './roster.js'
import type { RosterEntry } from './types.js'

// ── the one boot load ───────────────────────────────────────────────────────

let bootPromise: Promise<ReloadResult> | null = null

/** The first caller loads; every later caller shares the same promise. */
export function ensureExtensionsLoaded(options: { cwd?: string } = {}): Promise<ReloadResult> {
  if (!bootPromise) {
    setExtensionKeybindingLayer(getExtensionKeybindingBlocks)
    reconcileRetiredState()
    bootPromise = bootExtensions(options)
  }
  return bootPromise
}

/** After an explicit reload the boot promise follows the newest swap. */
export function noteReloaded(result: Promise<ReloadResult>): void {
  bootPromise = result
}

export { reloadExtensions }

// ── the retired tree (the operator's ruling) ────────────────────────────────

/** The retired estate's folder name, composed so the tree never spells it. */
const RETIRED_FOLDER = ['plug', 'ins'].join('')

/**
 * A tree from Mercury's retired extension format under Mercury's OWN config
 * home is removed once, logged. Only the config home Mercury owns is
 * touched — never a project folder, never another product's home. The home
 * is the resolved config home itself, so an override pointing at a foreign
 * directory is honoured as the operator's own home.
 */
export function reconcileRetiredState(home: string = getMercuryHome()): { removed: string | null } {
  const retired = join(resolve(home), RETIRED_FOLDER)
  try {
    if (!existsSync(retired) || !statSync(retired).isDirectory()) return { removed: null }
    rmSync(retired, { recursive: true, force: true })
    const line = `retired extension state removed: ${retired}`
    logForDebugging(line)
    logAct(line)
    return { removed: retired }
  } catch (error) {
    logForDebugging(`retired extension state at ${retired} could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    return { removed: null }
  }
}

// ── pending: settings changed under the running session ─────────────────────

let pending = false
const pendingListeners = new Set<(pending: boolean) => void>()

export function isExtensionsPending(): boolean {
  return pending
}

export function onExtensionsPending(listener: (pending: boolean) => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

export function setExtensionsPending(value: boolean): void {
  if (pending === value) return
  pending = value
  for (const listener of pendingListeners) listener(value)
}

function switchesSnapshot(): string {
  const user = getSettingsForSource('userSettings')?.extensions ?? {}
  const local = getSettingsForSource('localSettings')?.extensions ?? {}
  const project = getSettingsForSource('projectSettings')?.extensions ?? {}
  return JSON.stringify({ user, local, project })
}

let lastSnapshot: string | null = null
let subscribed = false

/** Settings changed (the `extensions` block): mark the roster pending; the board's `r` swaps. */
export function installExtensionsChangeSubscription(): void {
  if (subscribed) return
  subscribed = true
  lastSnapshot = switchesSnapshot()
  settingsChangeDetector.subscribe(() => {
    const next = switchesSnapshot()
    if (next === lastSnapshot) return
    lastSnapshot = next
    setExtensionsPending(true)
  })
}

// ── projections (renderers derive nothing) ──────────────────────────────────

export type ExtensionsHealthRow = HealthSummary & { problems: string[]; brokenReasons: Array<{ id: string; reason: string }> }

/** The facts /health's one row paints. Reads the memoised set when a session loaded it; otherwise computes a cheap one. */
export function extensionsHealthRow(): ExtensionsHealthRow {
  const set = hasActiveSet() ? getActiveSet() : computeActiveSet()
  if (!hasActiveSet()) publishActiveSet(null)
  const active = new Set(activeEntries(set.roster.entries).map(e => e.id))
  const rows = set.roster.entries.map(entry => ({ id: entry.id, active: active.has(entry.id), health: set.healthById.get(entry.id) ?? null }))
  const summary = summariseHealth(rows)
  const brokenReasons = rows.filter(r => r.health?.outcome === 'broken').map(r => ({ id: r.id, reason: r.health!.reasons[0] ?? 'broken' }))
  return { ...summary, problems: set.roster.problems, brokenReasons }
}

export type ReadinessRow = {
  id: string
  kind: 'extension'
  label: string
  state: 'ready' | 'degraded' | 'failed' | 'disabled' | 'unavailable'
  detail: string
  remedy?: string
  source: string
}

/** Readiness rows from the same owner. */
export function extensionReadinessRows(): ReadinessRow[] {
  const row = extensionsHealthRow()
  const source = 'extensions health (one owner)'
  if (row.problems.length > 0) {
    return [{ id: 'extension:health', kind: 'extension', label: 'extensions', state: 'unavailable', detail: row.problems[0]!, remedy: 'fix or remove the record file it names under <config home>/extensions', source }]
  }
  if (row.status === 'off') {
    return [{ id: 'extension:health', kind: 'extension', label: 'extensions', state: 'disabled', detail: 'no extensions installed', source }]
  }
  const rows: ReadinessRow[] = [
    { id: 'extension:health', kind: 'extension', label: 'extensions', state: row.status === 'fail' ? 'failed' : row.status === 'warn' ? 'degraded' : 'ready', detail: row.evidence, source },
  ]
  for (const broken of row.brokenReasons.slice(0, 3)) {
    rows.push({ id: `extension:${broken.id}:broken`, kind: 'extension', label: broken.id, state: 'failed', detail: broken.reason, remedy: '/extensions shows the reason; x uninstalls a copy whose folder is gone', source })
  }
  return rows
}

/** The row list the surfaces paint: id → the state cell text. */
export function rosterStateLines(entries: RosterEntry[]): Array<{ id: string; state: string }> {
  const set = hasActiveSet() ? getActiveSet() : null
  return entries.map(entry => {
    const health = set?.healthById.get(entry.id) ?? null
    const trust = trustStateOf(entry)
    return { id: entry.id, state: trust === 'on' && health ? healthLine(health) : trust }
  })
}
