import { REOPEN_GRACE_MS, WALL_RECHECK_MS, type WatchWall } from '../MonitorTool/watchMailbox.js'
import type { SaturnOrigin } from '../../utils/messages/noticeRows.js'

export type LocalWakeFacts = Pick<SaturnOrigin, 'spelling' | 'reason'>

export type LocalWakeStep =
  | { step: 'wait'; delayMs: number; heldSince: string }
  | { step: 'deliver'; origin: SaturnOrigin }

export function localWakeWaitMs(wall: WatchWall, nowMs: number): number {
  if (wall.reopensAtMs === undefined || wall.reopensAtMs <= nowMs) return WALL_RECHECK_MS
  return wall.reopensAtMs + REOPEN_GRACE_MS - nowMs
}

export function localWakeStep(
  wall: WatchWall,
  nowMs: number,
  firedAt: string,
  heldSince: string | undefined,
  facts: LocalWakeFacts | undefined,
): LocalWakeStep {
  if (wall.closed) {
    return { step: 'wait', delayMs: localWakeWaitMs(wall, nowMs), heldSince: heldSince ?? new Date(nowMs).toISOString() }
  }
  return {
    step: 'deliver',
    origin: {
      kind: 'saturn',
      fire: 'wake',
      firedAt,
      ...(facts?.spelling !== undefined ? { spelling: facts.spelling } : {}),
      ...(facts?.reason !== undefined ? { reason: facts.reason } : {}),
      ...(heldSince !== undefined ? { heldSince, heldWhy: 'window' as const } : {}),
    },
  }
}
