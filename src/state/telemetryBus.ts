/**
 * telemetryBus — ONE event-driven snapshot scheduler for the cockpit vitals
 * (HANDOFF-REACTIVE-SUBSTRATE Phase 3c).
 *
 * Before: DeckPane re-fetched git/tasks/fleet/trace/roster on its own 5s
 * setInterval (frame and deck could "momentarily disagree" for 5s), while
 * HelmTelemetryRail read the trace ONCE on mount and went stale forever.
 *
 * Now: one shared store refreshes the async snapshot family when something
 * that MOVES the vitals happens —
 *   - the focused chat's records moving (turn activity: git/tasks/trace
 *     move at turn boundaries; coalesced with a debounce so streaming
 *     deltas batch — the subscription rides the focused slot, so a hop
 *     re-attaches it to the session on screen),
 *   - a task-store change signal (TaskCreate/Update land instantly),
 *   - a slow HEARTBEAT (15s, only while someone is subscribed) as the
 *     documented fallback for out-of-band movement (another session's fires,
 *     quota drift).
 * Every subscribed surface reads the SAME snapshot object, so two vitals
 * surfaces can never disagree about the substrate they describe.
 *
 * Consumers: useTelemetry() (useSyncExternalStore). Refreshes never throw and
 * never overlap (a refresh requested mid-refresh coalesces into one trailing
 * re-run). pokeTelemetry() forces a refresh (command surfaces after mutations).
 */

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
import { getGitState, type GitRepoState } from '../utils/git.js'
import { getTaskListId, listTasks, onTasksUpdated, type Task } from '../utils/tasks.js'
import {
  fleetGauge,
  traceSnapshot,
} from '../utils/cockpit/index.js'
import { subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { subscribeExecutionEvents } from '../services/primitives/executionPlane.js'

/** The focused chat's records door, composed through the slot (module-stable). */
const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) => connector.subscribeRecords(listener))

/** Debounce for records-driven refreshes (a streaming turn emits bursts). */
const TRANSCRIPT_DEBOUNCE_MS = 500
/** The slow fallback heartbeat — runs only while subscribers exist. */
const HEARTBEAT_MS = 15_000
/** Cap the disk-manifest sweep — the board caps its sections anyway. */
const WORKFLOWS_DISK_MAX = 10

/** One daemon-crew teammate for the cockpit CREW lane (the /teammates
 *  board's exact sources: team file identity · control-socket liveness ·
 *  lead-inbox unread scan). */
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
  /** The full fleet gauge (roster/leases/conflicts) — /monitor's live feed. */
  fleetFull: Awaited<ReturnType<typeof fleetGauge>> | null
  trace: Awaited<ReturnType<typeof traceSnapshot>> | null
  /**
   * running/paused run.json manifests from disk — this process's runs
   * INCLUDED; consumers dedup vs local AppState and classify external/wedged
   * (pid + mtime liveness).
   */
  workflowsDisk: Array<WorkflowRunManifest & { mtimeMs: number }>
  /**
   * Daemon-crew teammates (/teammates' NAMED long-lived workers) — null when
   * crew is disabled or no team file exists. An unreachable daemon reports
   * every member offline (crewClient's honest-empty contract), never a stale
   * "online". Durable chats survive daemon death, so members stay listed.
   */
  crew: CrewGlanceMember[] | null
  /** Wall-clock stamp of the last completed refresh (drives "↻ Ns ago"). */
  refreshedAt: number
  /** Monotonic refresh counter — bumps once per completed refresh batch. */
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
/** The execution plane's event edge — a registered/settled agent execution
 *  moves the fleet roster without waiting for the heartbeat. */
let unsubExecutions: (() => void) | null = null
/** Minted per engine start, released in stopEngine — a released lane is
 *  terminal, so reusing one across a stop/start would go silently dead. */
let coalescer: SerialCoalescer | null = null

function emit(): void {
  fluxMark('telemetry:emit') // probe-gated ring stamp (off ⇒ no-op)
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[telemetryBus] listener threw (ignored): ${e}`)
    }
  }
}

async function refreshOnce(): Promise<void> {
  const next: Partial<TelemetrySnapshots> = {}
  // Default-clear the crew glance (off / dissolved ⇒ null): the
  // `{...snapshots, ...next}` merge below would otherwise RETAIN the last
  // snapshot forever.
  next.crew = null
  await Promise.all([
    getGitState()
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
    // Bounded: the chip keeps at most WORKFLOWS_DISK_MAX
    // running/paused rows, and live rows re-stamp their heartbeat every 15s
    // — the newest-by-mtime window contains them. Reading lifetime history
    // to keep ten rows cost 85MB + 20k fs ops at 10k historical runs.
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
    // Crew glance: identity is a team-file read (near-free, [] when absent);
    // liveness is ONE control-socket RPC (fail-fast when no daemon) and the
    // unread scan is a mailbox read — only paid when members exist. Cleared
    // by the default below when crew is off or the team dissolves.
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
  // Source-scoped dirty flags: a slice whose freshly fetched
  // value is deep-equal to the current one KEEPS ITS OBJECT IDENTITY — the
  // old shape minted seven fresh slice objects on every refresh, so no
  // consumer could bail on an unmoved slice. Selector consumers now bail
  // via Object.is.
  //
  // K4 CORRECTION: the original clause also skipped
  // the notify when NOTHING moved. That severed the rails' repaint pulse:
  // they render sync-read caches with no subscription of their own
  // (quotaWindows()), which stayed on-screen fresh
  // only because this heartbeat repainted their reader. An idle cockpit
  // froze, and late-landing usage rows were born on the next CLICK's render
  // — shifting rows mid-gesture (the diffws pointer prover caught the
  // mistarget live). The notify always fires; unmoved slices keep identity
  // so the pulse stays cheap for any selector consumer.
  const kept: Partial<TelemetrySnapshots> = {}
  for (const key of Object.keys(next) as Array<keyof TelemetrySnapshots>) {
    const prev = snapshots[key]
    const fresh = next[key]
    if (jsonStringify(prev) === jsonStringify(fresh)) {
      // unchanged — drop the fresh object so the slice identity holds
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

/** Refresh now (serialized; a request mid-refresh coalesces into one re-run). */
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
  // The catch stays INSIDE the run body so a failed refresh keeps behaving
  // exactly as the inlined do/while did: logged, and the generation counted.
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
  pokeTelemetry() // initial fill
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
  // Terminal — drop the handle so the next startEngine mints a live one.
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

/**
 * TEST-ONLY: the engine's live resources, for the lifecycle census (the
 * fileStore `_statsForProofs` precedent). Counts and flags only.
 */
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
      (unsubTranscript !== null ? 1 : 0) + (unsubTasks !== null ? 1 : 0) + (unsubExecutions !== null ? 1 : 0),
    coalescer: coalescer !== null,
  }
}

/** Subscribe a component to the shared cockpit vitals. With a selector the
 *  component re-renders only when ITS slice moves: slice
 *  objects keep their identity across no-op refreshes, so Object.is on the
 *  selected value bails for every unmoved slice. */
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
