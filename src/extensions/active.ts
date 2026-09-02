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
  healthById: Map<string, Health | null>
  active: ActiveExtension[]
  computedAt: number
}

let current: ActiveSet | null = null
let runtimeFacts: RuntimeFacts = {}

export function setRuntimeFacts(facts: RuntimeFacts): void {
  runtimeFacts = facts
}

export function getRuntimeFacts(): RuntimeFacts {
  return runtimeFacts
}

export function computeActiveSet(input: { cwd?: string; sessionPaths?: string[] } = {}): ActiveSet {
  const roster = computeRoster(input)
  const healthById = new Map<string, Health | null>()
  const active: ActiveExtension[] = []
  const contributing = new Set(activeEntries(roster.entries).map(e => e.id))
  for (const entry of roster.entries) {
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

export function getActiveSet(): ActiveSet {
  if (current === null) current = computeActiveSet()
  return current
}

export function activeFor(kind: SwitchKind): ActiveExtension[] {
  return getActiveSet().active.filter(ext => ext.switches[kind] && processKitExtensionOn(ext.manifest.name))
}

export function publishActiveSet(next: ActiveSet | null): void {
  current = next
}

export function hasActiveSet(): boolean {
  return current !== null
}
