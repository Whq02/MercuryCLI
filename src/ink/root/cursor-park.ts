import type { Patch } from '../frame.js'
import { CURSOR_HOME, cursorMove, cursorPosition } from '../termio/csi.js'

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

function samePoint(a: CursorPoint | null, b: CursorPoint | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y
}

function relativePatch(from: CursorPoint, to: CursorPoint): Patch | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return null
  return { type: 'stdout', content: cursorMove(dx, dy) }
}

export function planCursor(input: CursorPlanInput): CursorPlan {
  const { altScreen, hasDiff, parkPatch, target, parked, prevCursor, frameCursor, rows, cols } = input
  if (!hasDiff && samePoint(target, parked)) {
    return { prelude: [], postlude: [], nextParked: parked }
  }

  const prelude: Patch[] = []
  const postlude: Patch[] = []

  if (altScreen && hasDiff) {
    prelude.push(CURSOR_HOME_PATCH)
    postlude.push(parkPatch)
  } else if (!altScreen && hasDiff && parked !== null) {
    const restore = relativePatch(parked, prevCursor)
    if (restore !== null) prelude.push(restore)
  }

  if (target !== null) {
    if (altScreen) {
      const row = Math.max(1, Math.min(rows, target.y + 1))
      const col = Math.max(1, Math.min(cols, target.x + 1))
      postlude.push({ type: 'stdout', content: cursorPosition(row, col) })
    } else {
      const origin = hasDiff ? frameCursor : (parked ?? frameCursor)
      const move = relativePatch(origin, target)
      if (move !== null) postlude.push(move)
    }
    return { prelude, postlude, nextParked: target }
  }

  if (!altScreen && !hasDiff && parked !== null) {
    const restore = relativePatch(parked, frameCursor)
    if (restore !== null) postlude.push(restore)
  }
  return { prelude, postlude, nextParked: null }
}
