import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type FpsMetrics = Unbuilt

export class FpsTracker {
  private readonly durations: number[] = unbuilt('src/utils/fpsTracker.ts:7')
  private firstRecordMs: number | null = unbuilt('src/utils/fpsTracker.ts:8')
  private lastRecordMs: number | null = unbuilt('src/utils/fpsTracker.ts:9')

  record(durationMs: number): void {
    return notBuilt('src/utils/fpsTracker.ts:11')
  }

  getMetrics(): FpsMetrics | undefined {
    return notBuilt('src/utils/fpsTracker.ts:18')
  }
}
