// ============================================================================
//  repoHost/runWatch — Family 2: cancellable workflow-run watching ON
//  THE EXECUTION PLANE. A watch is a first-class execution (kind
//  'host-run-watch', census-classified full-execution-owner): it registers
//  running, polls `gh run view` serially (fresh — never the TTL cache), and
//  settles from the OBSERVED conclusion. It never blocks typing or
//  rendering — the caller gets the record back immediately and follows via
//  the plane (RUNS lane · /tasks · Git op:"runWatch" status reads).
//
//  Laws:
//    · serial polling — one in-flight gh call per watch, so a slow older
//      response can never overwrite a newer one (latest-request-wins by
//      construction);
//    · bounded lifetime — MAX_WATCH_MS hard cap settles 'failed' with a
//      named timeout reason, never a silent immortal loop;
//    · consecutive poll failures settle 'failed' with the gh note;
//    · plane stop (requestStopExecution) aborts the loop and settles
//      'stopped'; owner disposal reaps via the same hook;
//    · one watch per (owner, run id) — re-watching a settled run registers
//      a new generation; a LIVE watch answers with the existing record.
// ============================================================================

import {
  registerExecution,
  registerExecutionDomain,
  requestStopExecution,
  settleExecution,
  getExecution,
} from '../primitives/executionPlane.js'
import type { ExecutionRecord } from '../primitives/execution.js'
import { registerOwnerDisposer, unregisterOwnerDisposer } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { fetchRun, repoHostEnabled, type RunView } from './repoHost.js'

const POLL_MS = 5_000
const MAX_WATCH_MS = 30 * 60 * 1000
const MAX_POLL_FAILURES = 3

interface LiveWatch {
  owner: OwnerKey
  id: string
  runId: string
  root: string
  stopRequested: boolean
  last: RunView | null
  timer: ReturnType<typeof setTimeout> | null
}

const liveWatches = new Map<string, LiveWatch>()

function watchKey(owner: OwnerKey, id: string): string {
  return `${owner}␟${id}`
}

// The domain hooks: liveness truth is the in-process map; plane stop flips
// the flag (the loop settles 'stopped' on its next tick or immediately if
// parked on a timer).
registerExecutionDomain('host-run-watch', {
  reconcile(record) {
    const live = liveWatches.get(watchKey(record.spec.owner, record.spec.id))
    if (live) return null // running as recorded
    return { state: 'failed', outcome: { reason: 'watch loop not present in this process' } }
  },
  requestStop(record) {
    const live = liveWatches.get(watchKey(record.spec.owner, record.spec.id))
    if (!live) return
    live.stopRequested = true
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
      finishWatch(live, 'stopped', 'stopped by request')
    }
  },
})

function finishWatch(watch: LiveWatch, state: 'succeeded' | 'failed' | 'stopped', reason: string): void {
  liveWatches.delete(watchKey(watch.owner, watch.id))
  unregisterOwnerDisposer(watch.owner, `run-watch:${watch.id}`)
  try {
    settleExecution(watch.owner, watch.id, state, { outcome: { reason } })
  } catch {
    /* an already-settled record (races a stop) stays settled — idempotent */
  }
}

export interface RunWatchStart {
  state: 'watching'
  record: ExecutionRecord
  /** The latest observed view (null until the first poll lands). */
  view: RunView | null
}

export type RunWatchOutcome = RunWatchStart | { state: 'unavailable'; note: string; remedy: string }

/**
 * Start (or join) a cancellable watch on one workflow run. Returns
 * IMMEDIATELY with the execution record — the poll loop lives on the
 * execution plane. Joining a live watch returns the existing record.
 */
export async function watchRun(owner: OwnerKey, root: string, runId: string): Promise<RunWatchOutcome> {
  if (!repoHostEnabled()) {
    return {
      state: 'unavailable',
      note: 'repository-host reads are disabled (MERCURY_REPO_HOST=0)',
      remedy: 'unset MERCURY_REPO_HOST to watch runs',
    }
  }
  const id = `run-watch-${runId}`
  const existing = liveWatches.get(watchKey(owner, id))
  if (existing) {
    const record = getExecution(owner, id)
    if (record) return { state: 'watching', record, view: existing.last }
  }

  // First observation BEFORE registering: a run that does not exist (or a
  // missing gh) never mints an execution record.
  const first = await fetchRun(root, runId, { fresh: true })
  if (first.state !== 'ok') return first

  const record = registerExecution({
    owner,
    id,
    kind: 'host-run-watch',
    label: `gh run ${runId}${first.run.workflow ? ` (${first.run.workflow})` : ''}`,
    lifecycle: 'owner',
    cwd: root,
    startedBy: 'Git op:runWatch',
    metadata: { runId, workflow: first.run.workflow, title: first.run.title },
    initialState: 'running',
  })
  const watch: LiveWatch = { owner, id, runId, root, stopRequested: false, last: first.run, timer: null }
  liveWatches.set(watchKey(owner, id), watch)
  // Owner-wide teardown (/clear · session switch · process teardown) reaps
  // the poll loop through the ONE lifecycle registry — a disposed owner must
  // never keep spawning gh polls (the closing-wave leak).
  registerOwnerDisposer(owner, `run-watch:${id}`, () => {
    const live = liveWatches.get(watchKey(owner, id))
    if (!live) return
    live.stopRequested = true
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
    }
    liveWatches.delete(watchKey(owner, id))
  })

  if (first.run.status === 'completed') {
    finishWatch(watch, first.run.conclusion === 'success' ? 'succeeded' : 'failed', `conclusion: ${first.run.conclusion || 'unknown'}`)
    return { state: 'watching', record: getExecution(owner, id) ?? record, view: first.run }
  }

  const startedAt = Date.now()
  let pollFailures = 0
  const tick = async (): Promise<void> => {
    watch.timer = null
    if (watch.stopRequested) {
      finishWatch(watch, 'stopped', 'stopped by request')
      return
    }
    if (Date.now() - startedAt > MAX_WATCH_MS) {
      finishWatch(watch, 'failed', `watch timeout after ${Math.round(MAX_WATCH_MS / 60000)}min — the run may still be in progress on the host`)
      return
    }
    const view = await fetchRun(root, runId, { fresh: true })
    if (watch.stopRequested) {
      finishWatch(watch, 'stopped', 'stopped by request')
      return
    }
    if (view.state !== 'ok') {
      pollFailures++
      if (pollFailures >= MAX_POLL_FAILURES) {
        finishWatch(watch, 'failed', `${MAX_POLL_FAILURES} consecutive poll failures: ${view.note}`)
        return
      }
    } else {
      pollFailures = 0
      watch.last = view.run
      if (view.run.status === 'completed') {
        finishWatch(watch, view.run.conclusion === 'success' ? 'succeeded' : 'failed', `conclusion: ${view.run.conclusion || 'unknown'}`)
        return
      }
      // Settled externally (stop/dispose) while the poll was in flight —
      // the loop ends without re-arming.
      if (!liveWatches.has(watchKey(owner, id))) return
    }
    watch.timer = setTimeout(() => void tick(), POLL_MS)
    watch.timer.unref?.()
  }
  watch.timer = setTimeout(() => void tick(), POLL_MS)
  watch.timer.unref?.()

  return { state: 'watching', record, view: first.run }
}

/** Cancel a live watch (the Git op surface; plane stop works identically). */
export function cancelRunWatch(owner: OwnerKey, runId: string): ExecutionRecord | undefined {
  return requestStopExecution(owner, `run-watch-${runId}`)
}

/** TEST-ONLY: reap every live watch (proof harnesses). */
export function _resetRunWatchesForTesting(): void {
  for (const watch of liveWatches.values()) {
    if (watch.timer) clearTimeout(watch.timer)
  }
  liveWatches.clear()
}
