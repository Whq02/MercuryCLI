
import { registerFlushProbe } from '../../ink/root/flush-registry.js'

export type StreamBatcherOpts<T> = {
  sink: (value: T) => void
  intervalMs?: number
  flushNow?: (prev: T, next: T) => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class StreamBatcher<T> {
  private value: T
  private timer: unknown = null
  private disposed = false
  private silentDirty = false
  private readonly sink: (value: T) => void
  private readonly intervalMs: number
  private readonly flushNow?: (prev: T, next: T) => boolean
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  sinkCalls = 0

  private unregisterProbe: () => void

  constructor(initial: T, opts: StreamBatcherOpts<T>) {
    this.value = initial
    this.sink = opts.sink
    this.intervalMs = opts.intervalMs ?? 16
    this.flushNow = opts.flushNow
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.unregisterProbe = registerFlushProbe({
      name: 'stream-batcher',
      pending: () => (this.timer !== null ? 1 : 0),
    })
  }

  get current(): T {
    return this.value
  }

  update(f: (current: T) => T): void {
    const prev = this.value
    const next = f(prev)
    if (next === prev) return
    this.value = next
    if (this.disposed) return
    if (this.flushNow?.(prev, next)) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null
        this.flush()
      }, this.intervalMs)
    }
  }

  updateSilent(f: (current: T) => T): void {
    const prev = this.value
    const next = f(prev)
    if (next === prev) return
    this.value = next
    if (this.disposed) return
    this.silentDirty = true
  }

  flushSilent(): void {
    if (!this.silentDirty) return
    this.flush()
  }

  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    if (this.disposed) return
    this.silentDirty = false
    this.sinkCalls++
    this.sink(this.value)
  }

  reset(value: T): void {
    this.value = value
    this.flush()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.unregisterProbe()
  }
}
