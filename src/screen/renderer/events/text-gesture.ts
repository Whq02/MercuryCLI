export type TextGesture = {
  readonly kind: 'press' | 'drag' | 'release'
  readonly localCol: number
  readonly localRow: number
  readonly clickCount: 1 | 2 | 3
}

export type TextGestureHandler = (gesture: TextGesture) => boolean | void

export function isClickSlop(from: { col: number; row: number }, to: { col: number; row: number }): boolean {
  return from.row === to.row && Math.abs(to.col - from.col) <= 1
}
