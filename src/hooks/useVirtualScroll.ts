// React-level virtualization for the message list inside a ScrollBox:
// mount-range computation, height measurement/caching, spacers, clamp bounds,
// and a budgeted slide under fast scroll. Every constant and guard here
// encodes a specific past failure — see the acceptance checks before
// "simplifying" any of them.

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

// Deliberately LOW: guessing too tall stops the coverage walk early and shows
// spacer at the bottom of the screen; too short merely widens the window into
// rows the overscan absorbed anyway.
//
// The estimate is a PROVISIONAL coordinate only. Page travel never settles
// on it: the resting content pin re-derives the viewport-top coordinate
// against the same offsets build every render paints from, so when a
// crossed span measures and the offsets rebuild, the same content stays at
// the top — the estimate-COMPRESSION class (the
// SPEED-pageup-travel-regression finding: a composed-row page step crossed
// pageStep/estimate ITEMS, up to 104 real rows per 24-row press; both
// cheaper candidates measured and reverted by the Q3 lane) cannot reach a
// settled landing. scripts/scroll/prove-scroll-travel.ts pins this.
const UNMEASURED_ESTIMATE_ROWS = 3
const OVERSCAN_ROWS = 80
const COLD_START_COUNT = 30
// Half the overscan: the largest bin that is still safe — however far the
// position drifts inside one bin, the other half of the overscan is mounted
// ahead of it.
const SCROLL_BIN_ROWS = OVERSCAN_ROWS / 2
// Coverage math assumes the worst case: an unmeasured row may be one line.
const PESSIMISTIC_ROWS = 1

/** The width-resize height scale: scale, floor
 *  at ONE line — except a recorded ZERO. Zero is not a short row: it is a
 *  row that painted NOTHING (collapsed/hidden), and the old
 *  `Math.max(1, …)` promoted every such row to one phantom line on EVERY
 *  width change, permanently inflating the transcript's geometry (offsets
 *  grew by the invisible-row count per resize; travel and the clamp both
 *  read them). Pure and exported — prove-scroll-travel drives it directly. */
export function scaleHeightForWidth(height: number, ratio: number): number {
  if (height === 0) return 0
  return Math.max(1, Math.round(height * ratio))
}
const MAX_MOUNTED_ITEMS = 300
const SLIDE_BUDGET_MS = 8
const SLIDE_MIN_ITEMS = 8
const SLIDE_MAX_ITEMS = 60
// Seeded at 25 items per 8 ms.
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
  /** A reused buffer possibly LONGER than the item count: index it through
   *  `itemKeys.length` — its own length is the buffer's, not the item
   *  count. */
  offsets: ArrayLike<number>
  getItemTop: (index: number) => number
  getItemElement: (index: number) => DOMElement | null
  getItemHeight: (index: number) => number | undefined
  scrollToIndex: (index: number) => void
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The resting viewport-top content coordinate: a real row inside a real
 *  item. Captured when the viewport comes to rest; re-derived against every
 *  offsets rebuild so the same content stays at the top. */
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
  // ── Content-coordinate scroll model state ───────────────────────────────
  // The pin is the resting viewport-top content coordinate, re-resolved
  // against the SAME offsets build the spacer renders from, so the painted
  // pair (spacer, scrollTop) can never disagree about which content sits at
  // the viewport top — the estimate→real expansion displacement enters
  // exactly when those two come from different builds.
  const contentPinRef = useRef<ContentPin | null>(null)
  /** The last scrollTop THIS model wrote (floored); a differing committed
   *  value means an outside actor (wheel drain, absolute jump, sticky
   *  follow) moved the viewport — theirs wins, the model re-captures. */
  const lastWrittenTopRef = useRef<number | null>(null)
  const keyIndexRef = useRef<{ keys: readonly string[] | null; map: Map<string, number>; indexed: number }>({
    keys: null,
    map: new Map(),
    indexed: 0,
  })
  const minChangedIndexRef = useRef(Number.POSITIVE_INFINITY)
  /** True from a column-resize render until the first real post-reflow
   *  measurement fold. While held: the outside-actor cancel is suspended
   *  (mid-reflow scrollTop moves are clamp/paint shoves, not user intent —
   *  a real wheel still wins through the pending-delta suspension), and the
   *  measurement effect keeps forcing re-resolve renders so the pin
   *  converges back onto its content as real widths fold in. Without this
   *  the reflow's transient displacement CANCELLED the pin, which then
   *  re-captured the displaced position as its new truth (measured: three
   *  turns on a 120→80 reflow at rest). */
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
      // The list appends IN PLACE (VirtualMessageList keeps the array's
      // identity across appends), so an identity check alone froze the map
      // at its first build and every key pushed since resolved to undefined:
      // the content pin was dropped for exactly the rows a live reader
      // scrolls through, and the changed-index gate fell to 0 on every
      // measure (ctr-1). The map follows the tail.
      for (let i = ki.indexed; i < keys.length; i++) ki.map.set(keys[i]!, i)
      ki.indexed = keys.length
    }
    return ki.map.get(key)
  }

  // ── Resize handling (detected during render) ────────────────────────────
  // Scale, don't clear: an emptied cache costs a multi-hundred-millisecond
  // stall re-mounting ~200 items on the first resize of a long conversation.
  if (columns !== prevColumnsRef.current) {
    const ratio = prevColumnsRef.current / columns
    prevColumnsRef.current = columns
    const cache = heightCacheRef.current
    for (const [key, height] of cache) {
      cache.set(key, scaleHeightForWidth(height, ratio))
    }
    offsetsVersionRef.current += 1
    // The next layout effect reads pre-resize geometry; measuring from it
    // would poison the scaled values.
    measurementSkipRef.current = true
    freezeRendersRef.current = 2
    reflowHoldRef.current = true
  }

  // ── Cache GC (item-key array identity change only) ──────────────────────
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

  // ── Offsets (lazily rebuilt during render; ref-based invalidation) ──────
  // A state-driven invalidation would schedule the extra commit measurement
  // deliberately avoids.
  // Parametrized so event-time callers (scrollToIndex) build against the
  // CURRENT key array rather than a stale render closure.
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

  // ── The re-render snapshot ──────────────────────────────────────────────
  // Binned from the TARGET position (committed + pending) so a scroll request
  // re-renders for its destination; the sticky flag folds into the same
  // scalar (bitwise complement) so a sticky flip re-renders on an unchanged
  // bin; no container ⇒ NaN, which is self-equal under the store's identity
  // comparison and does not spin.
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
  // Before the container attaches, sticky reads TRUE.
  const sticky = box ? box.isSticky() : true

  // ── Content-coordinate resolution (render-phase, before the range walk) ──
  // The resting pin re-derives the composed scrollTop from the SAME offsets
  // build this render's spacer will use, and the corrected value feeds the
  // range computation below — the painted pair can never disagree about
  // which content sits at the viewport top. An in-flight wheel delta
  // suspends writes (the drain owns the viewport, and its next committed
  // move cancels the model through outside-actor detection).
  //
  // Resolution runs on FROZEN (resize) renders too: the reflow render paints
  // its spacer from the freshly SCALED offsets, so the pin must re-derive
  // against that same build or the pair splits for two frames — measured as
  // a 3-turn resting displacement on a 120→80 reflow, with the clamp effect
  // then shoving scrollTop and the outside-actor rule cancelling the pin at
  // the displaced position. Only measurement is frozen; pairing is not.
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
      // An outside actor (wheel drain, absolute jump, follow) moved the
      // viewport: their position wins; the model re-captures from it.
      // Suspended across a reflow: those moves are clamp/paint shoves, and
      // the pin must survive them to restore its content.
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    }
    if (sticky) {
      // The renderer's own bottom pin owns a sticky viewport.
      contentPinRef.current = null
      lastWrittenTopRef.current = null
    } else {
      {
        const pin = contentPinRef.current
        if (!pin && committedTop - origin > offs[itemCount]!) {
          // The viewport top sits below the whole list (a shrink transient,
          // FLUX S6 territory): a pin captured here would snap to the tail
          // and yank the view on its first derive. Defer until the position
          // is inside the list.
          lastWrittenTopRef.current = committedTop
        } else if (!pin) {
          // Capture the resting coordinate. Never writes — capture adopts
          // the committed position as its own.
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

  // ── Range computation ───────────────────────────────────────────────────
  const offsets = ensureOffsets()
  let start: number
  let end: number
  const frozen = freezeRendersRef.current > 0
  const prevRange = prevRangeRef.current

  if (frozen && prevRange) {
    // Column change settling: both frozen renders reuse the pre-resize range
    // (clamped in case items were removed).
    start = Math.min(prevRange[0], itemCount)
    end = Math.min(prevRange[1], itemCount)
  } else if (viewportHeight <= 0 || Number.isNaN(scrollTop)) {
    // Cold start: the container starts pinned to the bottom, so the tail is
    // the right first guess.
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
    // Estimate-based back-walks can undershoot: re-walk on real heights.
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
    // A free-spinning wheel grows the pending delta without bound; one
    // commit must never mount hundreds of fresh rows. Scrolling up keeps the
    // window near the target, scrolling down near the committed position —
    // both are the low end of the span.
    const maxSpan = 3 * viewportHeight
    if (high - low > maxSpan) high = low + maxSpan
    // Translate to list-local THEN clamp at zero, in that order: a negative
    // low bound would drag start to the first item while high stayed put.
    low -= origin
    high -= origin
    if (low < 0) low = 0
    if (high < 0) high = 0

    // Binary search over the monotone offsets: first index whose END offset
    // lies past (low − overscan). A linear walk is a step per message.
    const searchTarget = low - OVERSCAN_ROWS
    let lo = 0
    let hi = itemCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1]! > searchTarget) hi = mid
      else lo = mid + 1
    }
    start = lo

    // Start-advance guard: never advance past a mounted-but-unmeasured item
    // (its spacer contribution would use the estimate and visibly jump).
    // Only the previous mount range is scanned.
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

    // End extension: cover viewport + two overscans AND run past the high
    // bound + viewport + overscan, capped at start + 300.
    end = start
    let accumulated = 0
    while (end < itemCount && end - start < MAX_MOUNTED_ITEMS) {
      const covered = accumulated >= viewportHeight + 2 * OVERSCAN_ROWS
      const pastHigh = offsets[end]! > high + viewportHeight + OVERSCAN_ROWS
      if (covered && pastHigh) break
      accumulated += bestKnownHeight(end)
      end++
    }

    // Start back-fill on real heights.
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

    // Budgeted slide under fast scroll, growth-only per side, with the
    // teleport exception (walking a slide at a time across a disjoint gap
    // mounts and discards ranges nobody ever sees).
    const velocity =
      Math.abs(committed - prevScrollAtCommitRef.current) +
      Math.abs(pendingDelta)
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
          // Capping the end below an advanced start would blank the viewport.
          cappedEnd = Math.min(itemCount, cappedStart + slide)
        }
        start = cappedStart
        end = cappedEnd
      }
    }
    prevScrollAtCommitRef.current = committed
  }

  // ── Deferred range (time slicing) ───────────────────────────────────────
  // Only growth is worth deferring; an unmount costs nothing. The tuple
  // identity must be stable for unchanged values, or useDeferredValue chases
  // a fresh reference every render and never converges.
  const rangeStart = start
  const rangeEnd = end
  const immediateRange = useMemo(
    (): readonly [number, number] => [rangeStart, rangeEnd],
    [rangeStart, rangeEnd],
  )
  const deferredRange = useDeferredValue(immediateRange)
  let effectiveStart = Math.max(immediateRange[0], deferredRange[0])
  let effectiveEnd = Math.min(immediateRange[1], deferredRange[1])
  // The deferral escapes on a STRICTLY inverted range (an equal empty range
  // keeps the deferred clamp); a large jump or a jump-to-bottom mounts the
  // fresh edge NOW; a downward scroll bypasses the deferral of the range END
  // only — the start stays deferred (time-slicing retained while scrolling
  // down).
  const inverted = effectiveStart > effectiveEnd
  if (inverted || sticky) {
    effectiveStart = immediateRange[0]
    effectiveEnd = immediateRange[1]
  } else if (pendingDelta > 0) {
    effectiveEnd = immediateRange[1]
  }

  // Final size enforcement, trimmed by VIEWPORT POSITION, not scroll
  // direction — direction alternates while a burst settles and each
  // alternation moves the top spacer.
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

  // ── Mount-cost measurement ──────────────────────────────────────────────
  // Declared BEFORE the clamp and measurement effects so it stamps its end
  // time first. Samples only commits that mounted at least three fresh
  // items; a single wild sample is clamped before folding in.
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

  // ── Clamp bounds (never during render; from the EFFECTIVE range) ────────
  useLayoutEffect(() => {
    const handle = scrollRef.current
    if (!handle) return
    if (sticky) {
      // The renderer pins the position authoritatively; a stale clamp from
      // before the pin would fight it.
      handle.setClampBounds(undefined, undefined)
      return
    }
    const origin = listOriginRef.current
    const min = effectiveStart === 0 ? 0 : topSpacer + origin
    if (effectiveEnd >= itemCount) {
      // No finite maximum: the height cache trails a streaming tail row, and
      // a cache-derived bound would hold the viewport above the live text.
      handle.setClampBounds(min, undefined)
      return
    }
    const max =
      Math.max((offsets[effectiveEnd] ?? 0) - viewportHeight, topSpacer) +
      origin
    handle.setClampBounds(min, max)
  })

  // ── Measurement (every commit; no dependency list) ──────────────────────
  useLayoutEffect(() => {
    // The list origin refreshes FIRST, before the resize skip check, so it
    // still updates on a skipped render. It is read from the top spacer's
    // laid-out top (never reconstructed arithmetically — a stale cache makes
    // that difference go negative and the window leaves the screen).
    const spacer = spacerElementRef.current
    if (spacer?.layoutNode && spacer.layoutNode.getComputedWidth() > 0) {
      listOriginRef.current = spacer.layoutNode.getComputedTop()
    }
    if (freezeRendersRef.current > 0) freezeRendersRef.current -= 1
    if (measurementSkipRef.current) {
      measurementSkipRef.current = false
      // Mid-reflow: the skip commit folds nothing, so nothing else would
      // schedule the next render — force it, or the reflow transient parks
      // on screen until an unrelated render happens by.
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
        // Width is the proof layout ran: the row genuinely rendered nothing,
        // and a recorded zero is what lets the start-advance guard move on.
        if (cache.get(key) !== 0) {
          cache.set(key, 0)
          offsetsVersionRef.current += 1
          const idx = indexByKey(prevItemKeysRef.current, key)
          minChangedIndexRef.current = Math.min(minChangedIndexRef.current, idx ?? 0)
        }
      }
      // height == 0 and width == 0: layout has not run; skip.
    }
    // No state updates here — the one-frame lag is what the overscan is
    // for — EXCEPT when the resting pin needs the fresh heights folded into
    // its coordinate: one re-resolve render pairs the corrected scrollTop
    // with the rebuilt spacer. Bounded: it fires only while measurements
    // actually changed, and only when they can move the viewport-top
    // coordinate (a change strictly above the pin), so a streaming tail
    // below a scrolled-up reader stays cold.
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
        // Post-reflow folds are still arriving (items re-measure at the new
        // width over several commits, and the changed-above-pin gate would
        // skip folds at or below the pin): force the re-derive for every
        // fold until the heights go quiet.
        forceResolve()
      } else {
        // Quiescent: the reflow is fully folded; outside actors win again.
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
          // The null branch captures the final height at unmount (the layout
          // node is still valid at that moment) — skipped while the resize
          // measurement skip is set, whose geometry is pre-resize.
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
      // Event handlers run between renders: the offsets must come from the
      // cache against the CURRENT key array, not a render-time closure. The
      // range logic derives start from the same offsets, so the two agree
      // by construction.
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
