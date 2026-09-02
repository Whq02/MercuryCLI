
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
  label: string
  visualToken: string
  presence: { state: CrewPresence; source: string; observedAt: number }
  lifecycle?: { state: CrewLifecycle; source: string }
  focus?: { label: string; source: string; ref?: string }
  roles: AgentRoleLinkV1[]
  sessions: AgentSessionV1[]
  worktreeRef?: string
  latestActivity?: { label: string; atMs: number; source: string }
  refs: string[]
}

export interface CrewSnapshotV1 {
  v: 1
  version: number
  refreshedAt: number
  members: CrewMemberV1[]
  sources: {
    identity: SourceHealth
    workbench: SourceHealth
  }
  attention?: AttentionViewV1
}


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

async function gatherSources(): Promise<CrewSources> {
  let identity: SourceState<AgentIdentityV1[]>
  try {
    const agents = await listAgents()
    identity = agents.length === 0 ? (sourceEmpty() as SourceState<AgentIdentityV1[]>) : sourceReady(agents)
  } catch (e) {
    identity = sourceUnavailable(`identity store unreadable: ${String(e).slice(0, 80)}`, true)
  }
  let workbench: SourceState<WorkbenchSnapshot>
  try {
    const wb = await resolveWorkbenchSnapshot()
    workbench = wb
      ? sourceReady(wb)
      : sourceUnavailable('the workbench projection is disabled (MERCURY_WORKBENCH=0)', false)
  } catch (e) {
    workbench = sourceUnavailable(`workbench gather failed: ${String(e).slice(0, 80)}`, true)
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
      member.presence = { state: 'online', source: 'session', observedAt: Date.now() }
      const root = wb?.root
      if (root) {
        const mapped = THREAD_LIFECYCLE[root.state]
        if (root.blocker) member.lifecycle = { state: 'waiting', source: 'workbench:root.blocker' }
        else if (mapped) member.lifecycle = { state: mapped, source: 'workbench:root.state' }
        if (root.title) member.focus = { label: root.title, source: 'workbench:root', ref: root.refs[0] }
        if (root.worktreePath) member.worktreeRef = root.worktreePath
        member.latestActivity = {
          label: root.phase,
          atMs: root.updatedAt,
          source: 'workbench:root',
        }
      }
    } else if (seatBinding) {
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
      m.roles.length,
      m.roles.filter(r => r.activeUntil === undefined).length,
      m.sessions.length,
      m.sessions.filter(s => s.endedAt === undefined).length,
    ]),
  ) + `|${s.sources.identity.state}|${s.sources.workbench.state}`
}

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
    subscribeCrewIdentity(poke),
    subscribeWorkbench(poke),
    subscribeAttentionView(poke),
    subscribeRoomStatusFeed(() => poke()),
  ]
  poke()
}

function teardownEngine(): void {
  armEpoch++
  for (const u of unsubs) {
    try {
      u()
    } catch {
    }
  }
  unsubs = []
  coalescer?.release()
  coalescer = null
}

export function subscribeCrew(listener: () => void): () => void {
  if (!crewDirectoryEnabled()) return () => {}
  listeners.add(listener)
  armEngine()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) teardownEngine()
  }
}

export function cachedCrewSnapshot(): CrewSnapshotV1 | null {
  return snapshot
}

export function isCrewProjectionArmed(): boolean {
  return coalescer !== null
}

export function useCrew(): CrewSnapshotV1 | null {
  return useSyncExternalStore(subscribeCrew, cachedCrewSnapshot, cachedCrewSnapshot)
}

export async function resolveCrewSnapshot(): Promise<CrewSnapshotV1 | null> {
  if (!crewDirectoryEnabled()) return null
  if (coalescer) {
    await coalescer.settled()
    if (snapshot) return snapshot
  }
  return composeCrewSnapshot(0)
}

export function _resetCrewProjectionForTesting(): void {
  teardownEngine()
  listeners.clear()
  snapshot = null
}


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
