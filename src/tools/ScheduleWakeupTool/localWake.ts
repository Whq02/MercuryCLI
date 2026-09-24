import { wallRecheckDelayMs, type WatchWall } from '../MonitorTool/watchMailbox.js'
import type { SaturnOrigin } from '../../utils/messages/noticeRows.js'

export type LocalWakeFacts = Pick<SaturnOrigin, 'spelling' | 'reason'>

export type LocalWakeStep =
  | { step: 'wait'; delayMs: number; heldSince: string }
  | { step: 'deliver'; origin: SaturnOrigin }

export function localWakeStep(
  wall: WatchWall,
  nowMs: number,
  firedAt: string,
  heldSince: string | undefined,
  facts: LocalWakeFacts | undefined,
): LocalWakeStep {
  if (wall.closed) {
    return { step: 'wait', delayMs: wallRecheckDelayMs(wall, nowMs), heldSince: heldSince ?? new Date(nowMs).toISOString() }
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
