// The virtualized transcript: incremental keys, windowing through the
// shared virtual-scroll hook, the disclosure item wrapper with single-owner
// hover, the cursor-navigation handle, the search/jump engine, and the
// sticky-prompt tracker. The tracker renders AFTER the items and produces
// no layout node: placing it before them would make every fine-grained
// commit driven by its own scroll subscription reconcile through the
// sibling items on the way in.

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, elementScreenLeft } from '../ink.js'
import type { DOMElement } from '../ink/dom.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { MatchPosition } from '../ink/render-to-screen.js'
import type { SearchPositionsState } from '../ink/hooks/use-search-highlight.js'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import { ScrollChromeContext } from './FullscreenLayout.js'
import { InteractiveDisclosure } from './mercury-ui/InteractiveDisclosure.js'
import { useHoverOwned } from './mercury-ui/useHoverOwned.js'
import { claimHover, releaseHover } from '../utils/cockpit/hoverOwner.js'
import type { RenderableMessage } from '../types/message.js'
import {
  facetsSatisfy,
  parseSearchQuery,
  renderableSearchText,
  type SearchQuery,
  type TranscriptFacets,
} from '../utils/transcriptSearch.js'
import { TextHoverColorContext } from './design-system/ThemedText.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { reconcileItemKeys, type ItemKeyState } from './virtualListKeys.js'
import {
  isNavigableMessage,
  stripSystemReminders,
  toolCallOf,
  type MessageActionsNav,
  type MessageActionsState,
} from './messageActions.js'

/** Rows of headroom left above a jump target. */
const JUMP_HEADROOM_ROWS = 3
/** Consecutive phantom matches (engine yes, renderer no) before the
 *  auto-advance stops. */
const PHANTOM_LIMIT = 20
/** Mount attempts before a jump target is abandoned. */
const MOUNT_ATTEMPT_LIMIT = 3
/** Index-warming chunk size. */
const WARM_CHUNK = 500
/** Sticky header text budget, applied BEFORE whitespace collapsing. */
const STICKY_TEXT_CAP = 500

export type StickyPrompt = { text: string; scrollTo: () => void } | 'clicked'

export type JumpHandle = {
  jumpToIndex: (index: number) => void
  setSearchQuery: (query: string) => void
  nextMatch: () => void
  prevMatch: () => void
  /** Capture the current scroll top as the search anchor. */
  setAnchor: () => void
  /** Walk every message in chunks, yielding before each chunk; resolves to
   *  the measured WORK milliseconds (rounded), or 0 when already warm. */
  warmSearchIndex: () => Promise<number>
  /** Manual-scroll invalidation only — never wired to programmatic
   *  scrolls. */
  disarmSearch: () => void
}

export type VirtualMessageListProps = {
  messages: readonly RenderableMessage[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
  itemKey: (msg: RenderableMessage, index: number) => string
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode
  /** Fires only when the click landed on a non-blank cell. */
  onItemClick?: (msg: RenderableMessage) => void
  /** Default: all clickable (an item is clickable only when the click
   *  callback also exists). */
  isItemClickable?: (msg: RenderableMessage) => boolean
  isItemExpanded?: (msg: RenderableMessage) => boolean
  /** Per-message search text (the transcript owner caches lowering); a
   *  local lowered cache over the renderable text otherwise. */
  extractSearchText?: (msg: RenderableMessage) => string
  /** Facet extractor; without one the facet operators match nothing. */
  extractFacets?: (msg: RenderableMessage) => TranscriptFacets
  trackStickyPrompt?: boolean
  selectedIndex: number | undefined
  cursorNavRef?: React.Ref<MessageActionsNav | null>
  setCursor?: (cursor: MessageActionsState | null) => void
  jumpRef?: React.Ref<JumpHandle | null>
  /** Reports (total, 1-based current); zero matches reports current 0. */
  onSearchMatchesChange?: (total: number, current: number) => void
  /** Paint-and-scan an existing element for match positions. */
  scanElement?: (el: DOMElement) => MatchPosition[]
  /** The current-match overlay setter. */
  setPositions?: (state: SearchPositionsState | null) => void
}

let instanceCounter = 0

// ── the item wrapper ────────────────────────────────────────────────────────

/** NOT memoized on purpose: the render function captures changing state
 *  (cursor, selection, verbose) — a comparator that ignored it would render
 *  from a stale closure, and including it defeats the memo anyway. */
function VirtualItem({
  hoverId,
  expanded,
  clickable,
  measureRef,
  onClick,
  children,
}: {
  hoverId: string
  expanded: boolean
  clickable: boolean
  measureRef: (el: DOMElement | null) => void
  onClick: ((event: ClickEvent) => void) | undefined
  children: React.ReactNode
}): React.ReactNode {
  // A row only counts as hovered when it is also clickable.
  const hovered = useHoverOwned(hoverId) && clickable
  return (
    <InteractiveDisclosure
      rowRef={measureRef}
      expanded={expanded}
      clickable={clickable}
      onToggle={onClick}
      onHoverIn={() => {
        claimHover(hoverId)
      }}
      onHoverOut={() => {
        releaseHover(hoverId)
      }}
    >
      <TextHoverColorContext.Provider
        value={hovered && !expanded ? 'text' : undefined}
      >
        {children}
      </TextHoverColorContext.Provider>
    </InteractiveDisclosure>
  )
}

// ── the search engine (imperative, held in refs) ────────────────────────────

type SearchEngineState = {
  query: SearchQuery | null
  /** Per-message occurrence counts. */
  counts: number[]
  /** Prefix sums (counts before message i). */
  prefix: number[]
  total: number
  /** Index of the message currently holding the highlight, or -1. */
  messagePointer: number
  /** Ordinal of the current occurrence inside that message. */
  ordinal: number
  /** The message pointer a step cycle started from (wrap guard). */
  wrapStart: number
  phantomRun: number
  mountAttempts: number
  seekInFlight: boolean
  queuedStep: 1 | -1 | null
  anchor: number | null
  pendingTimer: ReturnType<typeof setTimeout> | null
  warm: boolean
}

function newEngineState(): SearchEngineState {
  return {
    query: null,
    counts: [],
    prefix: [],
    total: 0,
    messagePointer: -1,
    ordinal: 0,
    wrapStart: -1,
    phantomRun: 0,
    mountAttempts: 0,
    seekInFlight: false,
    queuedStep: null,
    anchor: null,
    pendingTimer: null,
    warm: false,
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

// ── the component ───────────────────────────────────────────────────────────

export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  onItemClick,
  isItemClickable,
  isItemExpanded,
  extractSearchText,
  extractFacets,
  trackStickyPrompt = false,
  selectedIndex,
  cursorNavRef,
  setCursor,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: VirtualMessageListProps): React.ReactNode {
  const [instanceId] = useState(() => `vml-${++instanceCounter}`)

  // ── incremental keys ──────────────────────────────────────────────────
  // Exact per index and unique among siblings (virtualListKeys): a pure
  // append keeps the array's identity; an insertion, replacement or shrink
  // re-derives only the moved suffix into a fresh array.
  const keysStateRef = useRef<ItemKeyState<RenderableMessage> | null>(null)
  keysStateRef.current = reconcileItemKeys(keysStateRef.current, messages, itemKey)
  const itemKeys: string[] = keysStateRef.current.keys

  const vs = useVirtualScroll(scrollRef, itemKeys, columns)

  // ── search text + facet caches ────────────────────────────────────────
  const loweredCacheRef = useRef(new WeakMap<object, string>())
  const searchTextOf = useCallback(
    (msg: RenderableMessage): string => {
      if (extractSearchText) return extractSearchText(msg)
      const cache = loweredCacheRef.current
      const cached = cache.get(msg)
      if (cached !== undefined) return cached
      const lowered = renderableSearchText(msg).toLowerCase()
      cache.set(msg, lowered)
      return lowered
    },
    [extractSearchText],
  )

  // ── navigability with measurement ─────────────────────────────────────
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  const isVisibleAt = useCallback(
    (index: number): boolean => {
      const msg = messagesRef.current[index]
      if (!msg) return false
      // An unmeasured height counts as visible; exactly zero does not.
      if (vs.getItemHeight(index) === 0) return false
      return isNavigableMessage(msg)
    },
    [vs],
  )

  const publishCursor = useCallback(
    (index: number): void => {
      const msg = messagesRef.current[index]
      if (!msg || !setCursor) return
      const call = toolCallOf(msg)
      setCursor({
        uuid: (msg as { uuid: string }).uuid,
        type: msg.type,
        expanded: false,
        toolName: call?.name,
      })
    },
    [setCursor],
  )

  const exitCursorMode = useCallback((): void => {
    setCursor?.(null)
    scrollRef.current?.scrollToBottom()
  }, [setCursor, scrollRef])

  useImperativeHandle(
    cursorNavRef,
    (): MessageActionsNav => ({
      enter: () => {
        // The newest navigable USER message.
        for (let i = messagesRef.current.length - 1; i >= 0; i--) {
          if (messagesRef.current[i]!.type === 'user' && isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      prev: () => {
        const from = selectedIndexRef.current
        if (from === undefined) return
        for (let i = from - 1; i >= 0; i--) {
          if (isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      next: () => {
        const from = selectedIndexRef.current
        if (from === undefined) return
        for (let i = from + 1; i < messagesRef.current.length; i++) {
          if (isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
        // Past the last visible message: exit cursor mode and scroll to the
        // bottom (the last message's top may be pinned at the viewport top
        // while its bottom is below the fold).
        exitCursorMode()
      },
      prevUser: () => {
        const from = selectedIndexRef.current
        if (from === undefined) return
        for (let i = from - 1; i >= 0; i--) {
          if (messagesRef.current[i]!.type === 'user' && isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      nextUser: () => {
        const from = selectedIndexRef.current
        if (from === undefined) return
        for (let i = from + 1; i < messagesRef.current.length; i++) {
          if (messagesRef.current[i]!.type === 'user' && isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      top: () => {
        for (let i = 0; i < messagesRef.current.length; i++) {
          if (isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      bottom: () => {
        for (let i = messagesRef.current.length - 1; i >= 0; i--) {
          if (isVisibleAt(i)) {
            publishCursor(i)
            return
          }
        }
      },
      getSelected: () => {
        const at = selectedIndexRef.current
        return at === undefined ? undefined : messagesRef.current[at]
      },
    }),
    [isVisibleAt, publishCursor, exitCursorMode],
  )

  // ── keep the cursor on screen ─────────────────────────────────────────
  // Offsets are read through the hook's accessors (refs underneath), never
  // dependencies — the effect must not re-pin on every mousewheel tick.
  // A LAYOUT effect: the scroll request lands in the same commit as the
  // highlight, so the frame that paints the cursor is the frame that
  // brings it on screen (a passive effect asked for the scroll after the
  // first frame had already gone out — two frames a key, measured).
  const vsRef = useRef(vs)
  vsRef.current = vs
  useLayoutEffect(() => {
    if (selectedIndex === undefined) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (el) scrollRef.current?.scrollToElement(el, 1)
    else vsRef.current.scrollToIndex(selectedIndex)
  }, [selectedIndex, scrollRef])

  // ── the search/jump engine ────────────────────────────────────────────
  const engineRef = useRef<SearchEngineState>(newEngineState())
  const onMatchChangeRef = useRef(onSearchMatchesChange)
  onMatchChangeRef.current = onSearchMatchesChange
  const scanElementRef = useRef(scanElement)
  scanElementRef.current = scanElement
  const setPositionsRef = useRef(setPositions)
  setPositionsRef.current = setPositions
  const getFacetsRef = useRef(extractFacets)
  getFacetsRef.current = extractFacets

  const reportBadge = useCallback((): void => {
    const engine = engineRef.current
    if (engine.total === 0) {
      onMatchChangeRef.current?.(0, 0)
      return
    }
    const pointer = engine.messagePointer
    const before = pointer >= 0 ? (engine.prefix[pointer] ?? 0) : 0
    onMatchChangeRef.current?.(
      engine.total,
      Math.min(engine.total, before + engine.ordinal + 1),
    )
  }, [])

  const clearHighlight = useCallback((): void => {
    setPositionsRef.current?.(null)
  }, [])

  /** Scroll so the message's top sits the fixed headroom below the
   *  viewport top. */
  const scrollMessageIntoView = useCallback(
    (index: number): void => {
      const handle = scrollRef.current
      if (!handle) return
      const el = vsRef.current.getItemElement(index)
      if (el && vsRef.current.getItemHeight(index) !== 0) {
        handle.scrollToElement(el, JUMP_HEADROOM_ROWS)
      } else {
        vsRef.current.scrollToIndex(index)
      }
    },
    [scrollRef],
  )

  /** The post-paint pass: precise re-scroll, element scan, highlight. */
  const settleOnMessage = useCallback(
    (index: number, direction: 1 | -1): void => {
      const engine = engineRef.current
      const finish = (): void => {
        engine.seekInFlight = false
        const queued = engine.queuedStep
        engine.queuedStep = null
        if (queued !== null) stepRef.current?.(queued)
      }
      const attempt = (): void => {
        const handle = scrollRef.current
        if (!handle) {
          finish()
          return
        }
        const el = vsRef.current.getItemElement(index)
        if (!el || vsRef.current.getItemHeight(index) === 0) {
          engine.mountAttempts += 1
          if (engine.mountAttempts >= MOUNT_ATTEMPT_LIMIT) {
            // Abandoned: auto-advance past the unmountable target.
            engine.mountAttempts = 0
            finish()
            advanceRef.current?.(direction)
            return
          }
          scrollMessageIntoView(index)
          engine.pendingTimer = setTimeout(attempt, 0)
          return
        }
        engine.mountAttempts = 0
        handle.scrollToElement(el, JUMP_HEADROOM_ROWS)
        const positions = scanElementRef.current?.(el) ?? []
        if (positions.length === 0) {
          // A phantom: the engine matched but the renderer shows nothing.
          engine.phantomRun += 1
          if (engine.phantomRun >= PHANTOM_LIMIT) {
            engine.phantomRun = 0
            finish()
            return
          }
          finish()
          advanceRef.current?.(direction)
          return
        }
        engine.phantomRun = 0
        const ordinal = Math.min(
          Math.max(0, direction === -1 ? positions.length - 1 : engine.ordinal),
          positions.length - 1,
        )
        engine.ordinal = ordinal
        const rowOffset =
          handle.getViewportTop() +
          vsRef.current.getItemTop(index) -
          handle.getScrollTop()
        setPositionsRef.current?.({
          positions,
          rowOffset,
          // The scan composed the message at its own column 0; the overlay
          // paints in screen space — the element's absolute left is the
          // missing translation (FN-016 R6: without it the block landed in
          // the lanes rail, the width of rail+border left of the words).
          colOffset: elementScreenLeft(el),
          currentIdx: ordinal,
        })
        reportBadge()
        finish()
      }
      engine.seekInFlight = true
      if (engine.pendingTimer !== null) clearTimeout(engine.pendingTimer)
      engine.pendingTimer = setTimeout(attempt, 0)
    },
    [scrollRef, scrollMessageIntoView, reportBadge],
  )

  /** Jump the highlight to a message: stale highlight cleared, scroll
   *  (precise or by index), then the post-paint pass. */
  const seekToMessage = useCallback(
    (index: number, direction: 1 | -1, ordinal: number): void => {
      const engine = engineRef.current
      if (index < 0 || index >= messagesRef.current.length) return
      clearHighlight()
      engine.messagePointer = index
      engine.ordinal = ordinal
      // Pre-scan placeholder badge, immediately.
      reportBadge()
      scrollMessageIntoView(index)
      settleOnMessage(index, direction)
    },
    [clearHighlight, reportBadge, scrollMessageIntoView, settleOnMessage],
  )

  /** Advance the message pointer with wraparound to the next message with
   *  matches; the full wrap back to the start pointer stops and clears. */
  const advance = useCallback(
    (direction: 1 | -1): void => {
      const engine = engineRef.current
      const count = messagesRef.current.length
      if (count === 0 || engine.total === 0) return
      let pointer = engine.messagePointer
      for (let step = 0; step < count; step++) {
        pointer = (pointer + direction + count) % count
        if (pointer === engine.wrapStart && step > 0) {
          engine.phantomRun = 0
          clearHighlight()
          return
        }
        if ((engine.counts[pointer] ?? 0) > 0) {
          seekToMessage(
            pointer,
            direction,
            direction === -1 ? Math.max(0, (engine.counts[pointer] ?? 1) - 1) : 0,
          )
          return
        }
      }
      clearHighlight()
    },
    [clearHighlight, seekToMessage],
  )
  const advanceRef = useRef(advance)
  advanceRef.current = advance

  const step = useCallback(
    (direction: 1 | -1): void => {
      const engine = engineRef.current
      if (engine.total === 0) return
      if (engine.seekInFlight) {
        // One-deep queue; the latest press overwrites the queued one.
        engine.queuedStep = direction
        return
      }
      const pointer = engine.messagePointer
      const positionsInMessage = engine.counts[pointer] ?? 0
      const next = engine.ordinal + direction
      if (pointer >= 0 && next >= 0 && next < positionsInMessage) {
        engine.ordinal = next
        engine.wrapStart = pointer
        seekToMessage(pointer, direction, next)
        return
      }
      engine.wrapStart = pointer
      advance(direction)
    },
    [advance, seekToMessage],
  )
  const stepRef = useRef(step)
  stepRef.current = step

  useImperativeHandle(
    jumpRef,
    (): JumpHandle => ({
      jumpToIndex: (index: number): void => {
        // Scroll with headroom; no scan, no positions.
        if (index < 0 || index >= messagesRef.current.length) return
        scrollMessageIntoView(index)
      },
      setSearchQuery: (raw: string): void => {
        const engine = engineRef.current
        // A new query invalidates any pending scan, clears highlight
        // positions, and resets the wrap guard.
        if (engine.pendingTimer !== null) clearTimeout(engine.pendingTimer)
        engine.seekInFlight = false
        engine.queuedStep = null
        engine.wrapStart = -1
        engine.phantomRun = 0
        engine.mountAttempts = 0
        clearHighlight()

        const query = parseSearchQuery(raw)
        const list = messagesRef.current
        const counts: number[] = new Array(list.length).fill(0)
        const prefix: number[] = new Array(list.length).fill(0)
        let total = 0
        const hasOperators =
          query.structured ||
          query.tools.length > 0 ||
          query.files.length > 0 ||
          query.failedOnly
        if (query.text !== '' || hasOperators) {
          const needle = query.text.toLowerCase()
          for (let i = 0; i < list.length; i++) {
            prefix[i] = total
            const msg = list[i]!
            if (hasOperators) {
              const facets = getFacetsRef.current?.(msg)
              // Without a facet extractor the operators match nothing —
              // a caller that cannot describe its rows cannot filter them.
              if (!facets || !facetsSatisfy(facets, query)) continue
            }
            if (needle === '') {
              // A pure filter: the ROW is the match. A structured filter
              // with no text counts each admitted row as exactly one match.
              counts[i] = 1
              total += 1
              continue
            }
            const occurrences = countOccurrences(searchTextOf(msg), needle)
            counts[i] = occurrences
            total += occurrences
          }
        }
        engine.query = query
        engine.counts = counts
        engine.prefix = prefix
        engine.total = total

        if (total === 0) {
          engine.messagePointer = -1
          engine.ordinal = 0
          onMatchChangeRef.current?.(0, 0)
          // Snap back to the anchor when one was set.
          if (engine.anchor !== null) scrollRef.current?.scrollTo(engine.anchor)
          return
        }

        // The starting match is nearest the anchor (else the live scroll
        // top), compared in the scroll content's coordinate space; ties
        // resolve to the later match.
        const reference =
          engine.anchor ?? scrollRef.current?.getScrollTop() ?? 0
        let best = -1
        let bestDistance = Infinity
        for (let i = 0; i < list.length; i++) {
          if ((counts[i] ?? 0) === 0) continue
          const distance = Math.abs(vsRef.current.getItemTop(i) - reference)
          if (distance <= bestDistance) {
            bestDistance = distance
            best = i
          }
        }
        if (best === -1) return
        engine.wrapStart = best
        // The initial preview lands on the LAST occurrence inside the
        // nearest message.
        seekToMessage(best, 1, Math.max(0, (counts[best] ?? 1) - 1))
      },
      nextMatch: (): void => {
        step(1)
      },
      prevMatch: (): void => {
        step(-1)
      },
      setAnchor: (): void => {
        engineRef.current.anchor = scrollRef.current?.getScrollTop() ?? null
      },
      warmSearchIndex: async (): Promise<number> => {
        const engine = engineRef.current
        if (engine.warm) return 0
        const list = messagesRef.current
        let workMs = 0
        for (let start = 0; start < list.length; start += WARM_CHUNK) {
          // Yield before each chunk so the caller can paint first.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          const began = performance.now()
          const end = Math.min(list.length, start + WARM_CHUNK)
          for (let i = start; i < end; i++) searchTextOf(list[i]!)
          workMs += performance.now() - began
        }
        engine.warm = true
        return Math.round(workMs)
      },
      disarmSearch: (): void => {
        const engine = engineRef.current
        if (engine.pendingTimer !== null) clearTimeout(engine.pendingTimer)
        engine.seekInFlight = false
        engine.queuedStep = null
        clearHighlight()
      },
    }),
    [clearHighlight, scrollMessageIntoView, seekToMessage, step, scrollRef, searchTextOf],
  )

  // ── render ────────────────────────────────────────────────────────────
  const [rangeStart, rangeEnd] = vs.range
  // Forensics (MERCURY_CONNECTOR_TRACE names a file): one line per list
  // render — the mounted window, its key drift and its tail identities.
  const tracePath = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (tracePath) {
    try {
      let stale = 0
      const seen = new Map<string, number>()
      for (let i = rangeStart; i < rangeEnd; i++) {
        const k = itemKeys[i]
        const m = messages[i]
        if (k === undefined || m === undefined) continue
        if (k !== itemKey(m, i)) stale++
        seen.set(k, (seen.get(k) ?? 0) + 1)
      }
      const dupKeys = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.slice(0, 12))
      const tail = messages.slice(Math.max(rangeStart, rangeEnd - 4), rangeEnd).map((m, j) => {
        const i = Math.max(rangeStart, rangeEnd - 4) + j
        return `${m.type}:${m.uuid.slice(0, 8)}/${(itemKeys[i] ?? '?').slice(0, 8)}`
      })
      // The viewport facts ride the line too: a window that never leaves
      // the tail reads differently beside a scrollTop that never moved.
      const box = scrollRef.current
      const scroll = box
        ? { top: box.getScrollTop(), pending: box.getPendingDelta(), sticky: box.isSticky(), viewport: box.getViewportHeight(), height: box.getScrollHeight() }
        : null
      appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), ev: 'list-render', range: [rangeStart, rangeEnd], messages: messages.length, keys: itemKeys.length, stale, dupKeys, tail, scroll })}\n`)
    } catch {
      /* forensics must never break the list */
    }
  }
  const items: React.ReactNode[] = []
  for (let i = rangeStart; i < rangeEnd; i++) {
    const msg = messages[i]
    const key = itemKeys[i]
    if (msg === undefined || key === undefined) continue
    const clickable =
      Boolean(onItemClick) && (isItemClickable ? isItemClickable(msg) : true)
    const expanded = isItemExpanded ? isItemExpanded(msg) : false
    items.push(
      <VirtualItem
        key={key}
        hoverId={`${instanceId}:${key}`}
        expanded={expanded}
        clickable={clickable}
        measureRef={vs.measureRef(key)}
        onClick={
          clickable
            ? (event: ClickEvent) => {
                // Only a click on a non-blank cell fires the callback.
                if (!event.cellIsBlank) onItemClick?.(msg)
              }
            : undefined
        }
      >
        {renderItem(msg, i)}
      </VirtualItem>,
    )
  }

  return (
    <>
      {/* Always mounted, even at height zero — it carries the measurement
          anchor the scroll hook needs. */}
      <Box flexShrink={0} height={vs.topSpacer} ref={vs.spacerRef} />
      {items}
      {vs.bottomSpacer > 0 ? (
        <Box flexShrink={0} height={vs.bottomSpacer} />
      ) : null}
      {trackStickyPrompt ? (
        <StickyPromptTracker
          messages={messages}
          scrollRef={scrollRef}
          getItemTop={vs.getItemTop}
          getItemElement={vs.getItemElement}
          scrollToIndex={vs.scrollToIndex}
          range={vs.range}
        />
      ) : null}
    </>
  )
}

// ── the sticky-prompt tracker ───────────────────────────────────────────────

/** Is this message a REAL user prompt for the sticky header? Memoized on
 *  the message object. */
const realPromptCache = new WeakMap<object, string | null>()

function realPromptText(msg: RenderableMessage): string | null {
  const cached = realPromptCache.get(msg)
  if (cached !== undefined) return cached
  let text: string | null = null
  if (
    msg.type === 'user' &&
    !msg.isMeta &&
    !msg.isVisibleInTranscriptOnly
  ) {
    const first = msg.message.content[0]
    if (first && first.type === 'text') {
      // Leading system reminders are attached for the model's benefit and
      // were never typed by the user; leaving them in makes every such
      // prompt fail the XML-wrapped test below.
      const stripped = stripSystemReminders(first.text)
      if (stripped !== '' && !stripped.startsWith('<')) text = stripped
    }
  } else if (msg.type === 'attachment') {
    const attachment = msg.attachment
    if (
      attachment.type === 'queued_command' &&
      attachment.commandMode !== 'task-notification' &&
      !attachment.isMeta
    ) {
      const prompt = attachment.prompt
      const raw =
        typeof prompt === 'string'
          ? prompt
          : prompt
              .filter(block => block.type === 'text')
              .map(block => (block as { text: string }).text)
              .join('\n')
      const stripped = stripSystemReminders(raw)
      if (stripped !== '' && !stripped.startsWith('<')) text = stripped
    }
  }
  realPromptCache.set(msg, text)
  return text
}

/** First paragraph only, capped at the raw slice BEFORE whitespace
 *  collapsing, then collapsed and trimmed. */
function stickyHeaderText(prompt: string): string {
  const trimmed = prompt.replace(/^\s+/, '')
  const paragraphEnd = trimmed.search(/\n\s*\n/)
  const paragraph =
    paragraphEnd === -1 ? trimmed : trimmed.slice(0, paragraphEnd)
  return paragraph.slice(0, STICKY_TEXT_CAP).replace(/\s+/g, ' ').trim()
}

function StickyPromptTracker({
  messages,
  scrollRef,
  getItemTop,
  getItemElement,
  scrollToIndex,
  range,
}: {
  messages: readonly RenderableMessage[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  getItemTop: (index: number) => number
  getItemElement: (index: number) => DOMElement | null
  scrollToIndex: (index: number) => void
  range: readonly [number, number]
}): React.ReactNode {
  const { setStickyPrompt } = React.useContext(ScrollChromeContext)

  // Finer-grained than the list's own scroll quantum: this is only a walk
  // and a comparison, and without the split the header trails the
  // transcript by about a full exchange. The snapshot folds the
  // sticky-bottom flag into its value by sign, so becoming or ceasing to
  // be stuck also triggers.
  useSyncExternalStore(
    useCallback(
      (notify: () => void) => scrollRef.current?.subscribe(notify) ?? (() => {}),
      [scrollRef],
    ),
    useCallback((): number => {
      const handle = scrollRef.current
      if (!handle) return 0
      const top = handle.getScrollTop()
      return handle.isSticky() ? -top : top
    }, [scrollRef]),
  )

  const lastPublishedIndexRef = useRef<number | null>(null)
  // The three-state click suppression: 'armed' is consumed by the next
  // publication pass (which publishes nothing); the pass after that
  // publishes and bypasses the same-index dedup.
  const suppressionRef = useRef<'idle' | 'armed' | 'bypass'>('idle')
  const pendingTargetRef = useRef<{ index: number; attempts: number } | null>(
    null,
  )
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Publication pass — deliberately ungated: the suppression state lives
  // outside React state, so a dependency-gated effect would never observe
  // it tick. When nothing moved the internal checks return early.
  useEffect(() => {
    const handle = scrollRef.current
    if (!handle) return
    // Nothing is published while the list is stuck to the bottom.
    if (handle.isSticky()) {
      if (lastPublishedIndexRef.current !== null) {
        lastPublishedIndexRef.current = null
        setStickyPrompt(null)
      }
      return
    }
    const target = handle.getScrollTop() + handle.getPendingDelta()
    // Topmost item whose top edge has not yet scrolled past the viewport's
    // upper edge — walked from the mounted range's end toward its start.
    // Items with no layout yet count as at-or-below (they are somewhere in
    // view).
    const [rangeStart, rangeEnd] = range
    let firstVisible = rangeStart
    for (let i = rangeEnd - 1; i >= rangeStart; i--) {
      const el = getItemElement(i)
      const hasLayout = el !== null && el.layoutNode !== undefined
      const top = getItemTop(i)
      if (hasLayout && top < target) {
        firstVisible = i + 1
        break
      }
      firstVisible = i
    }
    if (firstVisible <= 0) {
      if (lastPublishedIndexRef.current !== null) {
        lastPublishedIndexRef.current = null
        setStickyPrompt(null)
      }
      return
    }
    // Walk back for the most recent real user prompt scrolled above the
    // top; a prompt whose own marker row (one row below its box top) is
    // still at or below the viewport top is SKIPPED — it is on screen, and
    // repeating it in the header would show the same text twice.
    let promptIndex = -1
    let promptText: string | null = null
    for (let i = firstVisible - 1; i >= 0; i--) {
      const text = realPromptText(messagesRef.current[i]!)
      if (text === null) continue
      const markerTop = getItemTop(i) + 1
      if (markerTop >= target) continue
      promptIndex = i
      promptText = text
      break
    }

    const suppression = suppressionRef.current
    if (suppression === 'armed') {
      // Consume the armed state and publish nothing this pass.
      suppressionRef.current = 'bypass'
      return
    }
    const bypassDedup = suppression === 'bypass'
    if (bypassDedup) suppressionRef.current = 'idle'

    if (promptIndex === -1 || promptText === null) {
      if (lastPublishedIndexRef.current !== null || bypassDedup) {
        lastPublishedIndexRef.current = null
        setStickyPrompt(null)
      }
      return
    }
    // Dedup on the prompt index only — an estimated offset shifts every
    // scroll tick and would make the guard dead.
    if (!bypassDedup && lastPublishedIndexRef.current === promptIndex) return
    lastPublishedIndexRef.current = promptIndex
    const text = stickyHeaderText(promptText)
    if (text === '') {
      setStickyPrompt(null)
      return
    }
    const index = promptIndex
    setStickyPrompt({
      text,
      scrollTo: (): void => {
        // Hide the header once and keep the padding collapsed while the
        // jump is in flight, so the target's marker lands at screen row 0.
        suppressionRef.current = 'armed'
        setStickyPrompt('clicked')
        const el = getItemElement(index)
        if (el) {
          // Deferred to paint time — no throttle race on the position read.
          setTimeout(() => {
            scrollRef.current?.scrollToElement(el, 1)
          }, 0)
        } else {
          scrollToIndex(index)
          pendingTargetRef.current = { index, attempts: 0 }
        }
      },
    })
  })

  // The re-anchor correction pass — ungated, and it must run AFTER the
  // publication pass so publication sees the pending target before the
  // correction clears it. A transcript clear part-way through the jump
  // could unmount the target; at most five attempts.
  useEffect(() => {
    const pending = pendingTargetRef.current
    if (!pending) return
    const el = getItemElement(pending.index)
    if (el) {
      pendingTargetRef.current = null
      scrollRef.current?.scrollToElement(el, 1)
      return
    }
    pending.attempts += 1
    if (pending.attempts >= 5) pendingTargetRef.current = null
  })

  return null
}

export default VirtualMessageList
