// ============================================================================
//  Pure vim motion resolution: key → target caret, plus the inclusivity and
//  linewise classifications operators consult. A motion applies its single
//  step `count` times, stopping early when a step makes no progress (caret
//  equality is offset + document identity, so a same-document no-move stops
//  the loop).
// ============================================================================

import type { Cursor } from '../utils/Cursor.js'

const STEPS: Record<string, (c: Cursor) => Cursor> = {
  h: c => c.left(),
  l: c => c.right(),
  j: c => c.downLogicalLine(),
  k: c => c.upLogicalLine(),
  gj: c => c.down(),
  gk: c => c.up(),
  w: c => c.nextVimWord(),
  b: c => c.prevVimWord(),
  e: c => c.endOfVimWord(),
  W: c => c.nextWORD(),
  B: c => c.prevWORD(),
  E: c => c.endOfWORD(),
  '0': c => c.startOfLogicalLine(),
  '^': c => c.firstNonBlankInLogicalLine(),
  $: c => c.endOfLogicalLine(),
  G: c => c.startOfLastLine(),
}

/** Resolve a motion key to a target caret. An unknown key returns the caret
 *  unchanged. */
export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  const step = STEPS[key]
  if (!step) return cursor
  let current = cursor
  for (let i = 0; i < count; i++) {
    const next = step(current)
    if (next.equals(current)) break
    current = next
  }
  return current
}

/** Inclusive motions: the target character is part of an operator's range. */
export function isInclusiveMotion(key: string): boolean {
  return key === 'e' || key === 'E' || key === '$'
}

/** Linewise motions. `gj`/`gk` are deliberately characterwise-exclusive,
 *  matching vim's own documentation. */
export function isLinewiseMotion(key: string): boolean {
  return key === 'j' || key === 'k' || key === 'G' || key === 'gg'
}
