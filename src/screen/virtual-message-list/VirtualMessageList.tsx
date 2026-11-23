import React, {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useLayoutPublish, useMeasure } from '../effects/effects.js'
import { Box } from '../themedRenderer.js'
import type { DOMElement } from '../renderer/dom.js'
import type { ClickEvent } from '../renderer/events/click-event.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import type { MatchPosition } from '../renderer/matchPositions.js'
import type { SearchPositionsState } from '../renderer/bindings/use-search-highlight.js'
import { useVirtualScroll } from './useVirtualScroll.js'
import { InteractiveDisclosure } from '../widgets/InteractiveDisclosure.js'
import { useHoverOwned } from '../widgets/useHoverOwned.js'
import { claimHover, releaseHover } from '../cockpit/hoverOwner.js'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { hasNoticeFold } from '../../engine/message-shapes/noticeRows.js'
import {
  renderableSearchText,
  type TranscriptFacets,
} from './transcriptSearch.js'
import { TextHoverColorContext } from '../theme/ThemedText.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { reconcileItemKeys, type ItemKeyState } from './virtualListKeys.js'
import {
  isNavigableMessage,
  toolCallOf,
  type MessageActionsNav,
  type MessageActionsState,
} from '../messages/messageActions.js'
import { JUMP_HEADROOM_ROWS, newEngineState, type JumpHandle, type SearchEngineState } from './engine.js'
import { cursorNavHandleOf, jumpHandleOf } from './handles.js'
import { advanceOf, settleOnMessageOf } from './search.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type { JumpHandle } from './engine.js'

type VirtualMessageListProps = {
  messages: readonly RenderableMessage[]
  columns: number
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  itemKey: (msg: RenderableMessage, index: number) => string
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode
  onItemClick?: (msg: RenderableMessage, index: number) => void
  isItemClickable?: (msg: RenderableMessage, index: number) => boolean
  isItemExpanded?: (msg: RenderableMessage, index: number) => boolean
  selectedIndex?: number
  selectedExpanded?: boolean
  cursorNavRef?: React.RefObject<MessageActionsNav | null>
  setCursor?: (state: MessageActionsState | null) => void
  extractSearchText?: (msg: RenderableMessage) => string
  extractFacets?: (msg: RenderableMessage) => TranscriptFacets
  jumpRef?: React.RefObject<JumpHandle | null>
  onSearchMatchesChange?: (total: number, current: number) => void
  scanElement?: (el: DOMElement) => MatchPosition[]
  setPositions?: (state: SearchPositionsState | null) => void
}

let instanceCounter = 0
const ALIGN_WHEN_MOUNTED_RENDERS = 4


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


function traceListRender(
  messages: readonly RenderableMessage[],
  itemKeys: readonly string[],
  itemKey: (msg: RenderableMessage, index: number) => string,
  range: readonly [number, number],
  handle: ScrollBoxHandle | null,
): void {
  const tracePath = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!tracePath) return
  try {
    const [start, end] = range
    let stale = 0
    const seen = new Set<string>()
    const dupSet = new Set<string>()
    const dupKeys: string[] = []
    for (let i = start; i < end; i++) {
      const msg = messages[i]
      const key = itemKeys[i]
      if (msg && key !== undefined && key !== itemKey(msg, i)) {
        stale += 1
      }
      if (key !== undefined) {
        if (seen.has(key)) {
          if (!dupSet.has(key)) {
            dupSet.add(key)
            if (dupKeys.length < 12) dupKeys.push(key)
          }
        } else {
          seen.add(key)
        }
      }
    }
    const tail: string[] = []
    const tailStart = Math.max(start, end - 4)
    for (let i = tailStart; i < end; i++) {
      const msg = messages[i]
      if (!msg) continue
      const key = itemKeys[i]
      tail.push(
        `${msg.type}:${msg.uuid.slice(0, 8)}/${key !== undefined ? key.slice(0, 8) : '?'}`,
      )
    }
    const scroll = handle
      ? {
          top: handle.getScrollTop(),
          pending: handle.getPendingDelta(),
          sticky: handle.isSticky(),
          viewport: handle.getViewportHeight(),
          height: handle.getScrollHeight(),
        }
      : null
    appendFileSync(
      tracePath,
      `${JSON.stringify({
        t: Date.now(),
        ev: 'list-render',
        range: [start, end],
        messages: messages.length,
        keys: itemKeys.length,
        stale,
        dupKeys,
        tail,
        scroll,
      })}\n`,
    )
  } catch (error) {
    passedOver(error)
  }
}

function useVirtualListSearch({
  messagesRef,
  scrollRef,
  vsRef,
  extractSearchText,
  extractFacets,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: {
  messagesRef: { current: readonly RenderableMessage[] }
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  vsRef: { current: ReturnType<typeof useVirtualScroll> }
  extractSearchText?: (msg: RenderableMessage) => string
  extractFacets?: (msg: RenderableMessage) => TranscriptFacets
  jumpRef?: React.RefObject<JumpHandle | null>
  onSearchMatchesChange?: (total: number, current: number) => void
  scanElement?: (el: DOMElement) => MatchPosition[]
  setPositions?: (state: SearchPositionsState | null) => void
}): void {
  const [initialEngine] = useState(newEngineState)
  const engineRef = useRef<SearchEngineState>(initialEngine)
  const extractSearchTextRef = useRef(extractSearchText)
  extractSearchTextRef.current = extractSearchText
  const fallbackSearchCacheRef = useRef(new WeakMap<object, string>())
  const getFacetsRef = useRef(extractFacets)
  getFacetsRef.current = extractFacets
  const onMatchChangeRef = useRef(onSearchMatchesChange)
  onMatchChangeRef.current = onSearchMatchesChange
  const scanElementRef = useRef(scanElement)
  scanElementRef.current = scanElement
  const setPositionsRef = useRef(setPositions)
  setPositionsRef.current = setPositions

  const searchTextOf = useCallback((msg: RenderableMessage): string => {
    if (extractSearchTextRef.current) {
      return extractSearchTextRef.current(msg)
    }
    const cached = fallbackSearchCacheRef.current.get(msg)
    if (cached !== undefined) return cached
    const lowered = renderableSearchText(msg).toLowerCase()
    fallbackSearchCacheRef.current.set(msg, lowered)
    return lowered
  }, [])

  const reportBadge = useCallback((): void => {
    const engine = engineRef.current
    if (engine.total === 0 || engine.messagePointer < 0) {
      onMatchChangeRef.current?.(0, 0)
      return
    }
    const before = engine.prefix[engine.messagePointer] ?? 0
    const current = Math.min(engine.total, before + engine.ordinal + 1)
    onMatchChangeRef.current?.(engine.total, current)
  }, [])

  const clearHighlight = useCallback((): void => {
    setPositionsRef.current?.(null)
  }, [])

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
    [scrollRef, vsRef],
  )

  const stepRef = useRef<(direction: 1 | -1) => void>(() => {})
  const advanceRef = useRef<(direction: 1 | -1) => void>(() => {})

  const seekToMessage = useCallback(
    (index: number, direction: 1 | -1, ordinal: number): void => {
      if (index < 0 || index >= messagesRef.current.length) return
      clearHighlight()
      const engine = engineRef.current
      engine.messagePointer = index
      engine.ordinal = ordinal
      reportBadge()
      scrollMessageIntoView(index)
      settleOnMessageOf(
        {
          engineRef,
          stepRef,
          advanceRef,
          scrollRef,
          vsRef,
          scanElementRef,
          setPositionsRef,
          scrollMessageIntoView,
          reportBadge,
        },
        index,
        direction,
      )
    },
    [clearHighlight, messagesRef, reportBadge, scrollMessageIntoView, scrollRef, vsRef],
  )

  const advance = useCallback(
    (direction: 1 | -1): void => {
      advanceOf(
        {
          engineRef,
          messagesRef,
          clearHighlight,
          seekToMessage,
        },
        direction,
      )
    },
    [clearHighlight, messagesRef, seekToMessage],
  )
  advanceRef.current = advance

  const step = useCallback(
    (direction: 1 | -1): void => {
      const engine = engineRef.current
      if (engine.total === 0) return
      if (engine.seekInFlight) {
        engine.queuedStep = direction
        return
      }
      const pointer = engine.messagePointer
      const count = pointer >= 0 ? (engine.counts[pointer] ?? 0) : 0
      const nextOrdinal = engine.ordinal + direction
      if (pointer >= 0 && nextOrdinal >= 0 && nextOrdinal < count) {
        engine.wrapStart = pointer
        seekToMessage(pointer, direction, nextOrdinal)
        return
      }
      engine.wrapStart = pointer
      advance(direction)
    },
    [seekToMessage, advance],
  )
  stepRef.current = step

  useImperativeHandle(
    jumpRef,
    () =>
      jumpHandleOf({
        messagesRef,
        engineRef,
        scrollRef,
        vsRef,
        getFacetsRef,
        onMatchChangeRef,
        scrollMessageIntoView,
        clearHighlight,
        seekToMessage,
        step,
        searchTextOf,
      }),
    [
      messagesRef,
      scrollRef,
      vsRef,
      scrollMessageIntoView,
      clearHighlight,
      seekToMessage,
      step,
      searchTextOf,
    ],
  )
}

export function VirtualMessageList({
  messages,
  columns,
  scrollRef,
  itemKey,
  renderItem,
  onItemClick,
  isItemClickable,
  isItemExpanded,
  selectedIndex,
  selectedExpanded = false,
  cursorNavRef,
  setCursor,
  extractSearchText,
  extractFacets,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: VirtualMessageListProps): React.ReactNode {
  const [hoverPrefix] = useState(() => `vml-${++instanceCounter}`)
  const keyStateRef = useRef<ItemKeyState<RenderableMessage> | null>(null)
  keyStateRef.current = reconcileItemKeys(keyStateRef.current, messages, itemKey)
  const itemKeys = keyStateRef.current.keys

  const vs = useVirtualScroll(scrollRef, itemKeys, columns)

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const vsRef = useRef(vs)
  vsRef.current = vs
  const setCursorRef = useRef(setCursor)
  setCursorRef.current = setCursor

  const isVisibleAt = useCallback((index: number): boolean => {
    const msg = messagesRef.current[index]
    if (!msg) return false
    if (vsRef.current.getItemHeight(index) === 0) return false
    return isNavigableMessage(msg)
  }, [])

  const publishCursor = useCallback((index: number): void => {
    const msg = messagesRef.current[index]
    if (!msg) return
    const call = toolCallOf(msg)
    const state: MessageActionsState = {
      uuid: msg.uuid,
      type: msg.type,
      expanded: false,
      ...(hasNoticeFold(msg) ? { notice: true as const } : {}),
      ...(call ? { toolName: call.name } : {}),
    }
    setCursorRef.current?.(state)
  }, [])

  const exitCursorMode = useCallback((): void => {
    setCursorRef.current?.(null)
    scrollRef.current?.scrollToBottom()
  }, [scrollRef])

  useImperativeHandle(
    cursorNavRef,
    () =>
      cursorNavHandleOf({
        messagesRef,
        selectedIndexRef,
        isVisibleAt,
        publishCursor,
        exitCursorMode,
      }),
    [isVisibleAt, publishCursor, exitCursorMode],
  )

  const prevSelectedRef = useRef<{
    index: number | undefined
    expanded: boolean
  }>({ index: selectedIndex, expanded: selectedExpanded })
  const alignWhenMountedRef = useRef<{ index: number; remaining: number } | null>(
    null,
  )

  useLayoutPublish(() => {
    alignWhenMountedRef.current = null
    if (selectedIndex === undefined) return
    const handle = scrollRef.current
    if (!handle) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (el) {
      handle.scrollToElement(el, 1)
    } else {
      vsRef.current.scrollToIndex(selectedIndex)
    }
  }, [selectedIndex, scrollRef])

  useMeasure(() => {
    const prev = prevSelectedRef.current
    prevSelectedRef.current = { index: selectedIndex, expanded: selectedExpanded }
    const handle = scrollRef.current

    const pending = alignWhenMountedRef.current
    if (pending !== null) {
      if (selectedIndex !== pending.index || !handle) {
        alignWhenMountedRef.current = null
      } else {
        const el = vsRef.current.getItemElement(pending.index)
        if (el) {
          handle.scrollToElement(el, 1)
          alignWhenMountedRef.current = null
        } else if (pending.remaining <= 1) {
          alignWhenMountedRef.current = null
        } else {
          pending.remaining -= 1
        }
      }
    }

    if (
      selectedIndex === undefined ||
      prev.index !== selectedIndex ||
      prev.expanded === selectedExpanded
    ) {
      return
    }
    if (!handle) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (!el) {
      alignWhenMountedRef.current = {
        index: selectedIndex,
        remaining: ALIGN_WHEN_MOUNTED_RENDERS,
      }
      vsRef.current.scrollToIndex(selectedIndex)
      return
    }
    const elTop = handle.getElementTop(el)
    const viewport = handle.getViewportHeight()
    if (elTop === undefined || viewport <= 0) return
    const scrollTop = handle.getScrollTop()
    const insideViewport = elTop >= scrollTop && elTop < scrollTop + viewport
    if (!insideViewport) {
      handle.scrollToElement(el, 1)
      return
    }
    if (selectedExpanded) {
      const max = Math.max(0, handle.getScrollHeight() - viewport)
      const atBottom = handle.isSticky() || scrollTop >= max
      if (atBottom) {
        handle.scrollToElement(el, scrollTop - elTop)
      }
    }
  })

  useVirtualListSearch({
    messagesRef,
    scrollRef,
    vsRef,
    extractSearchText,
    extractFacets,
    jumpRef,
    onSearchMatchesChange,
    scanElement,
    setPositions,
  })

  traceListRender(messages, itemKeys, itemKey, vs.range, scrollRef.current)

  const [start, end] = vs.range
  const items: React.ReactNode[] = []
  for (let i = start; i < end; i++) {
    const msg = messages[i]
    const key = itemKeys[i]
    if (!msg || key === undefined) continue
    const clickable =
      onItemClick !== undefined &&
      (isItemClickable === undefined || isItemClickable(msg, i))
    const expanded =
      msg.type !== 'turn_receipt' &&
      (isItemExpanded ? isItemExpanded(msg, i) : false)
    const onClick = clickable
      ? (event: ClickEvent): void => {
          if (event.cellIsBlank) return
          onItemClick(msg, i)
        }
      : undefined
    items.push(
      <VirtualItem
        key={key}
        hoverId={`${hoverPrefix}:${key}`}
        expanded={expanded}
        clickable={clickable}
        measureRef={vs.measureRef(key)}
        onClick={onClick}
      >
        {renderItem(msg, i)}
      </VirtualItem>,
    )
  }

  return (
    <>
      <Box ref={vs.spacerRef} height={vs.topSpacer} flexShrink={0} />
      {items}
      {vs.bottomSpacer > 0 ? (
        <Box height={vs.bottomSpacer} flexShrink={0} />
      ) : null}
    </>
  )
}

export default VirtualMessageList
