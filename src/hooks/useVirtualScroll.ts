import {
  useCallback,
  useDeferredValue,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react'
import { appendFileSync } from 'node:fs'
import type { DOMElement } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { useLayoutClaim, useLayoutPublish, useMeasure, useSubscription } from './effects.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

function pinTrace(entry: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ev: 'pin', ...entry })}\n`)
  } catch (error) {
    passedOver(error)
  }
}

const UNMEASURED_ESTIMATE_ROWS = 3
const OVERSCAN_ROWS = 80
const COLD_START_COUNT = 30
const SCROLL_BIN_ROWS = OVERSCAN_ROWS / 2
const PESSIMISTIC_ROWS = 1

export function scaleHeightForWidth(height: number, ratio: number): number {
  if (height === 0) return 0
  return Math.max(1, Math.round(height * ratio))
}
const MAX_MOUNTED_ITEMS = 300
const SLIDE_BUDGET_MS = 8
const SLIDE_MIN_ITEMS = 8
const SLIDE_MAX_ITEMS = 60
const INITIAL_MS_PER_ITEM = SLIDE_BUDGET_MS / 25
const MOUNT_COST_SAMPLE_MIN = 3
const MOUNT_COST_CLAMP_MIN_MS = 0.02
const MOUNT_COST_CLAMP_MAX_MS = 20
const MOUNT_COST_EMA_WEIGHT = 0.2

type VirtualScrollResult = Unbuilt

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type ContentPin = { key: string; inner: number }
type PaintedGeometry = { offsets: Float64Array; keys: readonly string[] | null; count: number; version: number; origin: number }
type VirtualScrollView = {
  scrollRef: { current: ScrollBoxHandle | null }
  itemKeys: readonly string[]
  forceResolve: () => void
  heightCacheRef: { current: Map<string, number> }
  elementsRef: { current: Map<string, DOMElement> }
  refCallbacksRef: { current: Map<string, (el: DOMElement | null) => void> }
  offsetsVersionRef: { current: number }
  offsetsBufferRef: { current: Float64Array }
  offsetsBuiltVersionRef: { current: number }
  offsetsBuiltCountRef: { current: number }
  offsetsBuiltKeysRef: { current: readonly string[] | null }
  listOriginRef: { current: number }
  spacerElementRef: { current: DOMElement | null }
  prevColumnsRef: { current: number }
  prevItemKeysRef: { current: readonly string[] }
  measurementSkipRef: { current: boolean }
  freezeRendersRef: { current: number }
  prevScrollAtCommitRef: { current: number }
  msPerItemEmaRef: { current: number }
  contentPinRef: { current: ContentPin | null }
  lastWrittenTopRef: { current: number | null }
  keyIndexRef: { current: { keys: readonly string[] | null; map: Map<string, number>; indexed: number } }
  minChangedIndexRef: { current: number }
  reflowHoldRef: { current: boolean }
  outOfLayoutRef: { current: boolean }
  laidOutRef: { current: boolean }
  paintedRef: { current: PaintedGeometry }
}
type VirtualScrollTools = ReturnType<typeof virtualScrollTools>
type VirtualScrollPane = { box: ScrollBoxHandle | null; viewportHeight: number; pendingDelta: number; sticky: boolean; itemCount: number }

function offsetsOf(keys: readonly string[], heights: ReadonlyMap<string, number>, into: Float64Array): Float64Array {
  const buffer = into.length < keys.length + 1 ? new Float64Array(keys.length + 1) : into
  let accumulated = 0
  for (let i = 0; i < keys.length; i++) {
    buffer[i] = accumulated
    accumulated += heights.get(keys[i]!) ?? UNMEASURED_ESTIMATE_ROWS
  }
  buffer[keys.length] = accumulated
  return buffer
}

export function useVirtualScroll(
  scrollRef: { current: ScrollBoxHandle | null },
  itemKeys: readonly string[],
  columns: number,
): VirtualScrollResult {
  return notBuilt('src/hooks/useVirtualScroll.ts:109')
}

function virtualScrollTools({
  scrollRef, itemKeys, forceResolve, heightCacheRef, elementsRef, offsetsVersionRef, offsetsBufferRef, offsetsBuiltVersionRef,
  offsetsBuiltCountRef, offsetsBuiltKeysRef, listOriginRef, prevItemKeysRef, contentPinRef, lastWrittenTopRef, keyIndexRef,
  minChangedIndexRef, reflowHoldRef, paintedRef,
}: VirtualScrollView) {
  function indexByKey(keys: readonly string[], key: string): number | undefined {
    const ki = keyIndexRef.current
    if (ki.keys !== keys) {
      ki.map.clear()
      for (let i = 0; i < keys.length; i++) ki.map.set(keys[i]!, i)
      ki.keys = keys
      ki.indexed = keys.length
    } else if (ki.indexed < keys.length) {
      for (let i = ki.indexed; i < keys.length; i++) ki.map.set(keys[i]!, i)
      ki.indexed = keys.length
    }
    return ki.map.get(key)
  }

  function pinWhereTheViewStands(): void {
    const handle = scrollRef.current
    const { offsets: offs, keys, count, origin } = paintedRef.current
    if (!handle || !keys || count === 0) return
    if (handle.isSticky() || reflowHoldRef.current || handle.getViewportHeight() <= 0) return
    const committedTop = handle.getScrollTop()
    if (lastWrittenTopRef.current === committedTop) return
    const pos = Math.max(0, committedTop - origin)
    if (pos > offs[count]!) return
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offs[mid + 1]! > pos) hi = mid
      else lo = mid + 1
    }
    const idx = Math.min(lo, count - 1)
    const height = offs[idx + 1]! - offs[idx]!
    contentPinRef.current = { key: keys[idx]!, inner: Math.min(Math.max(0, pos - offs[idx]!), Math.max(0, height - 1)) }
    lastWrittenTopRef.current = committedTop
    pinTrace({ act: 'follow', committed: committedTop, origin, idx, off: offs[idx], h: height, pin: contentPinRef.current })
  }

  function keepPaintedGeometry(): void {
    const painted = paintedRef.current
    painted.origin = listOriginRef.current
    if (painted.version === offsetsVersionRef.current && painted.keys === itemKeys && painted.count === itemKeys.length) return
    painted.offsets = offsetsOf(itemKeys, heightCacheRef.current, painted.offsets)
    painted.keys = itemKeys
    painted.count = itemKeys.length
    painted.version = offsetsVersionRef.current
  }

  function ensureOffsets(keys: readonly string[] = itemKeys): Float64Array {
    const count = keys.length
    if (
      offsetsBuiltVersionRef.current === offsetsVersionRef.current &&
      offsetsBuiltCountRef.current === count &&
      offsetsBuiltKeysRef.current === keys
    ) {
      return offsetsBufferRef.current
    }
    const buffer = offsetsOf(keys, heightCacheRef.current, offsetsBufferRef.current)
    offsetsBufferRef.current = buffer
    offsetsBuiltVersionRef.current = offsetsVersionRef.current
    offsetsBuiltCountRef.current = count
    offsetsBuiltKeysRef.current = keys
    return buffer
  }

  function bestKnownHeight(index: number): number {
    return (
      heightCacheRef.current.get(itemKeys[index]!) ?? UNMEASURED_ESTIMATE_ROWS
    )
  }

  function realHeight(index: number): number {
    return heightCacheRef.current.get(itemKeys[index]!) ?? PESSIMISTIC_ROWS
  }

  function mountedCoversPane(first: number, last: number): boolean {
    const handle = scrollRef.current
    const pane = handle?.getViewportHeight() ?? 0
    if (!handle || pane <= 0) return true
    const count = itemKeys.length
    const fresh = ensureOffsets()
    const total = fresh[count]!
    if (handle.isSticky()) {
      return first === 0 || total - fresh[first]! >= pane + SCROLL_BIN_ROWS
    }
    const committed = handle.getScrollTop() - listOriginRef.current
    const target = committed + handle.getPendingDelta()
    const top = Math.max(0, Math.min(committed, target, total - pane))
    const bottom = Math.min(total, Math.max(committed, target) + pane)
    return (
      (first === 0 || fresh[first]! <= Math.max(0, top - SCROLL_BIN_ROWS)) &&
      (last >= count || fresh[last]! >= Math.min(total, bottom + SCROLL_BIN_ROWS))
    )
  }

  function recordMountedHeights(): void {
    pinWhereTheViewStands()
    const cache = heightCacheRef.current
    for (const [key, element] of elementsRef.current) {
      const layout = element.layoutNode
      if (!layout) continue
      const height = layout.getComputedHeight()
      const width = layout.getComputedWidth()
      if (height > 0) {
        if (cache.get(key) !== height) {
          cache.set(key, height)
          offsetsVersionRef.current += 1
          const idx = indexByKey(prevItemKeysRef.current, key)
          minChangedIndexRef.current = Math.min(minChangedIndexRef.current, idx ?? 0)
        }
      } else if (width > 0) {
        if (cache.get(key) !== 0) {
          cache.set(key, 0)
          offsetsVersionRef.current += 1
          const idx = indexByKey(prevItemKeysRef.current, key)
          minChangedIndexRef.current = Math.min(minChangedIndexRef.current, idx ?? 0)
        }
      }
    }
    keepPaintedGeometry()
  }

  function renderIfHeightsMovedThePane(first: number, last: number): boolean {
    const heightsMoved = offsetsVersionRef.current !== offsetsBuiltVersionRef.current
    if (heightsMoved) {
      const changedFrom = minChangedIndexRef.current
      const pin = contentPinRef.current
      if (pin && Number.isFinite(changedFrom)) {
        const pinIdx = indexByKey(prevItemKeysRef.current, pin.key)
        const pinnedLineGone = pin.inner >= (heightCacheRef.current.get(pin.key) ?? 0)
        if (pinIdx === undefined || changedFrom < pinIdx || (changedFrom === pinIdx && pinnedLineGone)) forceResolve()
      }
      if (!mountedCoversPane(first, last)) forceResolve()
    }
    minChangedIndexRef.current = Number.POSITIVE_INFINITY
    return heightsMoved
  }

  return { indexByKey, pinWhereTheViewStands, ensureOffsets, bestKnownHeight, realHeight, mountedCoversPane, recordMountedHeights, renderIfHeightsMovedThePane }
}

function scrollTopHeldByThePin(
  { itemKeys, heightCacheRef, listOriginRef, contentPinRef, lastWrittenTopRef, reflowHoldRef, outOfLayoutRef, laidOutRef }: VirtualScrollView,
  { indexByKey, ensureOffsets }: VirtualScrollTools,
  { box, viewportHeight, sticky, itemCount }: VirtualScrollPane,
  scrollTop: number,
): number {
  if (
    box &&
    viewportHeight > 0 &&
    !Number.isNaN(scrollTop) &&
    itemCount > 0
  ) {
    const origin = listOriginRef.current
    const committedTop = scrollTop
    const offs = ensureOffsets()
    const cache = heightCacheRef.current
    if (
      lastWrittenTopRef.current !== null &&
      committedTop !== lastWrittenTopRef.current &&
      !reflowHoldRef.current
    ) {
      pinTrace({ act: 'cancel', committed: committedTop, lastWritten: lastWrittenTopRef.current, pin: contentPinRef.current, origin })
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    }
    if (sticky) {
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    } else {
      {
        const pin = contentPinRef.current
        let pinCount = itemCount
        if (laidOutRef.current) {
          while (pinCount > 0 && !cache.has(itemKeys[pinCount - 1]!)) pinCount--
        }
        if (!pin && (pinCount === 0 || committedTop - origin > offs[pinCount]!)) {
          lastWrittenTopRef.current = committedTop
        } else if (!pin) {
          const pos = Math.max(0, Math.min(committedTop - origin, offs[pinCount]!))
          let lo = 0
          let hi = pinCount
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (offs[mid + 1]! > pos) hi = mid
            else lo = mid + 1
          }
          const idx = Math.min(lo, pinCount - 1)
          const h = cache.get(itemKeys[idx]!) ?? UNMEASURED_ESTIMATE_ROWS
          contentPinRef.current = {
            key: itemKeys[idx]!,
            inner: Math.min(Math.max(0, pos - offs[idx]!), Math.max(0, h - 1)),
          }
          lastWrittenTopRef.current = committedTop
          pinTrace({ act: 'capture', committed: committedTop, origin, idx, off: offs[idx], h, pin: contentPinRef.current, hold: reflowHoldRef.current, out: outOfLayoutRef.current })
        } else {
          const idx = indexByKey(itemKeys, pin.key)
          if (idx === undefined) {
            contentPinRef.current = null
            lastWrittenTopRef.current = null
          } else {
            const h = cache.get(itemKeys[idx]!) ?? UNMEASURED_ESTIMATE_ROWS
            const inner = Math.min(pin.inner, Math.max(0, h - 1))
            if (inner !== pin.inner && !reflowHoldRef.current) contentPinRef.current = { key: pin.key, inner }
            const target = Math.max(0, Math.floor(origin + offs[idx]! + inner))
            if (target !== committedTop) {
              pinTrace({ act: 'write', committed: committedTop, target, origin, idx, off: offs[idx], inner, h, vp: viewportHeight, hold: reflowHoldRef.current, out: outOfLayoutRef.current })
              box.pinScrollTop(target)
              lastWrittenTopRef.current = target
              scrollTop = target
            } else {
              lastWrittenTopRef.current = committedTop
            }
          }
        }
      }
    }
  }
  return scrollTop
}

function rangeToMount(
  { itemKeys, heightCacheRef, elementsRef, listOriginRef, prevScrollAtCommitRef, msPerItemEmaRef }: VirtualScrollView,
  { bestKnownHeight, realHeight }: VirtualScrollTools,
  { viewportHeight, pendingDelta, sticky, itemCount }: VirtualScrollPane,
  scrollTop: number,
  offsets: Float64Array,
  frozen: boolean,
  prevRange: readonly [number, number] | null,
): { start: number; end: number; movedDown: boolean } {
  let start: number
  let end: number
  let movedDown = false

  if (frozen && prevRange) {
    start = Math.min(prevRange[0], itemCount)
    end = Math.min(prevRange[1], itemCount)
  } else if (viewportHeight <= 0 || Number.isNaN(scrollTop)) {
    start = Math.max(0, itemCount - COLD_START_COUNT)
    end = itemCount
  } else if (sticky) {
    end = itemCount
    start = itemCount
    let accumulated = 0
    while (start > 0 && accumulated < viewportHeight + OVERSCAN_ROWS) {
      start--
      accumulated += bestKnownHeight(start)
    }
    let coverage = 0
    for (let i = start; i < end; i++) coverage += realHeight(i)
    while (
      start > 0 &&
      end - start < MAX_MOUNTED_ITEMS &&
      coverage < viewportHeight + OVERSCAN_ROWS
    ) {
      start--
      coverage += realHeight(start)
    }
    prevScrollAtCommitRef.current = Number.isNaN(scrollTop) ? 0 : scrollTop
  } else {
    const origin = listOriginRef.current
    const committed = scrollTop
    const target = scrollTop + pendingDelta
    let low = Math.min(committed, target)
    let high = Math.max(committed, target)
    const maxSpan = 3 * viewportHeight
    if (high - low > maxSpan) high = low + maxSpan
    low -= origin
    high -= origin
    if (low < 0) low = 0
    if (high < 0) high = 0

    const searchTarget = low - OVERSCAN_ROWS
    let lo = 0
    let hi = itemCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1]! > searchTarget) hi = mid
      else lo = mid + 1
    }
    start = lo

    if (prevRange) {
      for (
        let i = Math.max(0, prevRange[0]);
        i < Math.min(prevRange[1], start);
        i++
      ) {
        const key = itemKeys[i]!
        if (
          elementsRef.current.has(key) &&
          heightCacheRef.current.get(key) === undefined
        ) {
          start = i
          break
        }
      }
    }

    end = start
    let accumulated = 0
    while (end < itemCount && end - start < MAX_MOUNTED_ITEMS) {
      const covered = accumulated >= viewportHeight + 2 * OVERSCAN_ROWS
      const pastHigh = offsets[end]! > high + viewportHeight + OVERSCAN_ROWS
      if (covered && pastHigh) break
      accumulated += bestKnownHeight(end)
      end++
    }

    let coverage = 0
    for (let i = start; i < end; i++) coverage += realHeight(i)
    while (
      start > 0 &&
      end - start < MAX_MOUNTED_ITEMS &&
      coverage < viewportHeight + OVERSCAN_ROWS
    ) {
      start--
      coverage += realHeight(start)
    }

    const velocity =
      Math.abs(committed - prevScrollAtCommitRef.current) +
      Math.abs(pendingDelta)
    movedDown = committed > prevScrollAtCommitRef.current
    if (prevRange && velocity > 2 * viewportHeight) {
      const slide = clampNumber(
        Math.round(SLIDE_BUDGET_MS / msPerItemEmaRef.current),
        SLIDE_MIN_ITEMS,
        SLIDE_MAX_ITEMS,
      )
      const overlaps =
        start <= prevRange[1] + slide && end >= prevRange[0] - slide
      if (overlaps) {
        const cappedStart = Math.max(start, prevRange[0] - slide)
        let cappedEnd = Math.min(end, prevRange[1] + slide)
        if (cappedEnd <= cappedStart) {
          cappedEnd = Math.min(itemCount, cappedStart + slide)
        }
        start = cappedStart
        end = cappedEnd
      }
    }
    prevScrollAtCommitRef.current = committed
  }
  return { start, end, movedDown }
}

function rangeToShow(
  { listOriginRef }: VirtualScrollView,
  { mountedCoversPane }: VirtualScrollTools,
  { viewportHeight, pendingDelta, sticky }: VirtualScrollPane,
  scrollTop: number,
  offsets: Float64Array,
  immediateRange: readonly [number, number],
  deferredRange: readonly [number, number],
  movedDown: boolean,
): readonly [number, number] {
  let effectiveStart = Math.max(immediateRange[0], deferredRange[0])
  let effectiveEnd = Math.min(immediateRange[1], deferredRange[1])
  const inverted = effectiveStart > effectiveEnd
  if (inverted || sticky) {
    effectiveStart = immediateRange[0]
    effectiveEnd = immediateRange[1]
  } else {
    if (pendingDelta > 0 || movedDown) effectiveEnd = immediateRange[1]
    if (pendingDelta === 0 && !mountedCoversPane(effectiveStart, effectiveEnd)) {
      effectiveStart = immediateRange[0]
      effectiveEnd = immediateRange[1]
    }
  }

  if (effectiveEnd - effectiveStart > MAX_MOUNTED_ITEMS) {
    const viewportCenter = Number.isNaN(scrollTop)
      ? offsets[effectiveEnd]!
      : scrollTop - listOriginRef.current + viewportHeight / 2
    const distanceToStart = Math.abs(viewportCenter - offsets[effectiveStart]!)
    const distanceToEnd = Math.abs(offsets[effectiveEnd]! - viewportCenter)
    if (distanceToStart <= distanceToEnd) {
      effectiveEnd = effectiveStart + MAX_MOUNTED_ITEMS
    } else {
      effectiveStart = effectiveEnd - MAX_MOUNTED_ITEMS
    }
  }
  return [effectiveStart, effectiveEnd]
}
