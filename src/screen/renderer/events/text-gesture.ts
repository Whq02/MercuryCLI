export type TextGesture = {
  readonly kind: 'press' | 'drag' | 'release'
  readonly localCol: number
  readonly localRow: number
  readonly clickCount: 1 | 2 | 3
}

export type TextGestureHandler = (gesture: TextGesture) => boolean | void
