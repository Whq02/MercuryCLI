// ============================================================================
//  crew/projection — the ONE teammate projection.
//
//  One event-driven shared projection joining what the registry knows (WHO —
//  identity, bindings, roles, sessions) with what the operational owners
//  observe (presence · lifecycle · focus · latest activity · worktree), on
//  the Workbench engine precedent: refreshes serialize through ONE
//  serialCoalescer (a trigger arriving mid-gather coalesces into exactly one
//  trailing run), triggers are the source owners' OWN events, and with no
//  subscriber the engine is fully off — no timer, no watcher, no store arm.
//
//  THE DISTINCT-FACTS LAW: presence, lifecycle, focus and attention
//  are separate, source-backed facts — never one overloaded status string.
//    presence   — is the endpoint reachable NOW (online|away|offline|unknown),
//                 derived from process/store liveness; an unobservable source
//                 reads 'unknown', never optimistically online;
//    lifecycle  — what the session is doing (starting … completed|failed),
//                 mapped ONLY from explicitly known owner vocabulary — an
//                 unknown owner state maps to ABSENT (silence), never guessed;
//    focus      — the named current work item, when the owner records one;
//    attention  — what the operator must do: the attention view,
//                 carried BY REFERENCE as a live getter (absent while its
//                 store is dormant — honest absence, never needsYou:0-as-fact).
//
//  Consumers share DIRECTORY facts only: nothing here carries composer,
//  conversation or execution state, and no native event is copied into a
//  second durable store — every member field is a bounded projection of an
//  existing owner, refs point back at the owning surfaces.
// ============================================================================

import { useSyncExternalStore } from 'react'
import { subscribeRoomStatusFeed } from '../../services/attention/statusFeed.js'
import { cachedAttentionView, subscribeAttentionView } from '../../services/attention/viewModel.js'
import { isAttentionStoreArmed } from '../../services/attention/store.js'
import type { AttentionViewV1 } from '../../services/attention/viewModel.js'
import {
  healthOf,
  sourceEmpty,
  sourceReady,
  sourceUnavailable,
  type SourceHealth,
  type SourceState,
} from '../../substrate/sourceState.js'
import { logForDebugging } from '../../utils/debug.js'
import { serialCoalescer, type SerialCoalescer } from '../workbench/serialCoalescer.js'
import {
  resolveWorkbenchSnapshot,
  subscribeWorkbench,
} from '../workbench/projection.js'
import type { WorkbenchSnapshot, WorkbenchThreadRow } from '../workbench/contracts.js'
import {
  crewDirectoryEnabled,
  displayLabelsOf,
  listAgents,
  listAgentBindings,
  listAgentRoles,
  listAgentSessions,
  subscribeCrewIdentity,
  type AgentIdentityV1,
  type AgentRoleLinkV1,
  type AgentSessionV1,
  type CrewAgentId,
} from './identity.js'

export const PRESENCE_STATES = ['online', 'away', 'offline', 'unknown'] as const
export type CrewPresence = (typeof PRESENCE_STATES)[number]

export const LIFECYCLE_STATES = [
  'starting',
  'working',
  'waiting',
  'held',
  'finishing',
  'completed',
  'failed',
] as const
export type CrewLifecycle = (typeof LIFECYCLE_STATES)[number]

export interface CrewMemberV1 {
  agentId: CrewAgentId
  displayName: string
  /** Collision-safe presentation label (displayLabelsOf) — eyes only. */
  label: string
  visualToken: string
  /** Reachability NOW + the owner that said so. */
  presence: { state: CrewPresence; source: string; observedAt: number }
  /** What the session is doing — ABSENT when no owner vocabulary maps
   *  (silence, never a guess). */
  lifecycle?: { state: CrewLifecycle; source: string }
  /** The named current work, when an owner records one. */
  focus?: { label: string; source: string; ref?: string }
  roles: AgentRoleLinkV1[]
  /** Bounded: the open sessions plus the most recent closed one. */
  sessions: AgentSessionV1[]
  worktreeRef?: string
  latestActivity?: { label: string; atMs: number; source: string }
  /** mercury:// refs into the owning surfaces (deep-link, never clone). */
  refs: string[]
}

export interface CrewSnapshotV1 {
  v: 1
  /** Monotonic per-process refresh stamp (the coalescer generation). */
  version: number
  refreshedAt: number
  members: CrewMemberV1[]
  /** Per-source read health — a missing member is only meaningful beside
   *  the health row that says whether its source was observed. */
  sources: {
    identity: SourceHealth
    workbench: SourceHealth
  }
  /** The attention view, BY REFERENCE via a live getter — absent
   *  while its store is dormant (honest absence). Attention stays a separate
   *  fact family from presence/lifecycle by construction. */
  attention?: AttentionViewV1
}

// ── owner-state mappings (explicit vocabulary only — unknown ⇒ silence) ──────

/** Workbench thread/root state → lifecycle, only where the vocabulary is
 *  explicitly known (the attentionBridge conservative-map law). */
const THREAD_LIFECYCLE: Partial<Record<string, CrewLifecycle>> = {
  running: 'working',
  working: 'working',
  active: 'working',
  paused: 'held',
  completed: 'completed',
  settled: 'completed',
  failed: 'failed',
  killed: 'failed',
}

// ── the engine (workbench idiom: coalesced, dormant unsubscribed) ────────────

interface CrewSources {
  identity: SourceState<AgentIdentityV1[]>
  workbench: SourceState<WorkbenchSnapshot>
}

let snapshot: CrewSnapshotV1 | null = null
const listeners = new Set<() => void>()
let coalescer: SerialCoalescer | null = null
let unsubs: Array<() => void> = []

function attachLiveAttention(snap: CrewSnapshotV1): CrewSnapshotV1 {
  Object.defineProperty(snap, 'attention', {
    enumerable: true,
    configurable: true,
    get: () => (isAttentionStoreArmed() ? cachedAttentionView() : undefined),
  })
  return snap
}

type SourceName = 'identity' | 'workbench'

/** Consecutive gather faults per source within one engine lifetime. A
 *  source that was READY and throws ONCE keeps its last observation for
 *  that round: a transient fault (a read racing a write under load) is not
 *  a fact change, and it must never rebuild the snapshot on unchanged
 *  members — the snapshot's identity tore that way on a loaded runner. The
 *  SECOND consecutive fault surfaces as unavailable: an outage is a fact. */
const STICKY_FAULT_LIMIT = 1
const sourceFaults: Record<SourceName, number> = { identity: 0, workbench: 0 }
/** The last READY observation per source — the snapshot keeps only each
 *  source's health, so the value a transient fault stands in for lives
 *  here, for one engine lifetime. */
const lastReady: { identity?: SourceState<AgentIdentityV1[]>; workbench?: SourceState<WorkbenchSnapshot> } = {}
const injectedFaults: Record<SourceName, number> = { identity: 0, workbench: 0 }

/** TEST-ONLY: make the next `times` gathers of a source throw — the
 *  transient-fault law's proof seam (no load needed to drive it). */
export function _faultSourceForProofs(source: SourceName, times: number): void {
  injectedFaults[source] = Math.max(0, times)
}

function takeInjectedFault(source: SourceName): boolean {
  if (injectedFaults[source] <= 0) return false
  injectedFaults[source] -= 1
  return true
}

function keepLastObservation<T>(source: SourceName, previous: SourceState<T> | undefined, fault: string): SourceState<T> {
  sourceFaults[source] += 1
  if (previous !== undefined && previous.state === 'ready' && sourceFaults[source] <= STICKY_FAULT_LIMIT) {
    logForDebugging(`[crew/projection] ${source} gather faulted once — the last observation stands: ${fault}`)
    return previous
  }
  return sourceUnavailable(fault, true) as SourceState<T>
}

async function gatherSources(): Promise<CrewSources> {
  let identity: SourceState<AgentIdentityV1[]>
  try {
    if (takeInjectedFault('identity')) throw new Error('injected identity fault')
    const agents = await listAgents()
    identity = agents.length === 0 ? (sourceEmpty() as SourceState<AgentIdentityV1[]>) : sourceReady(agents)
    sourceFaults.identity = 0
    if (identity.state === 'ready') lastReady.identity = identity
  } catch (e) {
    identity = keepLastObservation('identity', lastReady.identity, `identity store unreadable: ${String(e).slice(0, 80)}`)
  }
  // The ONE-SHOT compose door, never the engine's cached snapshot: with no
  // subscriber the engine is dormant and its cache is null, which painted
  // "workbench unavailable" on every /crew roster while the workbench was
  // perfectly gatherable (the operator's screenshot). resolveWorkbenchSnapshot
  // reuses the live engine's snapshot when one exists and gathers once
  // otherwise; null now means exactly one thing — the flag is off.
  let workbench: SourceState<WorkbenchSnapshot>
  try {
    if (takeInjectedFault('workbench')) throw new Error('injected workbench fault')
    const wb = await resolveWorkbenchSnapshot()
    workbench = wb
      ? sourceReady(wb)
      : sourceUnavailable('the workbench projection is disabled (MERCURY_WORKBENCH=0)', false)
    sourceFaults.workbench = 0
    if (workbench.state === 'ready') lastReady.workbench = workbench
  } catch (e) {
    workbench = keepLastObservation('workbench', lastReady.workbench, `workbench gather failed: ${String(e).slice(0, 80)}`)
  }
  return { identity, workbench }
}

async function composeCrewSnapshot(version: number): Promise<CrewSnapshotV1> {
  const sources = await gatherSources()
  const agents = sources.identity.state === 'ready' ? sources.identity.value : []
  const labels = displayLabelsOf(agents)
  const wb = sources.workbench.state === 'ready' ? sources.workbench.value : null
  const threadsByAgent = new Map<string, WorkbenchThreadRow>()
  if (wb) {
    for (const row of wb.threads) {
      if (row.agentId) threadsByAgent.set(`subagent:${row.agentId}`, row)
    }
  }

  const members: CrewMemberV1[] = []
  for (const agent of agents) {
    const bindings = await listAgentBindings(agent.agentId)
    const roles = await listAgentRoles(agent.agentId)
    const allSessions = (await listAgentSessions()).filter(s => s.agentId === agent.agentId)
    const open = allSessions.filter(s => s.endedAt === undefined)
    const closed = allSessions.filter(s => s.endedAt !== undefined).sort((a, b) => b.startedAt - a.startedAt)
    const sessions = [...open, ...closed.slice(0, 1)]

    const member: CrewMemberV1 = {
      agentId: agent.agentId,
      displayName: agent.displayName,
      label: labels.get(agent.agentId) ?? agent.displayName,
      visualToken: agent.visualToken,
      presence: { state: 'unknown', source: 'none-observed', observedAt: Date.now() },
      roles,
      sessions,
      refs: [`mercury://crew/agent/${agent.agentId}`],
    }

    const isMain = bindings.some(b => b.bindingKind === 'principal' && b.bindingId === 'agent-mercury')
    const seatBinding = bindings.find(b => b.bindingKind === 'native' && b.bindingId.startsWith('seat:'))
    const subagentBinding = bindings.find(
      b => b.bindingKind === 'native' && b.bindingId.startsWith('subagent:'),
    )
    const adapterBinding = bindings.find(b => b.bindingKind === 'adapter')

    if (isMain) {
      // This process IS the main agent's session — observing it from inside.
      member.presence = { state: 'online', source: 'session', observedAt: Date.now() }
      const root = wb?.root
      if (root) {
        const mapped = THREAD_LIFECYCLE[root.state]
        if (root.blocker) member.lifecycle = { state: 'waiting', source: 'workbench:root.blocker' }
        else if (mapped) member.lifecycle = { state: mapped, source: 'workbench:root.state' }
        if (root.title) member.focus = { label: root.title, source: 'workbench:root', ref: root.refs[0] }
        if (root.worktreePath) member.worktreeRef = root.worktreePath
        // The root's stamp moves with every workbench compose (a one-shot
        // gather re-stamps an idle root); the crew fact is the PHASE. While
        // the phase and its source stand, the previous moment stands with
        // them — a fresher clock on an unchanged phase must never rebuild
        // the snapshot (the loaded-runner identity tear).
        const previous = snapshot?.members.find(p => p.agentId === member.agentId)?.latestActivity
        const unchanged = previous !== undefined && previous.source === 'workbench:root' && previous.label === root.phase
        member.latestActivity = {
          label: root.phase,
          atMs: unchanged ? previous.atMs : root.updatedAt,
          source: 'workbench:root',
        }
      }
    } else if (seatBinding) {
      // A `seat:` binding was written by the retired router party's sweep;
      // no seat host exists now, so the record reads offline (never a live
      // spinner over a crew nothing runs).
      member.presence = { state: 'offline', source: 'seat:retired', observedAt: Date.now() }
    } else if (subagentBinding) {
      const row = threadsByAgent.get(subagentBinding.bindingId)
      if (row) {
        member.presence = { state: 'online', source: 'workbench:thread', observedAt: Date.now() }
        const mapped = THREAD_LIFECYCLE[row.state]
        if (row.blocker) member.lifecycle = { state: 'waiting', source: 'workbench:thread.blocker' }
        else if (mapped) member.lifecycle = { state: mapped, source: 'workbench:thread.state' }
        member.focus = { label: row.title, source: 'workbench:thread', ref: row.refs[0] }
        if (row.worktreePath) member.worktreeRef = row.worktreePath
        member.latestActivity = { label: row.phase, atMs: row.updatedAt, source: 'workbench:thread' }
        member.refs.push(...row.refs.slice(0, 2))
      } else if (sources.workbench.state === 'ready') {
        member.presence = { state: 'offline', source: 'workbench:no-live-thread', observedAt: Date.now() }
      }
    } else if (adapterBinding) {
      // External seats: presence/capability facts land with the M3 bridge —
      // until an adapter reports, the honest answer is 'unknown'.
      member.presence = { state: 'unknown', source: `adapter:${adapterBinding.adapterKind ?? 'external'}:unobserved`, observedAt: Date.now() }
    }

    members.push(member)
  }

  members.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))

  const snap: CrewSnapshotV1 = {
    v: 1,
    version,
    refreshedAt: Date.now(),
    members,
    sources: {
      identity: healthOf(sources.identity),
      workbench: healthOf(sources.workbench),
    },
  }
  return attachLiveAttention(snap)
}

/** Structural change signature — reference stability across no-op refreshes:
 *  the new snapshot replaces the old only when the FACTS moved. */
function crewSig(s: CrewSnapshotV1): string {
  return JSON.stringify(
    s.members.map(m => [
      m.agentId,
      m.displayName,
      m.label,
      m.presence.state,
      m.presence.source,
      m.lifecycle?.state ?? '',
      m.focus?.label ?? '',
      m.worktreeRef ?? '',
      m.latestActivity?.label ?? '',
      m.latestActivity?.atMs ?? 0,
      // Role/session FACTS, not just counts: a link closing (activeUntil set)
      // or a session ending flips these with the row count unchanged — the
      // signature must move whenever the facts moved.
      m.roles.length,
      m.roles.filter(r => r.activeUntil === undefined).length,
      m.sessions.length,
      m.sessions.filter(s => s.endedAt === undefined).length,
    ]),
  ) + `|${s.sources.identity.state}|${s.sources.workbench.state}`
}

// The arming epoch: a teardown (and any re-arm after it) advances it, so a
// gather still in flight from a PREVIOUS engine can never land its stale
// snapshot over a fresh one — the coalescer serializes runs only within one
// engine lifetime, not across a teardown/re-arm boundary.
let armEpoch = 0

async function refresh(): Promise<void> {
  const epoch = armEpoch
  const next = await composeCrewSnapshot((coalescer?.generation() ?? 0))
  if (epoch !== armEpoch) return
  if (snapshot && crewSig(snapshot) === crewSig(next)) return
  snapshot = next
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[crew/projection] listener threw (ignored): ${e}`)
    }
  }
}

function armEngine(): void {
  if (coalescer) return
  coalescer = serialCoalescer(refresh, 'crew-projection')
  const poke = (): void => coalescer?.poke()
  unsubs = [
    // Identity store changes (cross-process via the fileStore watcher).
    subscribeCrewIdentity(poke),
    subscribeWorkbench(poke),
    subscribeAttentionView(poke),
    subscribeRoomStatusFeed(() => poke()),
  ]
  poke()
}

function teardownEngine(): void {
  armEpoch++
  sourceFaults.identity = 0
  sourceFaults.workbench = 0
  delete lastReady.identity
  delete lastReady.workbench
  for (const u of unsubs) {
    try {
      u()
    } catch {
      // teardown is best-effort
    }
  }
  unsubs = []
  coalescer?.release()
  coalescer = null
}

/** Subscribe to coalesced crew changes. First subscriber arms the engine and
 *  every source tap; the last tears everything down (solo dormancy). */
export function subscribeCrew(listener: () => void): () => void {
  if (!crewDirectoryEnabled()) return () => {}
  listeners.add(listener)
  armEngine()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) teardownEngine()
  }
}

/** RENDER-PATH read: the cached snapshot (null before the first gather). */
export function cachedCrewSnapshot(): CrewSnapshotV1 | null {
  return snapshot
}

/** Dormancy observable: no subscriber ⇒ no engine, no taps. */
export function isCrewProjectionArmed(): boolean {
  return coalescer !== null
}

export function useCrew(): CrewSnapshotV1 | null {
  return useSyncExternalStore(subscribeCrew, cachedCrewSnapshot, cachedCrewSnapshot)
}

/**
 * One-shot resolve for snapshot-shaped consumers (resources, ACP): gathers
 * WITHOUT arming the engine — a bridge process never spins a timer for one
 * read (the workbench resolve precedent).
 */
export async function resolveCrewSnapshot(): Promise<CrewSnapshotV1 | null> {
  if (!crewDirectoryEnabled()) return null
  if (coalescer) {
    await coalescer.settled()
    if (snapshot) return snapshot
  }
  return composeCrewSnapshot(0)
}

/** Test seam (never product-read). */
export function _resetCrewProjectionForTesting(): void {
  teardownEngine()
  listeners.clear()
  snapshot = null
}

// ── the continuity law probe ─────────────

/**
 * Exercise the cross-surface continuity laws in a throwaway store and report
 * which hold. Proof-hygiene: an own mkdtemp root per call; every "surface" is
 * a distinct READ PATH over the same durable owners (registry resolve · the
 * directory enumeration · the descriptor record · the wire-shaped cursor
 * fold) — exactly what cockpit/Console/Workbench/ACP/VS Code consume.
 */
export async function __continuityLawsForProof(): Promise<{
  sameAgentIdEverySurface: boolean
  deliberateSameThreadSameCursor: boolean
  restartPreservesIdentityAndCursor: boolean
}> {
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-continuity-')))
  const identity = await import('./identity.js')
  const conversations = await import('./conversations.js')
  const inbox = await import('./inbox.js')
  const descriptor = await import('./descriptor.js')

  // One canonical agent, resolved through every surface's read path.
  const minted = await identity.ensureAgentIdentity({
    displayName: 'Continuity Probe',
    binding: { bindingKind: 'adapter', bindingId: 'cont-probe-1', adapterKind: 'codex' },
    dir,
  })
  const viaRegistry = await identity.resolveAgent('adapter:cont-probe-1', { dir })
  const viaDirectory = (await identity.listAgents({ dir })).find(a => a.agentId === minted.agentId)?.agentId ?? null
  const desc = await descriptor.publishSessionDescriptor(
    { agentId: minted.agentId, sessionId: 'cont-sess-1', missionRef: 'fix auth', worktreeRef: 'wt-auth' },
    { dir },
  )
  const sameAgentIdEverySurface =
    viaRegistry === minted.agentId && viaDirectory === minted.agentId && desc.agentId === minted.agentId

  // Two surfaces deliberately open ONE thread (the adoptId law) and agree on
  // id, cursor and the exact resume position.
  const surfaceA = await conversations.mintConversation({
    kind: 'work',
    title: 'the continuity thread',
    participants: [],
    adoptId: 'cv-cont-00001' as never,
    dir,
  })
  const surfaceB = await conversations.mintConversation({
    kind: 'work',
    title: 'IGNORED — the thread exists',
    participants: [],
    adoptId: 'cv-cont-00001' as never,
    dir,
  })
  await conversations.appendConversationEvent(surfaceA.conversationId, { kind: 'message', label: 'one' }, { dir })
  await conversations.appendConversationEvent(
    surfaceA.conversationId,
    { kind: 'question', label: 'the unresolved q', requiresResolution: true },
    { dir },
  )
  await conversations.commitReadCursor('op-continuity', surfaceA.conversationId, 1, { dir })
  const cursorDirect = await conversations.readCursorOf('op-continuity', surfaceA.conversationId, { dir })
  const cursorWire =
    (await conversations.listReadCursors('op-continuity', { dir })).get(surfaceA.conversationId) ?? 0
  const thread = await conversations.conversationOf(surfaceA.conversationId, { dir })
  const resumeDirect = thread ? inbox.oldestUnresolvedOf(thread, cursorDirect) : null
  const resumeWire = thread ? inbox.oldestUnresolvedOf(thread, cursorWire) : null
  const deliberateSameThreadSameCursor =
    surfaceA.conversationId === surfaceB.conversationId &&
    cursorDirect === cursorWire &&
    resumeDirect === resumeWire &&
    resumeDirect === 2

  // Restart = a fresh open of the same durable stores: identity, descriptor
  // revision (an unchanged republication coalesces) and the cursor survive;
  // the rendered title is the pure fold of resolved labels.
  const reattached = await identity.ensureAgentIdentity({
    displayName: 'whatever-the-adapter-says-now',
    binding: { bindingKind: 'adapter', bindingId: 'cont-probe-1', adapterKind: 'codex' },
    dir,
  })
  const descAgain = await descriptor.publishSessionDescriptor(
    { agentId: minted.agentId, sessionId: 'cont-sess-1', missionRef: 'fix auth', worktreeRef: 'wt-auth' },
    { dir },
  )
  const cursorAfter = await conversations.readCursorOf('op-continuity', surfaceA.conversationId, { dir })
  const title = descriptor.renderSessionTitle({
    agentLabel: 'Continuity Probe',
    missionLabel: 'fix auth',
    worktreeLabel: 'wt-auth',
  })
  const restartPreservesIdentityAndCursor =
    reattached.agentId === minted.agentId &&
    descAgain.revision === desc.revision &&
    cursorAfter === cursorDirect &&
    title === 'Continuity Probe · fix auth · wt-auth'

  return { sameAgentIdEverySurface, deliberateSameThreadSameCursor, restartPreservesIdentityAndCursor }
}
