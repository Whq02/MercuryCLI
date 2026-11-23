import { FOLD_EXIT_LINGER_MS, type FoldStatusV1 } from '../../compaction/foldStatus.js'
import { emitAll } from './shared.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

interface FoldNeeds {
  recomputeLive(): void
}

function foldStillRuns(status: FoldStatusV1 | null): boolean {
  return status === null || status.exit === undefined
}

export class FoldPart {
  private liveFoldStatus: FoldStatusV1 | null = null
  private foldExitLatch: FoldStatusV1 | null = null
  private foldLatchTimer: ReturnType<typeof setTimeout> | null = null
  private foldLingerTimer: ReturnType<typeof setTimeout> | null = null
  private foldLingerOver = false
  private readonly foldListeners = new Set<() => void>()

  constructor(private readonly needs: FoldNeeds) {}

  stillRuns(): boolean {
    return foldStillRuns(this.liveFoldStatus)
  }

  dropRunningAtIdle(): void {
    if (this.liveFoldStatus !== null && this.liveFoldStatus.exit === undefined) {
      const gone = this.liveFoldStatus
      this.liveFoldStatus = null
      if (gone.trigger === 'manual') this.latchFold(gone)
      emitAll(this.foldListeners, 'fold')
    }
  }

  setLiveFold(next: FoldStatusV1 | null): void {
    if (JSON.stringify(this.liveFoldStatus) === JSON.stringify(next)) return
    if (next === null && this.liveFoldStatus !== null && this.liveFoldStatus.trigger === 'manual') {
      this.latchFold(this.liveFoldStatus)
    } else if (next !== null) {
      this.clearFoldLatch()
      this.foldLingerOver = false
      if (next.exit !== undefined) this.armFoldLingerEnd(next)
      else this.clearFoldLinger()
    }
    const wasRunning = foldStillRuns(this.liveFoldStatus)
    this.liveFoldStatus = next
    emitAll(this.foldListeners, 'fold')
    if (wasRunning !== foldStillRuns(next)) this.needs.recomputeLive()
  }

  private armFoldLingerEnd(status: FoldStatusV1): void {
    this.clearFoldLinger()
    const endsInMs = Math.max(0, (status.endedAtMs ?? status.startedAtMs) + FOLD_EXIT_LINGER_MS - Date.now())
    this.foldLingerTimer = startTimeout(() => {
      this.foldLingerTimer = null
      this.foldLingerOver = true
      emitAll(this.foldListeners, 'fold')
    }, endsInMs)
    this.foldLingerTimer.unref?.()
  }

  private clearFoldLinger(): void {
    if (this.foldLingerTimer !== null) {
      stopTimeout(this.foldLingerTimer)
      this.foldLingerTimer = null
    }
  }

  private latchFold(status: FoldStatusV1): void {
    this.foldExitLatch = status
    if (this.foldLatchTimer !== null) stopTimeout(this.foldLatchTimer)
    this.foldLatchTimer = startTimeout(() => {
      this.foldLatchTimer = null
      this.foldExitLatch = null
      emitAll(this.foldListeners, 'fold')
    }, FOLD_EXIT_LINGER_MS)
    this.foldLatchTimer.unref?.()
  }

  private clearFoldLatch(): void {
    if (this.foldLatchTimer !== null) {
      stopTimeout(this.foldLatchTimer)
      this.foldLatchTimer = null
    }
    this.foldExitLatch = null
  }

  fold(): FoldStatusV1 | null {
    const record = this.liveFoldStatus ?? this.foldExitLatch
    return record !== null && record.exit !== undefined && this.foldLingerOver ? null : record
  }

  subscribeFold(listener: () => void): () => void {
    this.foldListeners.add(listener)
    return () => {
      this.foldListeners.delete(listener)
    }
  }
}
