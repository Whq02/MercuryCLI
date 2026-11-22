import type { Cursor } from '../utils/Cursor.js'
import { notBuilt } from '../pi/holes.js'

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

export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  return notBuilt('src/vim/motions.ts:23')
}

export function isInclusiveMotion(key: string): boolean {
  return notBuilt('src/vim/motions.ts:35')
}

export function isLinewiseMotion(key: string): boolean {
  return notBuilt('src/vim/motions.ts:39')
}
