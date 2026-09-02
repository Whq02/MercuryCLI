
import { fluxCount, fluxMark } from '../flux/fluxProbe.js'
import { registerFlushProbe } from '../../ink/root/flush-registry.js'

export const TAIL_INTERVAL_MS = 32

export type StreamingTailStore = {
  update(f: (current: string | null) => string | null): void
  read(): string | null
  reset(value: string | null): void
  readSettled(): string | null
  dropSettled(): void
  setMessageId(id: string | null): void
  readIds(): { current: string | null; settled: string | null }
  subscribe(cb: () => void): () => void
  getSnapshot(): string | null
  dispose(): void
}

export type StreamingTailStoreOpts = {
  intervalMs?: number
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
  let pendingId: string | null = null
  let currentId: string | null = null
  let settledId: string | null = null
  let timer: unknown = null
  let lastPublishAt = -Infinity
  let disposed = false
  const listeners = new Set<() => void>()
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
    fluxMark('tail:publish')
    for (const cb of listeners) cb()
  }

  return {
    update(f) {
      const next = f(fresh)
      if (next === fresh) return
      const wasNull = fresh === null
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
      if (disposed) return
      if (next === null || wasNull) {
        publishNow()
        return
      }
      const sincePublish = now() - lastPublishAt
      if (sincePublish >= intervalMs) {
        publishNow()
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
