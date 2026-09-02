
import { useSyncExternalStore } from 'react'
import type { SpinnerMode } from '../../components/Spinner/types.js'

export type TurnPhaseName =
  | 'idle'
  | 'accepted'
  | 'preparing'
  | 'compacting'
  | 'dispatching'
  | 'waiting'
  | 'thinking'
  | 'responding'
  | 'tool-work'
  | 'settling'

export type PreparingReason = 'input' | 'hooks' | 'context' | 'workspace'

export type StreamKind = 'thinking' | 'text' | 'tool-input'

export type PhaseDetail = {
  reason?: PreparingReason
  model?: string
  effort?: string
  servedBy?: string
  toolCount?: number
}

export type TurnPhaseSnapshot = {
  generation: number
  phase: TurnPhaseName
  detail: PhaseDetail
  enteredAt: number
  turnStartedAt: number
}

export type PulseStreamActivity = {
  generation: number
  lastEventAt: number | null
  lastKind: StreamKind | 'chunk' | null
  firstChunkAt: number | null
  firstThinkingAt: number | null
  firstTextAt: number | null
}


let clock: () => number = () => performance.now()

export function pulseNow(): number {
  return clock()
}

export function setPulseClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => performance.now())
}

export function resetPhaseForTests(): void {
  snapshot = IDLE_SNAPSHOT
  activity = {
    generation: 0,
    lastEventAt: null,
    lastKind: null,
    firstChunkAt: null,
    firstThinkingAt: null,
    firstTextAt: null,
  }
  notify()
}


const IDLE_SNAPSHOT: TurnPhaseSnapshot = {
  generation: 0,
  phase: 'idle',
  detail: {},
  enteredAt: 0,
  turnStartedAt: 0,
}

let snapshot: TurnPhaseSnapshot = IDLE_SNAPSHOT
let activity: PulseStreamActivity = {
  generation: 0,
  lastEventAt: null,
  lastKind: null,
  firstChunkAt: null,
  firstThinkingAt: null,
  firstTextAt: null,
}
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

const ALLOWED: Record<TurnPhaseName, readonly TurnPhaseName[]> = {
  idle: ['accepted'],
  accepted: ['preparing', 'compacting', 'dispatching', 'settling'],
  preparing: ['preparing', 'compacting', 'dispatching', 'settling'],
  compacting: ['preparing', 'compacting', 'dispatching', 'settling'],
  dispatching: ['waiting', 'settling'],
  waiting: ['thinking', 'responding', 'tool-work', 'settling'],
  thinking: ['thinking', 'responding', 'tool-work', 'settling'],
  responding: ['thinking', 'responding', 'tool-work', 'settling'],
  'tool-work': [
    'preparing',
    'compacting',
    'dispatching',
    'thinking',
    'responding',
    'tool-work',
    'settling',
  ],
  settling: ['idle'],
}

export function beginPhaseGeneration(generation: number): void {
  const now = pulseNow()
  snapshot = {
    generation,
    phase: 'accepted',
    detail: {},
    enteredAt: now,
    turnStartedAt: now,
    }
  activity = {
    generation,
    lastEventAt: null,
    lastKind: null,
    firstChunkAt: null,
    firstThinkingAt: null,
    firstTextAt: null,
  }
  notify()
}

export function setPulsePhase(
  generation: number,
  phase: TurnPhaseName,
  detail?: PhaseDetail,
): boolean {
  if (generation !== snapshot.generation) return false
  if (phase !== snapshot.phase && !ALLOWED[snapshot.phase].includes(phase)) {
    return false
  }
  const mergedDetail = detail
    ? { ...snapshot.detail, ...detail }
    : snapshot.detail
  if (phase === snapshot.phase && !detailChanged(snapshot.detail, mergedDetail)) {
    return true
  }
  snapshot = {
    ...snapshot,
    phase,
    detail: mergedDetail,
    enteredAt: phase === snapshot.phase ? snapshot.enteredAt : pulseNow(),
  }
  notify()
  return true
}

function detailChanged(a: PhaseDetail, b: PhaseDetail): boolean {
  return (
    a.reason !== b.reason ||
    a.model !== b.model ||
    a.effort !== b.effort ||
    a.servedBy !== b.servedBy ||
    a.toolCount !== b.toolCount
  )
}

export function finishPhaseGeneration(generation: number): void {
  if (generation !== snapshot.generation) return
  if (snapshot.phase !== 'idle') {
    snapshot = { ...snapshot, phase: 'idle', enteredAt: pulseNow(), detail: {} }
    notify()
  }
}

export function notePulseStreamActivity(
  generation: number,
  kind: StreamKind | 'chunk',
): void {
  if (generation !== snapshot.generation) return
  const now = pulseNow()
  if (activity.generation !== generation) return
  activity = {
    ...activity,
    lastEventAt: now,
    lastKind: kind,
    firstChunkAt: activity.firstChunkAt ?? now,
    firstThinkingAt:
      kind === 'thinking' ? (activity.firstThinkingAt ?? now) : activity.firstThinkingAt,
    firstTextAt: kind === 'text' ? (activity.firstTextAt ?? now) : activity.firstTextAt,
  }
}

export function getPulseActivity(): PulseStreamActivity {
  return activity
}

export function getPulsePhase(): TurnPhaseSnapshot {
  return snapshot
}

export function subscribePulsePhase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePulsePhase(): TurnPhaseSnapshot {
  return useSyncExternalStore(subscribePulsePhase, getPulsePhase, getPulsePhase)
}


export function projectSpinnerMode(
  phase: TurnPhaseName,
  lastKind?: StreamKind | 'chunk' | null,
): SpinnerMode {
  switch (phase) {
    case 'thinking':
      return 'thinking'
    case 'responding':
      return lastKind === 'tool-input' ? 'tool-input' : 'responding'
    case 'tool-work':
      return 'tool-use'
    case 'settling':
      return 'responding'
    case 'idle':
      return 'responding'
    default:
      return 'requesting'
  }
}

export function computeDisplayPhase(
  prevDisplayed: TurnPhaseName,
  snap: TurnPhaseSnapshot,
  now: number,
  dwellMs = 200,
): TurnPhaseName {
  const detailSubphase =
    snap.phase === 'preparing' ||
    snap.phase === 'compacting' ||
    snap.phase === 'dispatching'
  if (!detailSubphase) return snap.phase
  if (now - snap.enteredAt >= dwellMs) return snap.phase
  if (prevDisplayed === 'idle' || prevDisplayed === 'settling') return 'accepted'
  return prevDisplayed
}
