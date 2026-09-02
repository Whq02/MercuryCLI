// ============================================================================
//  streamingTailStore — the live streaming-text tail store (
//  docs/.md).
//
//  The class it closes (defect A): the pass stopped the per-delta
//  whole-tree render storm by keeping only the COMPLETE-LINE prefix in React
//  state — which made the trailing partial line INVISIBLE until its newline
//  arrived (measured: mid-line text sat unpainted 1.5–2.9s at human pace,
//  the flux bench receipts). This store restores sub-line visibility
//  WITHOUT re-opening the storm by moving the per-delta text out of the REPL
//  root entirely:
//
//    stream fan-out → store.update(f)     (ref-fresh, synchronous)
//                       └─ adaptive publish (leading+trailing, 40ms)
//                            └─ ONE subscribed leaf (<LiveStreamingTail>)
//                               re-renders — the REPL tree does not.
//
//  Publish cadence (adaptive, not a fixed delay):
//   • boundary transitions publish IMMEDIATELY — first content (null→text)
//     and clear (text→null) never wait on a timer;
//   • a delta arriving ≥intervalMs after the last publish publishes
//     IMMEDIATELY (leading edge — slow human-pace streams gain zero latency);
//   • faster deltas coalesce into ONE trailing publish at the interval edge
//     (fast streams paint at ~25fps instead of per delta — visually
//     continuous, bounded work).
//
//  Contracts (frozen by scripts/streaming/prove-tail-store.ts):
//   • read() is ALWAYS fresh — the esc-interrupt path sees the full partial
//     text including the un-published tail;
//   • no lost final delta — a pending trailing publish carries the complete
//     value; reset() flushes synchronously;
//   • getSnapshot() is stable between notifications (useSyncExternalStore);
//   • dispose() kills the timer and latches the sink shut; late updates keep
//     read() fresh but never notify.
//
//  One store per REPL instance (created in useState) — never a module
//  singleton, so a second mounted screen can never cross-talk tails.
// ============================================================================

import { fluxCount, fluxMark } from '../flux/fluxProbe.js'
import { registerFlushProbe } from '../../ink/root/flush-registry.js'

/** ~31fps: continuous to the eye at a fraction of per-frame write rate. 32ms
 *  (down from 40) so one render-invisible publish beat (a trailing-indent
 *  delta inside a code fence) costs a 64ms visible gap, inside the ux-parity
 *  70ms p99 budget — at 40ms the same beat measured 80ms+. */
export const TAIL_INTERVAL_MS = 32

export type StreamingTailStore = {
  /** Apply f to the fresh value (synchronous); schedule/perform a publish. */
  update(f: (current: string | null) => string | null): void
  /** The always-fresh value — the esc-interrupt read path. */
  read(): string | null
  /** Replace the value at a stream boundary and publish synchronously. */
  reset(value: string | null): void
  /** The text the last clear retired — held so the tail can keep painting
   *  it IN PLACE until the rendered transcript shows that reply (the
   *  settle swap must never shrink the frame: a shrink below the writer's
   *  ceded boundary re-pushes frozen rows into scrollback, and the cockpit
   *  blinks). Dropped by the next text, or by dropSettled(). */
  readSettled(): string | null
  /** The transcript has shown the settled reply (or the turn is over): let
   *  the ghost go. */
  dropSettled(): void
  /** Stage the identity of the text the NEXT update/reset feeds — the
   *  provider message id the daemon road reads from the tail projection
   *  (SessionTailV1.messageId). The ids move atomically with the text
   *  transitions: non-null text takes the staged id as CURRENT; the clear
   *  slides current into the SETTLED hold beside the ghost text; the next
   *  text and dropSettled() drop it with the ghost. A writer that never
   *  stages an id (the in-process stream fan-out) keeps every id null and
   *  the release law falls back to today's text match
   *  (scripts/streaming/prove-attach-tail-identity.ts §1). */
  setMessageId(id: string | null): void
  /** The identities beside the text: `current` for the fresh/published
   *  text, `settled` for the ghost — null where unknown. */
  readIds(): { current: string | null; settled: string | null }
  /** useSyncExternalStore subscribe contract. */
  subscribe(cb: () => void): () => void
  /** The last PUBLISHED value — stable between notifications. */
  getSnapshot(): string | null
  /** Unmount safety: kill the pending publish, latch notifications shut. */
  dispose(): void
}

export type StreamingTailStoreOpts = {
  intervalMs?: number
  /** Injectable seams for proofs. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export function createStreamingTailStore(
  opts: StreamingTailStoreOpts = {},
): StreamingTailStore {
  const intervalMs = opts.intervalMs ?? TAIL_INTERVAL_MS
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const now = opts.now ?? (() => performance.now())

  let fresh: string | null = null
  let published: string | null = null
  let settled: string | null = null
  // The identity channel (attach-road dedup): staged by the writer, moved
  // only inside the text transitions so text and id can never desync.
  let pendingId: string | null = null
  let currentId: string | null = null
  let settledId: string | null = null
  let timer: unknown = null
  let lastPublishAt = -Infinity
  let disposed = false
  const listeners = new Set<() => void>()
  // the estate-wide nonessential-flush census (observability only).
  const unregisterProbe = registerFlushProbe({
    name: 'streaming-tail',
    pending: () => (timer !== null ? 1 : 0),
  })

  function publishNow(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    lastPublishAt = now()
    if (published === fresh) return
    published = fresh
    if (disposed) return
    fluxCount('tail-publish')
    fluxMark('tail:publish') // probe-gated ring stamp (off ⇒ no-op)
    for (const cb of listeners) cb()
  }

  return {
    update(f) {
      const next = f(fresh)
      if (next === fresh) return
      const wasNull = fresh === null
      // A clear retires the text into the settled hold; new text drops it.
      // The ids ride the same two transitions, never their own.
      if (next === null && fresh !== null && fresh !== '') {
        settled = fresh
        settledId = currentId
        currentId = null
      } else if (next !== null) {
        settled = null
        settledId = null
        currentId = pendingId
      }
      fresh = next
      if (disposed) return // read() stays fresh; the sink stays shut
      // Boundary transitions never wait: first content + clear paint now.
      if (next === null || wasNull) {
        publishNow()
        return
      }
      const sincePublish = now() - lastPublishAt
      if (sincePublish >= intervalMs) {
        publishNow() // leading edge — slow streams gain zero latency
        return
      }
      fluxCount('tail-coalesced')
      if (timer === null) {
        timer = setTimer(publishNow, Math.max(1, intervalMs - sincePublish))
      }
    },
    read: () => fresh,
    reset(value) {
      if (value === null && fresh !== null && fresh !== '') {
        settled = fresh
        settledId = currentId
        currentId = null
      } else if (value !== null) {
        settled = null
        settledId = null
        currentId = pendingId
      }
      fresh = value
      publishNow()
    },
    readSettled: () => settled,
    dropSettled() {
      settled = null
      settledId = null
    },
    setMessageId(id) {
      pendingId = id
    },
    readIds: () => ({ current: currentId, settled: settledId }),
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSnapshot: () => published,
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      listeners.clear()
      unregisterProbe()
    },
  }
}
