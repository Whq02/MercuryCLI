import type { Patch } from '../frame.js'
import { CURSOR_HOME, cursorMove, cursorPosition } from '../termio/csi.js'
import { notBuilt } from '../../pi/holes.js'

export type CursorPoint = { x: number; y: number }

type CursorPlanInput = {
  altScreen: boolean
  hasDiff: boolean
  parkPatch: Patch
  target: CursorPoint | null
  parked: CursorPoint | null
  prevCursor: CursorPoint
  frameCursor: CursorPoint
  rows: number
  cols: number
}

type CursorPlan = {
  prelude: Patch[]
  postlude: Patch[]
  nextParked: CursorPoint | null
}

const CURSOR_HOME_PATCH: Patch = Object.freeze({ type: 'stdout' as const, content: CURSOR_HOME })

export function planCursor(input: CursorPlanInput): CursorPlan {
  return notBuilt('src/ink/root/cursor-park.ts:26')
}
