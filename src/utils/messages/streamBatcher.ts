// streamBatcher — the ONE frame-cadence batcher for high-frequency stream
// updates.
//
// The class it closes: a fast stream delivers 50-100+ deltas a second
// (input_json_delta while a Write/Edit body streams — the dominant agentic
// mode), and a per-delta setState commits the entire ~5k-line REPL tree once
// per delta. Paint is already throttled (~16ms in the reconciler) but the
// REACT RECONCILE side was not — real main-thread churn competing with input
// handling; the felt "flickering / laggy" streaming the operator reported.
// The pass fixed exactly this for text_delta with an inline ref
// (REPL.tsx streamingTextRef — since text_delta rides
// utils/messages/streamingTailStore.ts instead); this module is that pattern
// extracted as a REUSABLE, framework-free primitive so the tool-use mirror
// (and any future high-frequency stream surface) shares one proven
// implementation.
//
// Contract:
//   • update(f) applies f to the CURRENT value synchronously (the ref is
//     always fresh — an esc-interrupt reader never sees a stale tail);
//   • the SINK (React setState) is called on a trailing frame-cadence timer —
//     at most ~1/intervalMs — EXCEPT when `flushNow` says the update must
//     paint immediately (the callers' rule: an array LENGTH change = a new
//     tool_use block opening — a new row must never wait on the timer);
//   • an identity update (f returns the same reference) is a no-op;
//   • reset(value) replaces the value and flushes immediately (stream
//     boundaries);
//   • dispose() kills the pending timer (unmount safety).
//
// Pure TS + injectable clock/timer — deliberately bun-loadable so the proof
// (scripts/messages/prove-stream-commit-throttle.ts) exercises THIS code.

import { registerFlushProbe } from '../../ink/root/flush-registry.js'

export type StreamBatcherOpts<T> = {
  /** The downstream commit (React setState). Called with the latest value. */
  sink: (value: T) => void
  /** Trailing flush cadence in ms (the frame interval). Default 16. */
  intervalMs?: number
  /** When true for an update, flush immediately instead of on the timer. */
  flushNow?: (prev: T, next: T) => boolean
  /** Injectable timer seam (proofs); defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class StreamBatcher<T> {
  private value: T
  private timer: unknown = null
  private disposed = false
  /** True when updateSilent changed the value since the last flush. */
  private silentDirty = false
  private readonly sink: (value: T) => void
  private readonly intervalMs: number
  private readonly flushNow?: (prev: T, next: T) => boolean
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  /** Sink-call counter — the proof's commit odometer. */
  sinkCalls = 0

  private unregisterProbe: () => void

  constructor(initial: T, opts: StreamBatcherOpts<T>) {
    this.value = initial
    this.sink = opts.sink
    this.intervalMs = opts.intervalMs ?? 16
    this.flushNow = opts.flushNow
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
    // the estate-wide nonessential-flush census (observability only).
    this.unregisterProbe = registerFlushProbe({
      name: 'stream-batcher',
      pending: () => (this.timer !== null ? 1 : 0),
    })
  }

  /** The always-fresh current value (the esc-interrupt read path). */
  get current(): T {
    return this.value
  }

  update(f: (current: T) => T): void {
    const prev = this.value
    const next = f(prev)
    if (next === prev) return // identity — nothing changed, schedule nothing
    this.value = next // the ref-freshness contract holds even after dispose
    if (this.disposed) return // late stream events never resurrect the sink
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

  /**
   * SILENT update: apply f to the current value (the ref stays esc-fresh)
   * without scheduling ANY sink — not even the trailing timer. For per-delta
   * storms whose accumulation is invisible until a boundary
   * (input_json_delta: nothing renders partial tool input), so 100 deltas
   * cost zero React work. Pair with flushSilent() at the boundary
   * (content_block_stop) so the completed value commits before anything that
   * depends on it (the tool result arrives on a later stream message).
   */
  updateSilent(f: (current: T) => T): void {
    const prev = this.value
    const next = f(prev)
    if (next === prev) return
    this.value = next
    if (this.disposed) return
    this.silentDirty = true
  }

  /** Commit silent accumulation, if any. No-op when nothing changed silently
   *  since the last flush — a text-block stop never buys a pointless commit. */
  flushSilent(): void {
    if (!this.silentDirty) return
    this.flush()
  }

  /** Push the current value to the sink now; cancels any pending timer. */
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

  /** Replace the value at a stream boundary and flush immediately. */
  reset(value: T): void {
    this.value = value
    this.flush()
  }

  /** Unmount safety — kill the pending trailing flush AND latch the sink shut
   *  (review: a late delta would otherwise re-arm the timer and setState
   *  on an unmounted owner). A consumer that wants the un-flushed tail must
   *  flush() before dispose(). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.unregisterProbe()
  }
}
