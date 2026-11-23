export type FpsMetrics = { averageFps: number; low1PctFps: number }

export class FpsTracker {
  private readonly durations: number[] = []
  private firstRecordMs: number | null = null
  private lastRecordMs: number | null = null

  record(durationMs: number): void {
    const now = performance.now()
    this.firstRecordMs ??= now
    this.lastRecordMs = now
    this.durations.push(durationMs)
  }

  getMetrics(): FpsMetrics | undefined {
    if (this.firstRecordMs === null || this.lastRecordMs === null) return undefined
    const seconds = (this.lastRecordMs - this.firstRecordMs) / 1000
    if (!(seconds > 0)) return undefined
    const count = this.durations.length
    const duration = this.durations.toSorted((a, b) => b - a)[Math.ceil(count / 100) - 1]!
    return {
      averageFps: Math.round((count / seconds) * 100) / 100,
      low1PctFps: duration > 0 ? Math.round((1000 / duration) * 100) / 100 : 0,
    }
  }
}
