
import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'
import {
  listExecutions,
  subscribeExecutionEvents,
} from '../../services/primitives/executionPlane.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { BUDDY_FRESH_MS } from './buddyState.js'
import {
  companionTurnSignals,
  subscribeCompanionSignals,
  type CompanionTurnSignals,
} from './companionSignals.js'
import { critterFrameKey, swayPhaseAt, type SwayAnchor } from './critterIdle.js'
import { daemonCrewLivenessSync } from './daemonRosterSnapshot.js'
import { subscribeUiClock } from './uiClock.js'

export const SLEEP_AFTER_MS = BUDDY_FRESH_MS

export const SLEEP_CHECK_MS = 30_000

const AGENT_EXECUTION_KINDS: ReadonlySet<string> = new Set(['agent', 'workflow-worker'])

export function critterSleepMode(): 'off' | 'forced' | 'live' {
  const env = flagEnv('MERCURY_CRITTER_SLEEP')
  if (env === '0') return 'off'
  if (env === '1') return 'forced'
  return 'live'
}

export interface AgentActivity {
  liveNow: boolean
  lastEventTs: number
}

const NO_AGENTS: AgentActivity = { liveNow: false, lastEventTs: 0 }

export function agentsActiveNow(): boolean {
  try {
    return listExecutions(processMainOwner(), { liveOnly: true }).some(r =>
      AGENT_EXECUTION_KINDS.has(r.spec.kind),
    )
  } catch {
    return false
  }
}

export function signalsActive(s: CompanionTurnSignals): boolean {
  return s.turnLive || s.streaming || s.awaitingPermission
}

export function lastActivityTs(
  s: CompanionTurnSignals,
  baselineTs: number,
  now: number,
  agents: AgentActivity = NO_AGENTS,
): number {
  if (signalsActive(s) || agents.liveNow) return now
  return Math.max(baselineTs, s.lastTurnEndTs ?? 0, agents.lastEventTs)
}

export function isAsleepAt(
  s: CompanionTurnSignals,
  baselineTs: number,
  now: number,
  agents: AgentActivity = NO_AGENTS,
): boolean {
  return now - lastActivityTs(s, baselineTs, now, agents) >= SLEEP_AFTER_MS
}


const listeners = new Set<() => void>()
let unsubSignals: (() => void) | null = null
let unsubExec: (() => void) | null = null
let unsubClock: (() => void) | null = null
let unsubSwitch: (() => void) | null = null
let baselineTs = Date.now()
let lastAgentEventTs = 0
let sleepSince = 0
let sessionKey = ''
let swayAnchor: SwayAnchor = { phase: 0, at: 0 }

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

function ensureSession(): void {
  const sid = getSessionId() || 'boot'
  if (sid === sessionKey) return
  sessionKey = sid
  baselineTs = Date.now()
  sleepSince = 0
}

function armClock(): void {
  const want =
    listeners.size > 0 &&
    critterSleepMode() === 'live' &&
    (sleepSince === 0 || daemonCrewLivenessSync().engaged)
  if (want === (unsubClock !== null)) return
  if (want) unsubClock = subscribeUiClock(SLEEP_CHECK_MS, () => recompute())
  else {
    unsubClock?.()
    unsubClock = null
  }
}

function recompute(): void {
  ensureSession()
  const mode = critterSleepMode()
  const now = Date.now()
  let next: number
  if (mode === 'off') next = 0
  else if (mode === 'forced') next = sleepSince || now
  else {
    const agents: AgentActivity = {
      liveNow: agentsActiveNow() || daemonCrewLivenessSync().workersActive,
      lastEventTs: lastAgentEventTs,
    }
    next = isAsleepAt(companionTurnSignals(), baselineTs, now, agents) ? sleepSince || now : 0
  }
  if (next !== sleepSince) {
    swayAnchor = { phase: swayPhaseAt(now, sleepSince !== 0, swayAnchor), at: now }
    sleepSince = next
    armClock()
    emit()
    return
  }
  armClock()
}

export function noteCritterRealActivity(): void {
  lastAgentEventTs = Date.now()
  recompute()
}

export function critterSleepSince(): number {
  return sleepSince
}

export function critterSwayAnchor(): SwayAnchor {
  return swayAnchor
}

export function isCritterAsleep(): boolean {
  return sleepSince !== 0
}

export function critterLiveFrameKey(now: number = Date.now()): string {
  return critterFrameKey(now, sleepSince !== 0, swayAnchor, sleepSince)
}

export function subscribeCritterSleep(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    unsubSignals = subscribeCompanionSignals(() => recompute())
    unsubExec = subscribeExecutionEvents(ev => {
      const record = 'record' in ev.event ? ev.event.record : undefined
      if (!record || !AGENT_EXECUTION_KINDS.has(record.spec.kind)) return
      lastAgentEventTs = Date.now()
      recompute()
    })
    unsubSwitch = onSessionSwitch(() => recompute())
    recompute()
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      unsubSignals?.()
      unsubSignals = null
      unsubExec?.()
      unsubExec = null
      unsubSwitch?.()
      unsubSwitch = null
      unsubClock?.()
      unsubClock = null
    }
  }
}

export function critterSleepStatsForProofs(): {
  listeners: number
  clockArmed: boolean
  signalsArmed: boolean
  execArmed: boolean
  asleep: boolean
} {
  return {
    listeners: listeners.size,
    clockArmed: unsubClock !== null,
    signalsArmed: unsubSignals !== null,
    execArmed: unsubExec !== null,
    asleep: sleepSince !== 0,
  }
}

export function resetCritterSleepForTests(nowMs: number = Date.now()): void {
  sleepSince = 0
  baselineTs = nowMs
  lastAgentEventTs = 0
  sessionKey = getSessionId() || 'boot'
  swayAnchor = { phase: 0, at: 0 }
  emit()
}
