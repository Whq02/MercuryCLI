// ============================================================================
//  src/extensions/active.ts — the active set: the extensions that
//  contribute in THIS session, each with its resolved contributions and
//  its health. Computed from disk on demand, memoised until the next
//  reload (the operator's act) — the loaders read from here, never from
//  disk themselves, so every consumer sees the same swap at the same
//  moment.
// ============================================================================
import { computeHealth, type RuntimeFacts } from './health.js'
import type { Resolution } from './load/contributions.js'
import { loadOptionValues, type OptionValues } from './options.js'
import { activeEntries, computeRoster, type RosterResult } from './roster.js'
import type { Health, RosterEntry } from './types.js'
import type { ExtensionManifest, SwitchKind } from './manifest.js'
import { defaultSwitches, type Switches } from './records.js'
import { processKitExtensionOn } from '../services/mcp/sessionKitPin.js'

export type ActiveExtension = {
  entry: RosterEntry
  manifest: ExtensionManifest
  root: string
  health: Health
  resolution: Resolution
  switches: Switches
  options: OptionValues
}

export type ActiveSet = {
  roster: RosterResult
  /** Every roster entry's health (switched-on ones; off ones carry null). */
  healthById: Map<string, Health | null>
  active: ActiveExtension[]
  computedAt: number
}

let current: ActiveSet | null = null
let runtimeFacts: RuntimeFacts = {}

/** The managers hand their live states here before a health recompute. */
export function setRuntimeFacts(facts: RuntimeFacts): void {
  runtimeFacts = facts
}

export function getRuntimeFacts(): RuntimeFacts {
  return runtimeFacts
}

/** Compute the whole set from disk (no memo). */
export function computeActiveSet(input: { cwd?: string; sessionPaths?: string[] } = {}): ActiveSet {
  const roster = computeRoster(input)
  const healthById = new Map<string, Health | null>()
  const active: ActiveExtension[] = []
  const contributing = new Set(activeEntries(roster.entries).map(e => e.id))
  for (const entry of roster.entries) {
    // Health applies to every SWITCHED-ON extension — including one whose
    // copy no longer loads at all (approval on file, manifest broken): that
    // one must read ✕ broken, and its first-load settlement must see the
    // broken outcome so a kept previous version stays kept.
    const approvalOnFile = entry.record?.approval != null || entry.home === 'session'
    const wantsHealth =
      contributing.has(entry.id) ||
      (entry.switchedOn && entry.blockedBy === null && entry.shadowedBy === null && approvalOnFile && !entry.changedSinceApproval)
    if (!wantsHealth) {
      healthById.set(entry.id, null)
      continue
    }
    const { health, resolution } = computeHealth(entry, runtimeFacts)
    healthById.set(entry.id, health)
    if (!contributing.has(entry.id) || health.outcome === 'broken' || resolution === null || entry.manifest === null || entry.root === null) continue
    active.push({
      entry,
      manifest: entry.manifest,
      root: entry.root,
      health,
      resolution,
      switches: entry.record?.switches ?? defaultSwitches(),
      options: loadOptionValues(entry.id, entry.manifest.needs?.options),
    })
  }
  return { roster, healthById, active, computedAt: Date.now() }
}

/** The memoised set; the first call computes it. */
export function getActiveSet(): ActiveSet {
  if (current === null) current = computeActiveSet()
  return current
}

/** The active extensions whose `<kind>` switch is on — ANDed with the
 *  session kit's per-extension MASTER row (the two-store law):
 *  the install-level switch ∧ the process kit — an extension off in EITHER
 *  contributes nothing (skills, servers, commands, hooks, agents, the
 *  lot), because every contribution kind reads through THIS door. An
 *  un-kitted process, or a kit that never names the extension, leaves the
 *  install switch alone to decide. */
export function activeFor(kind: SwitchKind): ActiveExtension[] {
  return getActiveSet().active.filter(ext => ext.switches[kind] && processKitExtensionOn(ext.manifest.name))
}

/** Replace the memo (the reload's swap) or drop it (the next reader recomputes). */
export function publishActiveSet(next: ActiveSet | null): void {
  current = next
}

export function hasActiveSet(): boolean {
  return current !== null
}
