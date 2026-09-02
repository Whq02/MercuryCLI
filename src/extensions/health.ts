// ============================================================================
//  src/extensions/health.ts — health: ONE owner, three outcomes, always a
//  reason. Computed here from live facts (filesystem reads, PATH lookups,
//  the managers' runtime facts) and painted by every renderer — the row,
//  the pane, /health, `mercury extensions list`. Renderers never re-derive
//  it. Never the network.
// ============================================================================
import { existsSync } from 'node:fs'
import { MERCURY_VERSION } from '../constants/product.js'
import { resolveContributions, realProbes, type Probes, type Resolution } from './load/contributions.js'
import { RESERVED_MODULE_REASON } from './manifest.js'
import { isOptionSet } from './options.js'
import { hashTree } from './tree.js'
import type { Health, HealthOutcome, RosterEntry } from './types.js'

// ── runtime facts (reported by the managers, read here, never re-derived) ───

export type RuntimeFacts = {
  /** MCP servers by runtime name (`ext:<name>:<server>`) → their live state. */
  servers?: Map<string, { state: 'connected' | 'pending' | 'failed' | 'disabled'; detail?: string; toolCount?: number }>
  /** Language servers by runtime name → their live state. */
  language?: Map<string, { state: 'running' | 'starting' | 'stopped' | 'error'; detail?: string }>
}

type HookFailure = { count: number; last: string }
const hookFailures = new Map<string, Map<string, HookFailure>>()
const droppedChannelPosts = new Map<string, Map<string, number>>()

/** The hook engine reports a failed hook (non-zero exit, timeout, unparseable output) here. */
export function recordHookFailure(extensionId: string, hookLabel: string, reason: string): void {
  let byHook = hookFailures.get(extensionId)
  if (!byHook) {
    byHook = new Map()
    hookFailures.set(extensionId, byHook)
  }
  const entry = byHook.get(hookLabel) ?? { count: 0, last: '' }
  entry.count++
  entry.last = reason
  byHook.set(hookLabel, entry)
}

/** The channel gate reports a post dropped because the server was not declared under `channels`. */
export function recordDroppedChannelPost(extensionId: string, serverName: string): void {
  let byServer = droppedChannelPosts.get(extensionId)
  if (!byServer) {
    byServer = new Map()
    droppedChannelPosts.set(extensionId, byServer)
  }
  byServer.set(serverName, (byServer.get(serverName) ?? 0) + 1)
}

export function hookFailuresFor(extensionId: string): Map<string, HookFailure> {
  return hookFailures.get(extensionId) ?? new Map()
}

/** Test seam: the counters are session-scoped. */
export function resetRuntimeCounters(): void {
  hookFailures.clear()
  droppedChannelPosts.clear()
}

// ── the probe (04 §1.1) ─────────────────────────────────────────────────────

function versionFloorUnmet(floor: string | undefined): string | null {
  if (!floor) return null
  const wanted = floor.replace(/^>=/, '').trim()
  if (compareVersions(MERCURY_VERSION, wanted) < 0) return `needs Mercury ≥ ${wanted} (this is ${MERCURY_VERSION})`
  return null
}

/** Numeric dotted compare; a pre-release suffix on either side is ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

export type HealthComputation = { health: Health; resolution: Resolution | null }

/**
 * Health for one roster entry. The broken probes come first (nothing
 * loads); the partial probes follow in the spec's order, then the runtime
 * facts. `skipTamperHash` spares the content hash on cheap lists.
 */
export function computeHealth(entry: RosterEntry, facts: RuntimeFacts = {}, options: { probes?: Probes; skipTamperHash?: boolean } = {}): HealthComputation {
  const reasons: string[] = []
  const notes: string[] = []
  const broken = (reason: string): HealthComputation => ({ health: { outcome: 'broken', reasons: [reason], notes }, resolution: null })

  // ── broken ───────────────────────────────────────────────────────────────
  if (entry.root === null || !existsSync(entry.root)) return broken(entry.record ? `folder missing: ${entry.record.path}` : 'folder missing')
  if (entry.manifest === null) {
    const first = entry.manifestErrors[0] ?? 'manifest invalid'
    if (first === RESERVED_MODULE_REASON) return broken(first)
    return broken(first === 'manifest missing' ? 'manifest missing' : `manifest invalid: ${first}`)
  }
  if (entry.record && entry.home === 'installed') {
    if (entry.record.version !== entry.manifest.version) return broken(`record says ${entry.record.version}, copy says ${entry.manifest.version}`)
    if (entry.record.name !== entry.manifest.name) return broken(`record says ${entry.record.name}, copy says ${entry.manifest.name}`)
    if (!options.skipTamperHash && hashTree(entry.root) !== entry.record.contentHash) return broken('changed since install (the copy no longer matches the installed record)')
  }
  const floor = versionFloorUnmet(entry.manifest.mercury)
  if (floor) return broken(floor)

  // ── partial ──────────────────────────────────────────────────────────────
  const schema = entry.manifest.needs?.options
  const id = entry.id
  const probes = options.probes ?? realProbes({ optionSet: key => isOptionSet(id, schema, key) })
  const resolution = resolveContributions(entry.manifest, entry.root, entry.id, probes)
  reasons.push(...resolution.defects)
  notes.push(...resolution.notes)

  // runtime facts, live from the managers
  for (const server of resolution.servers) {
    const live = facts.servers?.get(server.runtimeName)
    if (live?.state === 'failed') reasons.push(`server ${server.key}: failed${live.detail ? ` (${live.detail})` : ''}`)
  }
  for (const language of resolution.language) {
    const live = facts.language?.get(language.runtimeName)
    if (live?.state === 'error') reasons.push(`language ${language.key}: ${live.detail ?? 'crashed'}`)
  }
  for (const [hookLabel, failure] of hookFailuresFor(entry.id)) {
    reasons.push(`hook ${hookLabel}: ${failure.count} failure${failure.count === 1 ? '' : 's'} this session · last: ${failure.last}`)
  }
  for (const [serverName, count] of droppedChannelPosts.get(entry.id) ?? new Map<string, number>()) {
    reasons.push(`channel ${serverName}: ${count} post${count === 1 ? '' : 's'} dropped (not declared under channels)`)
  }

  const outcome: HealthOutcome = reasons.length === 0 ? 'loads' : 'partial'
  return { health: { outcome, reasons, notes }, resolution }
}

// ── the readouts every renderer paints ──────────────────────────────────────

export function healthGlyph(outcome: HealthOutcome): string {
  return outcome === 'loads' ? '●' : outcome === 'partial' ? '◑' : '✕'
}

export function healthWord(outcome: HealthOutcome): string {
  return outcome === 'loads' ? 'on' : outcome === 'partial' ? 'partial' : 'broken'
}

/** The row/CLI form: `● on` · `◑ partial · <first reason>` · `✕ broken · <reason>`. */
export function healthLine(health: Health): string {
  const head = `${healthGlyph(health.outcome)} ${healthWord(health.outcome)}`
  return health.reasons.length > 0 ? `${head} · ${health.reasons[0]}` : head
}

export type HealthSummary = {
  on: number
  partial: number
  broken: number
  off: number
  brokenIds: string[]
  evidence: string
  status: 'pass' | 'warn' | 'fail' | 'off'
}

/** /health's ONE row: evidence `N on · M partial · K broken · J off`; pass when K = 0, warn when M > 0, fail when K > 0. */
export function summariseHealth(rows: Array<{ id: string; active: boolean; health: Health | null }>): HealthSummary {
  let on = 0
  let partial = 0
  let broken = 0
  let off = 0
  const brokenIds: string[] = []
  for (const row of rows) {
    if (!row.active || row.health === null) {
      off++
      continue
    }
    if (row.health.outcome === 'loads') on++
    else if (row.health.outcome === 'partial') partial++
    else {
      broken++
      brokenIds.push(row.id)
    }
  }
  const evidence = `${on} on · ${partial} partial · ${broken} broken · ${off} off`
  const status: HealthSummary['status'] = rows.length === 0 ? 'off' : broken > 0 ? 'fail' : partial > 0 ? 'warn' : 'pass'
  return { on, partial, broken, off, brokenIds, evidence, status }
}
