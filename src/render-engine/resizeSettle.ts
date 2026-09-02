
export const SETTLE_WINDOW_MS = 120

export type ResizeGateEvent =
  | { kind: 'storm-entered' }
  | { kind: 'storm-continues' }
  | { kind: 'settle'; cols: number; rows: number }

export class ResizeSettleGate {
  private stormActive = false
  private lastWinchAt = -Infinity
  private pendingCols = 0
  private pendingRows = 0
  private timer: unknown = null

  constructor(
    private readonly clock: {
      now(): number
      setTimeout(fn: () => void, ms: number): unknown
      clearTimeout(t: unknown): void
    },
    private readonly emit: (e: ResizeGateEvent) => void,
    private readonly settleMs: number = SETTLE_WINDOW_MS,
  ) {}

  inStorm(): boolean {
    return this.stormActive
  }

  winch(cols: number, rows: number): void {
    const now = this.clock.now()
    this.pendingCols = cols
    this.pendingRows = rows
    const entering = !this.stormActive
    this.stormActive = true
    this.lastWinchAt = now
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(this.checkQuiet, this.settleMs)
    this.emit(entering ? { kind: 'storm-entered' } : { kind: 'storm-continues' })
  }

  private checkQuiet = (): void => {
    this.timer = null
    if (!this.stormActive) return
    const now = this.clock.now()
    const quietFor = now - this.lastWinchAt
    if (quietFor < this.settleMs) {
      this.timer = this.clock.setTimeout(this.checkQuiet, this.settleMs - quietFor)
      return
    }
    this.stormActive = false
    this.emit({ kind: 'settle', cols: this.pendingCols, rows: this.pendingRows })
  }

  cancel(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.stormActive = false
  }
}
