// ============================================================================
//  services/concourse/crossProjectPings — THE CROSS-PROJECT PING (cross-
//  project awareness, law 5 — the operator: "there should be a
//  ping for when another project's agent finished work — the live session
//  manager would have a small ping saying 'switch to <project>' to check on
//  your agent there").
//
//  A session in ANOTHER project that needs you already pings: its ask is a
//  durable needs-you obligation, the attention estate counts it, PINGS's
//  engine rings it once, and the board's rail rows it — this lane only
//  makes that row a DOOR (the builder marks the row's project, the screen's
//  ↵ switches and opens). A session in another project that FINISHES a run
//  had no owner fact of its own: this module mints one, through the
//  obligations owner's existing door, as a needs-you obligation of ONE new
//  kind — `cross-project:finished:<sessionId>:<settledAt>` — so the ⚑ badge
//  counts it like any need, the engine rings it once per subject, the host
//  toast names it, and the rail's ↵ is the door (switch + focus, and the
//  need settles). ONCE PER NEED, NEVER A NAG: the ref is the settle stamp,
//  so the same finish never re-mints (a settled row's ref is remembered by
//  the sweep's own seen-map, not re-read from the store); a NEW settle of
//  the same session is a new need. SEED-SILENT: the first beat records
//  every session's standing stamp and mints nothing — a boot never pings
//  old news (the count line says "N finished" regardless). A finish in the
//  CURRENT project is never minted: it is a row on the board, in front of
//  you. The watch lives in the visible process beside the ping engine
//  (mounted with the REPL beneath every face — a chat-bound operator still
//  hears it), reads the daemon's delta stamp + a bounded tick, and only
//  where the concourse exists (the plain world has no board to switch on).
// ============================================================================

import { dirname, basename } from 'node:path'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { concourseDeltaPath, readSessionWorkers, type ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import { currentProject, inProject, projectDisplayName, type ProjectIdentity } from '../../utils/bootCardFacts.js'
import { logForDebugging } from '../../utils/debug.js'

/** The one new obligation kind's ref prefix — the rail, the route and the
 *  host toast branch on it; the tail is `<sessionId>:<settledAt>`. */
export const CROSS_PROJECT_FINISHED_REF = 'cross-project:finished:'

export function isCrossProjectFinishedRef(ref: string | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(CROSS_PROJECT_FINISHED_REF)
}

/** A FINISH: a live record whose last turn settled at or after its last
 *  delivery — the board's ready-to-review truth, read from the record. */
export function finishedStampOf(rec: ConcourseWorkerRecordV1, alive: boolean): number | undefined {
  if (rec.endedAt !== undefined || !alive) return undefined
  if (rec.attachedAt !== undefined || rec.stoppedAt !== undefined || rec.pausedAt !== undefined || rec.crash !== undefined) return undefined
  // A PARKED record (the reactivation lifecycle's state) is a closed chat,
  // never a finish to review — read the stamp the daemon writes (the field
  // is duck-typed until that lane's fold lands the spelling on the record).
  if ((rec as { parkedAt?: number }).parkedAt !== undefined) return undefined
  if (rec.lastTurnSettledAt === undefined) return undefined
  if (rec.lastDeliveryAt !== undefined && rec.lastTurnSettledAt < rec.lastDeliveryAt) return undefined
  return rec.lastTurnSettledAt
}

export interface CrossProjectMint {
  ref: string
  sessionId: string
  question: string
  /** The project the session belongs to (the door's target). */
  dir: string
  name: string
}

export interface FinishSweepDeps {
  records: () => ConcourseWorkerRecordV1[]
  current: () => ProjectIdentity
  isAlive: (pid: number) => boolean
  /** The sweep's memory: sessionId → the newest settle stamp seen. */
  seen: Map<string, number>
}

/**
 * ONE BEAT of the sweep, pure over its deps: the first beat SEEDS the memory
 * (every session's standing stamp, every project) and mints nothing; every
 * later beat mints exactly the finishes newer than the memory, in projects
 * other than the current one. The memory moves for EVERY session (a finish
 * you watched in its own project never pings after you switch away), and
 * forgets sessions that left the roster. Returns what to mint.
 */
export function sweepCrossProjectFinishes(deps: FinishSweepDeps): CrossProjectMint[] {
  const recs = deps.records().filter(r => r.endedAt === undefined)
  const live = new Set(recs.map(r => r.sessionId))
  // The roster purge must never eat the SEEDED SENTINEL - its NUL-prefixed
  // key is by construction never a sessionId, so the bare not-in-roster
  // sweep deleted it on every beat: `seeded` then read false forever, the
  // memory re-seeded each beat, and no finish ever minted (the sweep was
  // structurally dead).
  for (const id of [...deps.seen.keys()]) if (id !== SEEDED_SENTINEL && !live.has(id)) deps.seen.delete(id)
  const seeded = deps.seen.has(SEEDED_SENTINEL)
  const out: CrossProjectMint[] = []
  let current: ProjectIdentity | null = null
  for (const rec of recs) {
    const stamp = finishedStampOf(rec, rec.pid !== undefined && deps.isAlive(rec.pid))
    if (stamp === undefined) continue
    const prev = deps.seen.get(rec.sessionId)
    deps.seen.set(rec.sessionId, Math.max(prev ?? 0, stamp))
    if (!seeded) continue
    if (prev !== undefined && stamp <= prev) continue
    current ??= deps.current()
    if (inProject(current, rec.workspaceId)) continue
    const name = projectDisplayName(rec.workspaceId)
    const title = rec.title !== undefined && rec.title.length > 0 ? rec.title : rec.runnerId
    out.push({
      ref: `${CROSS_PROJECT_FINISHED_REF}${rec.sessionId}:${stamp}`,
      sessionId: rec.sessionId,
      question: `your agent in ${name} finished · ${title}`,
      dir: rec.workspaceId,
      name,
    })
  }
  if (!seeded) deps.seen.set(SEEDED_SENTINEL, 1)
  return out
}

/** The memory's first-beat marker - NUL-prefixed so no real sessionId can
 *  ever collide with it (the escape spelling lands a real NUL at runtime). */
const SEEDED_SENTINEL = '\u0000seeded'

/** The mint through the obligations owner's existing door: a needs-you
 *  obligation for the operator on the switchboard scope, idempotent by ref. */
async function mintCrossProjectFinish(m: CrossProjectMint): Promise<void> {
  const { upsertObligation } = await import('../crew/obligations.js')
  await upsertObligation({ ref: m.ref, sessionId: m.sessionId, question: m.question, owner: 'operator', scope: 'switchboard' })
}

export interface CrossProjectWatchHandle {
  dispose(): void
  /** Proof seam — the memory the sweep keeps. */
  _seenForTesting(): ReadonlyMap<string, number>
}

/**
 * The visible process's watch: one sweep per daemon delta stamp (push) and
 * per bounded tick (the fallback heartbeat), the first beat seeding
 * silently. `enabled` is the world's gate (the hook passes the strip's
 * plain-world fact): in `--chat` / the concourse switched off there is no
 * board to switch on, so no cross-project door is minted — the sessions
 * still run, the count line simply is not there either.
 */
export function startCrossProjectFinishWatch(
  opts: { recordsDir?: string; tickMs?: number; enabled?: () => boolean } = {},
): CrossProjectWatchHandle {
  const seen = new Map<string, number>()
  if (opts.enabled !== undefined && !opts.enabled()) {
    return { dispose: () => {}, _seenForTesting: () => seen }
  }
  let alive = true
  let busy = false
  const beat = (): void => {
    if (!alive || busy) return
    busy = true
    void (async () => {
      try {
        const mints = sweepCrossProjectFinishes({
          records: () => Object.values(readSessionWorkers(opts.recordsDir)),
          current: currentProject,
          isAlive: isProcessAlive,
          seen,
        })
        for (const m of mints) {
          if (!alive) break
          await mintCrossProjectFinish(m)
        }
      } catch (e) {
        logForDebugging(`[cross-project] finish sweep failed (next beat retries): ${e}`)
      } finally {
        busy = false
      }
    })()
  }
  let watcher: import('node:fs').FSWatcher | null = null
  void import('node:fs')
    .then(fs => {
      if (!alive) return
      const deltaPath = concourseDeltaPath(opts.recordsDir)
      const dir = dirname(deltaPath)
      const name = basename(deltaPath)
      try {
        fs.mkdirSync(dir, { recursive: true })
        watcher = fs.watch(dir, (_ev, file) => {
          if (file !== null && file !== name) return
          beat()
        })
        watcher.on('error', () => {
          try {
            watcher?.close()
          } catch {
            /* already closed */
          }
          watcher = null
        })
      } catch {
        /* no watcher on this transport — the tick still stands */
      }
    })
    .catch(() => {})
  const timer = setInterval(beat, opts.tickMs ?? 15_000)
  timer.unref?.()
  beat()
  return {
    dispose: () => {
      alive = false
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
        /* already closed */
      }
      watcher = null
    },
    _seenForTesting: () => seen,
  }
}
