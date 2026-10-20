export const BURST_WINDOW_MS = 200
export const DELIVERY_INTERVAL_MS = 30_000
export const WALL_RECHECK_MS = 60_000
export const REOPEN_GRACE_MS = 1_000
export const LISTED_LINES_CAP = 40
export const HELD_LINES_CAP = 400

export type WatchWall = { closed: boolean; reopensAtMs?: number }

type WatchMailboxDeps = {
  now: () => number
  wall: () => WatchWall
  deliver: (text: string, summary: { count: number; last: string }) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

type WatchMailbox = {
  push: (text: string) => void
  heldCount: () => number
  dispose: () => void
}

export function heldHeader(count: number): string {
  return `[${count} line${count === 1 ? '' : 's'} arrived while the usage window was closed and waited for this turn]`
}

function listLines(lines: readonly string[], dropped: number): string {
  const listed = lines.slice(0, LISTED_LINES_CAP)
  const rest = lines.length - listed.length + dropped
  if (rest <= 0) return listed.join('\n')
  return `${listed.join('\n')}\n[+${rest} more line${rest === 1 ? '' : 's'} from this watch not listed]`
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line !== '')
}

export function wallRecheckDelayMs(wall: WatchWall, nowMs: number): number {
  const untilReopen = wall.reopensAtMs === undefined ? WALL_RECHECK_MS : wall.reopensAtMs + REOPEN_GRACE_MS - nowMs
  return Math.max(REOPEN_GRACE_MS, Math.min(WALL_RECHECK_MS, untilReopen))
}

export function createWatchMailbox(deps: WatchMailboxDeps): WatchMailbox {
  let burst: string[] = []
  let held: string[] = []
  let dropped = 0
  let burstTimer: unknown = null
  let recheckTimer: unknown = null
  let disposed = false
  let pending: string[] = []
  let lastHeld = ''
  let lastDeliveredAt: number | null = null
  let deliveryTimer: unknown = null

  const hold = (lines: string[]): void => {
    for (const line of lines) {
      lastHeld = line
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
    const summary = { count: waited.length + waitedDropped + fresh.length, last: fresh.at(-1) ?? lastHeld }
    lastHeld = ''
    lastDeliveredAt = deps.now()
    if (waited.length === 0) {
      deps.deliver(listLines(fresh, 0), summary)
      return
    }
    deps.deliver(`${heldHeader(waited.length + waitedDropped)}\n${listLines([...waited, ...fresh], waitedDropped)}`, summary)
  }

  const deliverWhenDue = (lines: string[]): void => {
    pending.push(...lines)
    const delay = lastDeliveredAt === null ? 0 : Math.max(0, lastDeliveredAt + DELIVERY_INTERVAL_MS - deps.now())
    if (delay > 0) {
      if (deliveryTimer === null) deliveryTimer = deps.setTimer(() => { deliveryTimer = null; deliverWhenDue([]) }, delay)
      return
    }
    const fresh = pending
    pending = []
    const wall = deps.wall()
    if (wall.closed) { hold(fresh); armRecheck(wall); return }
    deliverAll(fresh)
  }

  const armRecheck = (wall: WatchWall): void => {
    if (recheckTimer !== null || disposed) return
    const wait = wallRecheckDelayMs(wall, deps.now())
    recheckTimer = deps.setTimer(() => {
      recheckTimer = null
      const now = deps.wall()
      if (now.closed) {
        armRecheck(now)
        return
      }
      deliverWhenDue([])
    }, wait)
  }

  const flushBurst = (): void => {
    burstTimer = null
    let lines = burst
    burst = []
    const wall = deps.wall()
    if (wall.closed) {
      lines = [...pending, ...lines]
      pending = []
      if (deliveryTimer !== null) deps.clearTimer(deliveryTimer)
      deliveryTimer = null
      hold(lines)
      armRecheck(wall)
      return
    }
    deliverWhenDue(lines)
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
      if (deliveryTimer !== null) deps.clearTimer(deliveryTimer)
      pending = []
      burstTimer = null
      recheckTimer = null
    },
  }
}
