
import { useSyncExternalStore } from 'react'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { crewEnabled } from '../daemon/crewSpawn.js'
import { serialCoalescer, type SerialCoalescer } from '../services/workbench/serialCoalescer.js'
import {
  listWorkflowRuns,
  type WorkflowRunManifest,
} from '../tools/WorkflowTool/runManifest.js'
import {
  crewRosterStatus,
  crewUnreadCounts,
  listCrewMembers,
} from '../utils/crew/crewClient.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getGitState, subscribeGitFacts, type GitRepoState } from '../utils/git.js'
import { getTaskListId, listTasks, onTasksUpdated, type Task } from '../utils/tasks.js'
import {
  fleetGauge,
  traceSnapshot,
} from '../utils/cockpit/index.js'
import { subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { subscribeExecutionEvents } from '../services/primitives/executionPlane.js'

const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))

const TRANSCRIPT_DEBOUNCE_MS = 500
const HEARTBEAT_MS = 15_000
const WORKFLOWS_DISK_MAX = 10

export interface CrewGlanceMember {
  name: string
  model?: string
  online: boolean
  unread: number
}

export interface TelemetrySnapshots {
  git: GitRepoState | null
  tasks: Task[]
  fleet: { state: string; team?: string | null; conflicts: number; drifting: number }
  fleetFull: Awaited<ReturnType<typeof fleetGauge>> | null
  trace: Awaited<ReturnType<typeof traceSnapshot>> | null
  workflowsDisk: Array<WorkflowRunManifest & { mtimeMs: number }>
  crew: CrewGlanceMember[] | null
  refreshedAt: number
  version: number
}

let snapshots: TelemetrySnapshots = {
  git: null,
  tasks: [],
  fleet: { state: 'off', conflicts: 0, drifting: 0 },
  fleetFull: null,
  trace: null,
  workflowsDisk: [],
  crew: null,
  refreshedAt: 0,
  version: 0,
}

const listeners = new Set<() => void>()
let heartbeat: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let unsubTranscript: (() => void) | null = null
let unsubTasks: (() => void) | null = null
let unsubExecutions: (() => void) | null = null
let unsubGitFacts: (() => void) | null = null
let coalescer: SerialCoalescer | null = null

function emit(): void {
  fluxMark('telemetry:emit')
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[telemetryBus] listener threw (ignored): ${e}`)
    }
  }
}

async function gitStateForRefresh(): Promise<GitRepoState | null> {
  return getGitState({ untrackedFiles: 'normal' })
}

async function refreshOnce(): Promise<void> {
  const next: Partial<TelemetrySnapshots> = {}
  next.crew = null
  await Promise.all([
    gitStateForRefresh()
      .then(g => {
        next.git = g
      })
      .catch(() => {}),
    listTasks(getTaskListId())
      .then(t => {
        next.tasks = t
      })
      .catch(() => {
        next.tasks = []
      }),
    fleetGauge()
      .then(s => {
        next.fleetFull = s
        next.fleet = {
          state: s.state,
          team: s.data.teamName,
          conflicts: s.data.conflicts.length,
          drifting: s.data.health.filter(h => h.state === 'drifting').length,
        }
      })
      .catch(() => {}),
    listWorkflowRuns(getCwd(), { limit: WORKFLOWS_DISK_MAX * 5 })
      .then(runs => {
        next.workflowsDisk = runs
          .filter(m => m.status === 'running' || m.status === 'paused')
          .slice(0, WORKFLOWS_DISK_MAX)
      })
      .catch(() => {}),
    traceSnapshot()
      .then(s => {
        next.trace = s
      })
      .catch(() => {}),
    crewEnabled()
      ? (async () => {
          const members = await listCrewMembers()
          if (members.length === 0) return
          const [status, unread] = await Promise.all([
            crewRosterStatus(members.map(m => m.name)),
            crewUnreadCounts(),
          ])
          next.crew = members.map(m => ({
            name: m.name,
            model: m.model,
            online: status.has(m.name),
            unread: unread.get(m.name) ?? 0,
          }))
        })().catch(() => {})
      : Promise.resolve(),
  ])
  const kept: Partial<TelemetrySnapshots> = {}
  for (const key of Object.keys(next) as Array<keyof TelemetrySnapshots>) {
    const prev = snapshots[key]
    const fresh = next[key]
    if (jsonStringify(prev) === jsonStringify(fresh)) {
      continue
    }
    ;(kept as Record<string, unknown>)[key as string] = fresh
  }
  snapshots = {
    ...snapshots,
    ...kept,
    refreshedAt: Date.now(),
    version: snapshots.version + 1,
  }
  emit()
}

export function pokeTelemetry(): void {
  if (listeners.size === 0) return
  coalescer?.poke()
}

function scheduleDebounced(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    pokeTelemetry()
  }, TRANSCRIPT_DEBOUNCE_MS)
  debounceTimer.unref?.()
}

function startEngine(): void {
  if (heartbeat) return
  coalescer = serialCoalescer(async () => {
    try {
      await refreshOnce()
    } catch (e) {
      logForDebugging(`[telemetryBus] refresh failed (dropped): ${e}`)
    }
  }, 'telemetry')
  heartbeat = setInterval(() => pokeTelemetry(), HEARTBEAT_MS)
  heartbeat.unref?.()
  unsubTranscript = subscribeFocusedRecords(() => scheduleDebounced())
  unsubTasks = onTasksUpdated(() => scheduleDebounced())
  unsubExecutions = subscribeExecutionEvents(() => scheduleDebounced())
  unsubGitFacts = subscribeGitFacts(() => pokeTelemetry())
  pokeTelemetry()
}

function stopEngine(): void {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  unsubTranscript?.()
  unsubTranscript = null
  unsubTasks?.()
  unsubTasks = null
  unsubExecutions?.()
  unsubExecutions = null
  unsubGitFacts?.()
  unsubGitFacts = null
  coalescer?.release()
  coalescer = null
}

export function getTelemetry(): TelemetrySnapshots {
  return snapshots
}

export function subscribeTelemetry(listener: () => void): () => void {
  listeners.add(listener)
  startEngine()
  return () => {
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
      (unsubExecutions !== null ? 1 : 0) +
      (unsubGitFacts !== null ? 1 : 0),
    coalescer: coalescer !== null,
  }
}

export function useTelemetry(): TelemetrySnapshots
export function useTelemetry<T>(selector: (s: TelemetrySnapshots) => T): T
export function useTelemetry<T>(
  selector?: (s: TelemetrySnapshots) => T,
): T | TelemetrySnapshots {
  const getSelected: () => T | TelemetrySnapshots = selector
    ? () => selector(snapshots)
    : getTelemetry
  return useSyncExternalStore(subscribeTelemetry, getSelected, getSelected)
}
