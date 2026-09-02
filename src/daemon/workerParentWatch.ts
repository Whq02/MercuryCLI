import { isProcessAlive, decideOrphanShutdown } from './ownerWatch.js'
import { runCleanupFunctions } from '../utils/cleanupRegistry.js'

export const WORKER_PARENT_PID_ENV = 'MERCURY_WORKER_PARENT_PID'

export const WORKER_WATCH_INTERVAL_MS = 4000
export const WORKER_WATCH_GRACE_CHECKS = 2

export function parseWorkerParentPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[WORKER_PARENT_PID_ENV] ?? env['MERCURY_WORKER_PARENT_PID'])?.trim()
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export const WORKER_ORPHAN_CLEANUP_CAP_MS = 1_500

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
  } finally {
    if (cap) clearTimeout(cap)
  }
  opts.exit(0)
}

export function __workerOrphanExitForTest(opts: {
  exit: (code: number) => void
  cleanup: () => Promise<void>
  capMs?: number
}): Promise<void> {
  return orphanExit(opts)
}

let armed = false

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
      void orphanExit({ exit, cleanup: runCleanupFunctions })
    }
  }, WORKER_WATCH_INTERVAL_MS)
  timer.unref?.()
  return true
}

export function __resetWorkerParentWatchForTests(): void {
  armed = false
}
