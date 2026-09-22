export const BURST_WINDOW_MS = 200
export const WALL_RECHECK_MS = 60_000
export const REOPEN_GRACE_MS = 1_000
export const LISTED_LINES_CAP = 40
export const HELD_LINES_CAP = 400

export type WatchWall = { closed: boolean; reopensAtMs?: number }

export type WatchMailboxDeps = {
  now: () => number
  wall: () => WatchWall
  deliver: (text: string) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type WatchMailbox = {
  push: (text: string) => void
  heldCount: () => number
  dispose: () => void
}

export function heldHeader(count: number): string {
  return `[${count} line${count === 1 ? '' : 's'} arrived while the usage window was closed and waited for this turn]`
}

export function listLines(lines: readonly string[], dropped: number): string {
  const listed = lines.slice(0, LISTED_LINES_CAP)
  const rest = lines.length - listed.length + dropped
  if (rest <= 0) return listed.join('\n')
  return `${listed.join('\n')}\n[+${rest} more line${rest === 1 ? '' : 's'} from this watch not listed]`
}

export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line !== '')
}

export function createWatchMailbox(deps: WatchMailboxDeps): WatchMailbox {
  let burst: string[] = []
  let held: string[] = []
  let dropped = 0
  let burstTimer: unknown = null
  let recheckTimer: unknown = null
  let disposed = false

  const hold = (lines: string[]): void => {
    for (const line of lines) {
      if (held.length < HELD_LINES_CAP) held.push(line)
      else dropped++
    }
  }

  const deliverAll = (fresh: string[]): void => {
    const waited = held
    const waitedDropped = dropped
    held = []
    dropped = 0
    if (waited.length === 0 && fresh.length === 0) return
    if (waited.length === 0) {
      deps.deliver(listLines(fresh, 0))
      return
    }
    deps.deliver(`${heldHeader(waited.length + waitedDropped)}\n${listLines([...waited, ...fresh], waitedDropped)}`)
  }

  const armRecheck = (wall: WatchWall): void => {
    if (recheckTimer !== null || disposed) return
    const untilReopen = wall.reopensAtMs === undefined ? WALL_RECHECK_MS : wall.reopensAtMs + REOPEN_GRACE_MS - deps.now()
    const wait = Math.max(REOPEN_GRACE_MS, Math.min(WALL_RECHECK_MS, untilReopen))
    recheckTimer = deps.setTimer(() => {
      recheckTimer = null
      const now = deps.wall()
      if (now.closed) {
        armRecheck(now)
        return
      }
      deliverAll([])
    }, wait)
  }

  const flushBurst = (): void => {
    burstTimer = null
    const lines = burst
    burst = []
    const wall = deps.wall()
    if (wall.closed) {
      hold(lines)
      armRecheck(wall)
      return
    }
    deliverAll(lines)
  }

  return {
    push(text) {
      if (disposed) return
      const lines = linesOf(text)
      if (lines.length === 0) return
      burst.push(...lines)
      if (burstTimer === null) burstTimer = deps.setTimer(flushBurst, BURST_WINDOW_MS)
    },
    heldCount: () => held.length + dropped,
    dispose() {
      disposed = true
      if (burstTimer !== null) deps.clearTimer(burstTimer)
      if (recheckTimer !== null) deps.clearTimer(recheckTimer)
      burstTimer = null
      recheckTimer = null
    },
  }
}
