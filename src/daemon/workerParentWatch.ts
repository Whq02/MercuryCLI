// ============================================================================
//  workerParentWatch — the WORKER→daemon death watch (the mirror of ownerWatch).
//
//  ownerWatch makes the auto-started DAEMON self-reap when its owning SESSION
//  dies. This is the symmetric backstop one level down: a daemon-spawned WORKER
//  (a crew teammate, a session worker) self-exits the instant its parent
//  DAEMON dies — so a worker can never outlive its supervisor.
//
//  Why it's needed even though the worker's stdin is a pipe from the daemon (so a
//  dead daemon already EOFs that pipe and the stream-json child exits): the EOF is
//  only noticed when the child next reads input. A worker SIGKILL'd... no — a
//  worker whose DAEMON is SIGKILL'd MID-TURN keeps running the current turn (it
//  isn't reading stdin then) and only exits on EOF AFTER the turn finishes — up to
//  a full turn of orphaned work + usage burn (notably on a 2nd account under the
//  /route split). This poll catches the dead parent within ~8s regardless of turn
//  state, so there is no orphaned-usage window.
//
//  Self-gating: armed ONLY when MERCURY_WORKER_PARENT_PID is present, which ONLY the
//  daemon's spawnStreamJsonChild stamps. The operator's foreground session never
//  carries it ⇒ armWorkerParentWatch() is a no-op there ⇒ byte-identical. Reuses
//  ownerWatch's isProcessAlive + decideOrphanShutdown (identical decision shape).
//  Pure-ish + loadable under `bun run` (no feature() macro / heavy deps).
// ============================================================================
import { isProcessAlive, decideOrphanShutdown } from './ownerWatch.js'
import { runCleanupFunctions } from '../utils/cleanupRegistry.js'

/** The env var spawnStreamJsonChild stamps with the spawning DAEMON's pid. */
export const WORKER_PARENT_PID_ENV = 'MERCURY_WORKER_PARENT_PID'

/** Poll cadence + grace (mirrors ownerWatch): exit after the parent is seen gone
 *  for N consecutive checks — a small grace so a momentary probe blip can't kill a
 *  worker under a live daemon. 4s × 2 ≈ 8s after the daemon dies. */
export const WORKER_WATCH_INTERVAL_MS = 4000
export const WORKER_WATCH_GRACE_CHECKS = 2

/** Parse the parent-daemon pid the spawn handed us, or null (⇒ not a spawned worker
 *  ⇒ the watch never arms). */
export function parseWorkerParentPid(env: NodeJS.ProcessEnv = process.env): number | null {
  // Either spelling: a pre-migration daemon stamps the retired
  // name; the canonical stamp wins when both are present.
  const raw = (env[WORKER_PARENT_PID_ENV] ?? env['MERCURY_WORKER_PARENT_PID'])?.trim()
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** The cap on the orphan exit's cleanup: past it the worker leaves anyway.
 *  Small — its supervisor is already gone and nothing can answer for it. */
export const WORKER_ORPHAN_CLEANUP_CAP_MS = 1_500

/** Run the cleanup registry, bounded, then exit 0. Never throws. */
async function orphanExit(opts: {
  exit: (code: number) => void
  cleanup: () => Promise<void>
  capMs?: number
}): Promise<void> {
  const capMs = opts.capMs ?? WORKER_ORPHAN_CLEANUP_CAP_MS
  let cap: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      opts.cleanup().catch(() => undefined),
      new Promise<void>(resolve => {
        cap = setTimeout(resolve, capMs)
      }),
    ])
  } catch {
    /* an exit is never held by a failing cleanup */
  } finally {
    if (cap) clearTimeout(cap)
  }
  opts.exit(0)
}

/** Proof seam: drive the orphan exit road with injected halves. */
export function __workerOrphanExitForTest(opts: {
  exit: (code: number) => void
  cleanup: () => Promise<void>
  capMs?: number
}): Promise<void> {
  return orphanExit(opts)
}

let armed = false

/**
 * Arm the worker→daemon parent-death watch. IDEMPOTENT (safe to call per-query —
 * arms once). No-op unless this process is a daemon-spawned worker (the parent-pid
 * env is present). When the parent daemon is absent for the grace window, exit(0) so
 * the worker never outlives its supervisor. The interval is unref'd so the watch
 * itself never keeps the worker alive. `exit`/`alive` injectable for unit tests.
 */
export function armWorkerParentWatch(
  opts: { exit?: (code: number) => void; alive?: (pid: number) => boolean } = {},
): boolean {
  if (armed) return false
  const parentPid = parseWorkerParentPid()
  if (parentPid === null) return false
  armed = true
  const exit = opts.exit ?? ((c: number) => process.exit(c))
  const alive = opts.alive ?? isProcessAlive
  let deadStreak = 0
  const timer = setInterval(() => {
    const parentAlive = alive(parentPid)
    deadStreak = parentAlive ? 0 : deadStreak + 1
    if (
      decideOrphanShutdown({
        ownerPid: parentPid,
        ownerAlive: parentAlive,
        deadStreak,
        graceChecks: WORKER_WATCH_GRACE_CHECKS,
        persist: false,
      })
    ) {
      // NOT a bare exit: the worker's own in-flight persistence — the
      // transcript writer's queued appends above all — is discarded by a
      // process.exit that runs nothing (FN-015 rank 11: a session stopped
      // this way later resumed against a transcript whose last turn simply
      // stops). The cleanup registry runs first, under a hard cap, so a
      // wedged cleanup can never hold a worker whose supervisor is gone.
      void orphanExit({ exit, cleanup: runCleanupFunctions })
    }
  }, WORKER_WATCH_INTERVAL_MS)
  timer.unref?.()
  return true
}

/** Test-only: reset the one-arm guard so a unit test can re-arm. */
export function __resetWorkerParentWatchForTests(): void {
  armed = false
}
