
import { useSyncExternalStore } from 'react'
import { hasSeatLive } from '../../engine/connector/seatLive.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { serialCoalescer, type SerialCoalescer } from '../workbench/serialCoalescer.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { getGitState, subscribeGitFacts, type GitRepoState } from '../../platform/git/git.js'
import type { MissionRowV1 } from '../../engine/connector/types.js'
import {
  fleetGauge,
  traceSnapshot,
} from '../cockpit-gauges/index.js'
import { subscribeThroughFocused, getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import { subscribeExecutionEvents } from '../../engine/execution-plane/executionPlane.js'
import { readSessionWorkersSnapshot, workerPidAlive } from '../../daemon/concourse-workers/concourseWorkers.js'
import { subscribeConcourseDelta } from '../../daemon/concourse-workers/store.js'
import { runnerRecordAlive } from '../../engine/connector/workCounts.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'
import { getInvocationTracePath } from '../../platform/observability/invocationTrace.js'
import { subscribeStorageFile } from '../../sessions/transcripts/fileWatch.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { afterMicrotask, startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { keysOf } from '../../platform/primitives/entriesOf.js'

const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))

const TRANSCRIPT_DEBOUNCE_MS = 500
const HEARTBEAT_MS = 15_000
const subscribeFocusedWork = subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))
const subscribeFocusedLive = subscribeThroughFocused((connector, listener) => (hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {}))

export type SessionGlanceSnapshot =
  | { state: 'unavailable' }
  | { state: 'known'; rows: Array<{ sessionId: string; live: boolean; paused: boolean; parked: boolean; stopped: boolean }> }

export interface VitalsSnapshots {
  sessions: SessionGlanceSnapshot
  git: GitRepoState | null
  tasks: readonly MissionRowV1[]
  fleet: { state: string; crew?: string | null; conflicts: number; drifting: number }
  fleetFull: Awaited<ReturnType<typeof fleetGauge>> | null
  trace: Awaited<ReturnType<typeof traceSnapshot>> | null
  refreshedAt: number
  version: number
}

let snapshots: VitalsSnapshots = {
  sessions: { state: 'unavailable' },
  git: null,
  tasks: [],
  fleet: { state: 'off', conflicts: 0, drifting: 0 },
  fleetFull: null,
  trace: null,
  refreshedAt: 0,
  version: 0,
}

const listeners = new Set<() => void>()
let sessionConsumers = 0
let heartbeat: (() => void) | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let unsubTranscript: (() => void) | null = null
let unsubTasks: (() => void) | null = null
let unsubLive: (() => void) | null = null
let unsubExecutions: (() => void) | null = null
let unsubGitFacts: (() => void) | null = null
let unsubWorkers: (() => void) | null = null
let unsubTrace: (() => void) | null = null
let coalescer: SerialCoalescer | null = null

function emit(): void {
  fluxMark('vitals:emit')
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[vitalsBus] listener threw (ignored): ${e}`)
    }
  }
}

async function gitStateForRefresh(): Promise<GitRepoState | null> {
  return getGitState({ untrackedFiles: 'normal' })
}

async function refreshOnce(): Promise<void> {
  const next: Partial<VitalsSnapshots> = {}
  if (sessionConsumers > 0) {
    const sessions = readSessionWorkersSnapshot()
    const sessionRows = sessions.state === 'known' ? Object.values(sessions.workers) : null
    next.sessions = sessionRows !== null && sessionRows.every(rec => typeof rec.sessionId === 'string' && rec.sessionId !== '')
      ? { state: 'known', rows: sessionRows.map(rec => ({ sessionId: rec.sessionId, live: runnerRecordAlive(rec, () => workerPidAlive(rec)), paused: rec.pausedAt !== undefined, parked: rec.parkedAt !== undefined, stopped: rec.stoppedAt !== undefined })) }
      : { state: 'unavailable' }
  }
  await Promise.all([
    gitStateForRefresh()
      .then(g => {
        next.git = g
      })
      .catch(passedOver),
    afterMicrotask(() => {
        next.tasks = hasFocusedSession() ? getFocusedSessionConnector().workRoster().mission : []
      })
      .catch(() => {
        next.tasks = []
      }),
    fleetGauge()
      .then(s => {
        next.fleetFull = s
        next.fleet = { state: s.state, crew: null, conflicts: 0, drifting: 0 }
      })
      .catch(passedOver),
    traceSnapshot()
      .then(s => {
        next.trace = s
      })
      .catch(passedOver),
  ])
  const kept: Partial<VitalsSnapshots> = {}
  for (const key of keysOf(next)) {
    const prev = snapshots[key]
    const fresh = next[key]
    if (jsonStringify(prev) === jsonStringify(fresh)) {
      continue
    }
    ;(kept as Record<string, unknown>)[key] = fresh
  }
  if (snapshots.version > 0 && Object.keys(kept).length === 0) return
  snapshots = {
    ...snapshots,
    ...kept,
    refreshedAt: Date.now(),
    version: snapshots.version + 1,
  }
  emit()
}

export function pokeVitals(): void {
  if (listeners.size === 0) return
  coalescer?.poke()
}

function scheduleDebounced(): void {
  if (debounceTimer) stopTimeout(debounceTimer)
  debounceTimer = startTimeout(() => {
    debounceTimer = null
    pokeVitals()
  }, TRANSCRIPT_DEBOUNCE_MS)
  debounceTimer.unref?.()
}

function startEngine(): void {
  if (heartbeat) return
  coalescer = serialCoalescer(async () => {
    try {
      await refreshOnce()
    } catch (e) {
      logForDebugging(`[vitalsBus] refresh failed (dropped): ${e}`)
    }
  }, 'vitals')
  heartbeat = subscribeUiClock(HEARTBEAT_MS, () => pokeVitals())
  unsubTranscript = subscribeFocusedRecords(() => scheduleDebounced())
  unsubTasks = subscribeFocusedWork(() => scheduleDebounced())
  unsubLive = subscribeFocusedLive(() => scheduleDebounced())
  unsubExecutions = subscribeExecutionEvents(() => scheduleDebounced())
  unsubGitFacts = subscribeGitFacts(() => pokeVitals())
  unsubWorkers = subscribeConcourseDelta(() => pokeVitals())
  unsubTrace = subscribeStorageFile(getInvocationTracePath(), () => scheduleDebounced())
  pokeVitals()
}

function stopEngine(): void {
  if (heartbeat) {
    heartbeat()
    heartbeat = null
  }
  if (debounceTimer) {
    stopTimeout(debounceTimer)
    debounceTimer = null
  }
  unsubTranscript?.()
  unsubTranscript = null
  unsubTasks?.()
  unsubTasks = null
  unsubLive?.()
  unsubLive = null
  unsubExecutions?.()
  unsubExecutions = null
  unsubGitFacts?.()
  unsubGitFacts = null
  unsubWorkers?.()
  unsubWorkers = null
  unsubTrace?.()
  unsubTrace = null
  coalescer?.release()
  coalescer = null
}

export function getVitals(): VitalsSnapshots {
  return snapshots
}

export function subscribeVitals(listener: () => void, sessions = false): () => void {
  if (sessions) sessionConsumers++
  listeners.add(listener)
  startEngine()
  if (sessions && sessionConsumers === 1) pokeVitals()
  return () => {
    if (sessions) sessionConsumers--
    listeners.delete(listener)
    if (listeners.size === 0) stopEngine()
  }
}

export function _statsForProofs(): {
  listeners: number
  heartbeat: boolean
  debounceTimer: boolean
  sourceUnsubs: number
  coalescer: boolean
} {
  return {
    listeners: listeners.size,
    heartbeat: heartbeat !== null,
    debounceTimer: debounceTimer !== null,
    sourceUnsubs:
      (unsubTranscript !== null ? 1 : 0) +
      (unsubTasks !== null ? 1 : 0) +
      (unsubLive !== null ? 1 : 0) +
      (unsubExecutions !== null ? 1 : 0) +
      (unsubGitFacts !== null ? 1 : 0) +
      (unsubWorkers !== null ? 1 : 0) +
      (unsubTrace !== null ? 1 : 0),
    coalescer: coalescer !== null,
  }
}

export function _publishVitalsForProofs(next: Partial<VitalsSnapshots>): void {
  snapshots = { ...snapshots, ...next, refreshedAt: Date.now(), version: snapshots.version + 1 }
  emit()
}

export function useVitals(): VitalsSnapshots
export function useVitals<T>(selector: (s: VitalsSnapshots) => T): T
export function useVitals<T>(
  selector?: (s: VitalsSnapshots) => T,
): T | VitalsSnapshots {
  const getSelected: () => T | VitalsSnapshots = selector
    ? () => selector(snapshots)
    : getVitals
  return useSyncExternalStore(subscribeVitals, getSelected, getSelected)
}
