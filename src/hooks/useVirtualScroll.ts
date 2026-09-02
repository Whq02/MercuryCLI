
import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { DOMElement } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'

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

export type VirtualScrollResult = {
  range: readonly [number, number]
  topSpacer: number
  bottomSpacer: number
  measureRef: (key: string) => (el: DOMElement | null) => void
  spacerRef: (el: DOMElement | null) => void
  offsets: ArrayLike<number>
  getItemTop: (index: number) => number
  getItemElement: (index: number) => DOMElement | null
  getItemHeight: (index: number) => number | undefined
  scrollToIndex: (index: number) => void
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type ContentPin = { key: string; inner: number }

export function useVirtualScroll(
  scrollRef: { current: ScrollBoxHandle | null },
  itemKeys: readonly string[],
  columns: number,
): VirtualScrollResult {
  const itemCount = itemKeys.length
  const renderStartMs = performance.now()

  const heightCacheRef = useRef(new Map<string, number>())
  const elementsRef = useRef(new Map<string, DOMElement>())
  const refCallbacksRef = useRef(
    new Map<string, (el: DOMElement | null) => void>(),
  )
  const offsetsVersionRef = useRef(0)
  const offsetsBufferRef = useRef<Float64Array>(new Float64Array(0))
  const offsetsBuiltVersionRef = useRef(-1)
  const offsetsBuiltCountRef = useRef(-1)
  const offsetsBuiltKeysRef = useRef<readonly string[] | null>(null)
  const listOriginRef = useRef(0)
  const spacerElementRef = useRef<DOMElement | null>(null)
  const prevRangeRef = useRef<readonly [number, number] | null>(null)
  const prevColumnsRef = useRef(columns)
  const prevItemKeysRef = useRef(itemKeys)
  const measurementSkipRef = useRef(false)
  const freezeRendersRef = useRef(0)
  const prevScrollAtCommitRef = useRef(0)
  const msPerItemEmaRef = useRef(INITIAL_MS_PER_ITEM)
  const contentPinRef = useRef<ContentPin | null>(null)
  const lastWrittenTopRef = useRef<number | null>(null)
  const keyIndexRef = useRef<{ keys: readonly string[] | null; map: Map<string, number>; indexed: number }>({
    keys: null,
    map: new Map(),
    indexed: 0,
  })
  const minChangedIndexRef = useRef(Number.POSITIVE_INFINITY)
  const reflowHoldRef = useRef(false)
  const [, forceResolve] = useReducer((n: number) => n + 1, 0)

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

  if (columns !== prevColumnsRef.current) {
    const ratio = prevColumnsRef.current / columns
    prevColumnsRef.current = columns
    const cache = heightCacheRef.current
    for (const [key, height] of cache) {
      cache.set(key, scaleHeightForWidth(height, ratio))
    }
    offsetsVersionRef.current += 1
    measurementSkipRef.current = true
    freezeRendersRef.current = 2
    reflowHoldRef.current = true
  }

  if (itemKeys !== prevItemKeysRef.current) {
    prevItemKeysRef.current = itemKeys
    const alive = new Set(itemKeys)
    let dropped = false
    for (const key of heightCacheRef.current.keys()) {
      if (!alive.has(key)) {
        heightCacheRef.current.delete(key)
        dropped = true
      }
    }
    for (const key of refCallbacksRef.current.keys()) {
      if (!alive.has(key)) refCallbacksRef.current.delete(key)
    }
    if (dropped) offsetsVersionRef.current += 1
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
    let buffer = offsetsBufferRef.current
    if (buffer.length < count + 1) {
      buffer = new Float64Array(count + 1)
      offsetsBufferRef.current = buffer
    }
    const cache = heightCacheRef.current
    let accumulated = 0
    for (let i = 0; i < count; i++) {
      buffer[i] = accumulated
      accumulated += cache.get(keys[i]!) ?? UNMEASURED_ESTIMATE_ROWS
    }
    buffer[count] = accumulated
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

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const box = scrollRef.current
      if (!box) return () => {}
      return box.subscribe(onStoreChange)
    },
    [scrollRef],
  )
  const getScrollSnapshot = useCallback((): number => {
    const box = scrollRef.current
    if (!box) return NaN
    const bin = Math.floor(
      (box.getScrollTop() + box.getPendingDelta()) / SCROLL_BIN_ROWS,
    )
    return box.isSticky() ? ~bin : bin
  }, [scrollRef])
  useSyncExternalStore(subscribe, getScrollSnapshot)

  const box = scrollRef.current
  const viewportHeight = box?.getViewportHeight() ?? 0
  let scrollTop = box?.getScrollTop() ?? NaN
  const pendingDelta = box?.getPendingDelta() ?? 0
  const sticky = box ? box.isSticky() : true

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
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    }
    if (sticky) {
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    } else {
      {
        const pin = contentPinRef.current
        if (!pin && committedTop - origin > offs[itemCount]!) {
          lastWrittenTopRef.current = committedTop
        } else if (!pin) {
          const pos = Math.max(0, Math.min(committedTop - origin, offs[itemCount]!))
          let lo = 0
          let hi = itemCount
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (offs[mid + 1]! > pos) hi = mid
            else lo = mid + 1
          }
          const idx = Math.min(lo, itemCount - 1)
          const h = cache.get(itemKeys[idx]!) ?? UNMEASURED_ESTIMATE_ROWS
          contentPinRef.current = {
            key: itemKeys[idx]!,
            inner: Math.min(Math.max(0, pos - offs[idx]!), Math.max(0, h - 1)),
          }
          lastWrittenTopRef.current = committedTop
        } else {
          const idx = indexByKey(itemKeys, pin.key)
          if (idx === undefined) {
            contentPinRef.current = null
            lastWrittenTopRef.current = null
          } else {
            const h = cache.get(itemKeys[idx]!) ?? UNMEASURED_ESTIMATE_ROWS
            const inner = Math.min(pin.inner, Math.max(0, h - 1))
            const target = Math.max(0, Math.floor(origin + offs[idx]! + inner))
            if (target !== committedTop && pendingDelta === 0) {
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

  const offsets = ensureOffsets()
  let start: number
  let end: number
  const frozen = freezeRendersRef.current > 0
  const prevRange = prevRangeRef.current
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

  const rangeStart = start
  const rangeEnd = end
  const immediateRange = useMemo(
    (): readonly [number, number] => [rangeStart, rangeEnd],
    [rangeStart, rangeEnd],
  )
  const deferredRange = useDeferredValue(immediateRange)
  let effectiveStart = Math.max(immediateRange[0], deferredRange[0])
  let effectiveEnd = Math.min(immediateRange[1], deferredRange[1])
  const inverted = effectiveStart > effectiveEnd
  if (inverted || sticky) {
    effectiveStart = immediateRange[0]
    effectiveEnd = immediateRange[1]
  } else if (pendingDelta > 0 || movedDown) {
    effectiveEnd = immediateRange[1]
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

  const topSpacer = offsets[effectiveStart] ?? 0
  const bottomSpacer = (offsets[itemCount] ?? 0) - (offsets[effectiveEnd] ?? 0)

  const prevCommittedRangeRef = useRef<readonly [number, number] | null>(null)
  useLayoutEffect(() => {
    const prev = prevCommittedRangeRef.current
    const freshCount = prev
      ? Math.max(0, prev[0] - effectiveStart) +
        Math.max(0, effectiveEnd - prev[1])
      : effectiveEnd - effectiveStart
    if (freshCount >= MOUNT_COST_SAMPLE_MIN) {
      const perItem = clampNumber(
        (performance.now() - renderStartMs) / freshCount,
        MOUNT_COST_CLAMP_MIN_MS,
        MOUNT_COST_CLAMP_MAX_MS,
      )
      msPerItemEmaRef.current =
        msPerItemEmaRef.current * (1 - MOUNT_COST_EMA_WEIGHT) +
        perItem * MOUNT_COST_EMA_WEIGHT
    }
    prevCommittedRangeRef.current = [effectiveStart, effectiveEnd]
  })

  useLayoutEffect(() => {
    const handle = scrollRef.current
    if (!handle) return
    if (sticky) {
      handle.setClampBounds(undefined, undefined)
      return
    }
    const origin = listOriginRef.current
    const min = effectiveStart === 0 ? 0 : topSpacer + origin
    if (effectiveEnd >= itemCount) {
      handle.setClampBounds(min, undefined)
      return
    }
    const max =
      Math.max((offsets[effectiveEnd] ?? 0) - viewportHeight, topSpacer) +
      origin
    handle.setClampBounds(min, max)
  })

  useLayoutEffect(() => {
    const spacer = spacerElementRef.current
    if (spacer?.layoutNode && spacer.layoutNode.getComputedWidth() > 0) {
      listOriginRef.current = spacer.layoutNode.getComputedTop()
    }
    if (freezeRendersRef.current > 0) freezeRendersRef.current -= 1
    if (measurementSkipRef.current) {
      measurementSkipRef.current = false
      if (reflowHoldRef.current) forceResolve()
      return
    }
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
    if (offsetsVersionRef.current !== offsetsBuiltVersionRef.current) {
      const changedFrom = minChangedIndexRef.current
      if (contentPinRef.current && Number.isFinite(changedFrom)) {
        const pinIdx = indexByKey(prevItemKeysRef.current, contentPinRef.current.key)
        if (pinIdx === undefined || changedFrom < pinIdx) forceResolve()
      }
    }
    minChangedIndexRef.current = Number.POSITIVE_INFINITY
    if (reflowHoldRef.current) {
      if (freezeRendersRef.current > 0) {
        forceResolve()
      } else if (offsetsVersionRef.current !== offsetsBuiltVersionRef.current) {
        forceResolve()
      } else {
        reflowHoldRef.current = false
      }
    }
  })

  const measureRef = useCallback(
    (key: string): ((el: DOMElement | null) => void) => {
      let callback = refCallbacksRef.current.get(key)
      if (!callback) {
        callback = (el: DOMElement | null): void => {
          if (el) {
            elementsRef.current.set(key, el)
            return
          }
          const previous = elementsRef.current.get(key)
          if (previous?.layoutNode && !measurementSkipRef.current) {
            const height = previous.layoutNode.getComputedHeight()
            const width = previous.layoutNode.getComputedWidth()
            if (
              (height > 0 || width > 0) &&
              heightCacheRef.current.get(key) !== height
            ) {
              heightCacheRef.current.set(key, height)
              offsetsVersionRef.current += 1
              const idx = indexByKey(prevItemKeysRef.current, key)
              minChangedIndexRef.current = Math.min(minChangedIndexRef.current, idx ?? 0)
            }
          }
          elementsRef.current.delete(key)
        }
        refCallbacksRef.current.set(key, callback)
      }
      return callback
    },
    [],
  )

  const spacerRef = useCallback((el: DOMElement | null): void => {
    spacerElementRef.current = el
  }, [])

  const getItemElement = useCallback(
    (index: number): DOMElement | null => {
      const key = itemKeys[index]
      if (key === undefined) return null
      return elementsRef.current.get(key) ?? null
    },
    [itemKeys],
  )

  const getItemTop = useCallback(
    (index: number): number => {
      const key = itemKeys[index]
      if (key === undefined) return -1
      const element = elementsRef.current.get(key)
      const layout = element?.layoutNode
      if (!layout || layout.getComputedWidth() <= 0) return -1
      return layout.getComputedTop()
    },
    [itemKeys],
  )

  const getItemHeight = useCallback(
    (index: number): number | undefined => {
      const key = itemKeys[index]
      if (key === undefined) return undefined
      return heightCacheRef.current.get(key)
    },
    [itemKeys],
  )

  const scrollToIndex = useCallback(
    (index: number): void => {
      const handle = scrollRef.current
      if (!handle) return
      const keys = prevItemKeysRef.current
      if (index < 0 || index >= keys.length) return
      const buffer = ensureOffsets(keys)
      handle.scrollTo(buffer[index]! + listOriginRef.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollRef],
  )

  prevRangeRef.current = frozen && prevRange ? prevRange : immediateRange

  return {
    range: [effectiveStart, effectiveEnd],
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  }
}
