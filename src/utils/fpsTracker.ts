export type FpsMetrics = {
  averageFps: number
  low1PctFps: number
}

export class FpsTracker {
  private readonly durations: number[] = []
  private firstRecordMs: number | null = null
  private lastRecordMs: number | null = null

  record(durationMs: number): void {
    const now = performance.now()
    if (this.firstRecordMs === null) this.firstRecordMs = now
    this.lastRecordMs = now
    this.durations.push(durationMs)
  }

  getMetrics(): FpsMetrics | undefined {
    if (this.durations.length === 0 || this.firstRecordMs === null || this.lastRecordMs === null) {
      return undefined
    }
    const elapsedSeconds = (this.lastRecordMs - this.firstRecordMs) / 1000
    if (elapsedSeconds <= 0) return undefined
    const averageFps = this.durations.length / elapsedSeconds
    const sorted = [...this.durations].sort((a, b) => b - a)
    const index = Math.max(0, Math.ceil(sorted.length * 0.01) - 1)
    const worst = sorted[index] as number
    const low1PctFps = worst > 0 ? 1000 / worst : 0
    return {
      averageFps: Math.round(averageFps * 100) / 100,
      low1PctFps: Math.round(low1PctFps * 100) / 100,
    }
  }
}
