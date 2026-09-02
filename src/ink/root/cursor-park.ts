import type { Patch } from '../frame.js'
import { CURSOR_HOME, cursorMove, cursorPosition, ERASE_SCREEN } from '../termio/csi.js'

export type CursorPoint = { x: number; y: number }

export type CursorPlanInput = {
  altScreen: boolean
  hasDiff: boolean
  needsErase: boolean
  parkPatch: Patch
  target: CursorPoint | null
  parked: CursorPoint | null
  prevCursor: CursorPoint
  frameCursor: CursorPoint
  rows: number
  cols: number
}

export type CursorPlan = {
  prelude: Patch[]
  postlude: Patch[]
  nextParked: CursorPoint | null
  consumedErase: boolean
}

const CURSOR_HOME_PATCH: Patch = Object.freeze({ type: 'stdout' as const, content: CURSOR_HOME })
const ERASE_THEN_HOME_PATCH: Patch = Object.freeze({
  type: 'stdout' as const,
  content: ERASE_SCREEN + CURSOR_HOME,
})

export function planCursor(input: CursorPlanInput): CursorPlan {
  const { altScreen, hasDiff, target, parked, prevCursor, frameCursor, rows, cols } = input
  const prelude: Patch[] = []
  const postlude: Patch[] = []
  let consumedErase = false

  if (altScreen && hasDiff) {
    if (input.needsErase) {
      consumedErase = true
      prelude.push(ERASE_THEN_HOME_PATCH)
    } else {
      prelude.push(CURSOR_HOME_PATCH)
    }
    postlude.push(input.parkPatch)
  }

  const targetMoved =
    target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y)
  if (!hasDiff && !targetMoved && !(target === null && parked !== null)) {
    return { prelude, postlude, nextParked: parked, consumedErase }
  }

  if (parked !== null && !altScreen && hasDiff) {
    const pdx = prevCursor.x - parked.x
    const pdy = prevCursor.y - parked.y
    if (pdx !== 0 || pdy !== 0) {
      prelude.unshift({ type: 'stdout', content: cursorMove(pdx, pdy) })
    }
  }

  if (target !== null) {
    if (altScreen) {
      const row = Math.min(Math.max(target.y + 1, 1), rows)
      const col = Math.min(Math.max(target.x + 1, 1), cols)
      postlude.push({ type: 'stdout', content: cursorPosition(row, col) })
    } else {
      const from = !hasDiff && parked !== null ? parked : frameCursor
      const dx = target.x - from.x
      const dy = target.y - from.y
      if (dx !== 0 || dy !== 0) {
        postlude.push({ type: 'stdout', content: cursorMove(dx, dy) })
      }
    }
    return { prelude, postlude, nextParked: target, consumedErase }
  }

  if (parked !== null && !altScreen && !hasDiff) {
    const rdx = frameCursor.x - parked.x
    const rdy = frameCursor.y - parked.y
    if (rdx !== 0 || rdy !== 0) {
      postlude.push({ type: 'stdout', content: cursorMove(rdx, rdy) })
    }
  }
  return { prelude, postlude, nextParked: null, consumedErase }
}
