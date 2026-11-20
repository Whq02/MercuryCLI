
import React, {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useLayoutPublish, useMeasure } from '../hooks/effects.js'
import { Box } from '../ink.js'
import type { DOMElement } from '../ink/dom.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { MatchPosition } from '../ink/render-to-screen.js'
import type { SearchPositionsState } from '../ink/hooks/use-search-highlight.js'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import { InteractiveDisclosure } from './mercury-ui/InteractiveDisclosure.js'
import { useHoverOwned } from './mercury-ui/useHoverOwned.js'
import { claimHover, releaseHover } from '../utils/cockpit/hoverOwner.js'
import type { RenderableMessage } from '../types/message.js'
import { hasNoticeFold } from '../utils/messages/noticeRows.js'
import {
  renderableSearchText,
  type TranscriptFacets,
} from '../utils/transcriptSearch.js'
import { TextHoverColorContext } from './design-system/ThemedText.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { reconcileItemKeys, type ItemKeyState } from './virtualListKeys.js'
import {
  isNavigableMessage,
  toolCallOf,
  type MessageActionsNav,
  type MessageActionsState,
} from './messageActions.js'
import { JUMP_HEADROOM_ROWS, newEngineState, type JumpHandle, type SearchEngineState } from './virtualMessageList/engine.js'
import { cursorNavHandleOf, jumpHandleOf } from './virtualMessageList/handles.js'
import { advanceOf, settleOnMessageOf } from './virtualMessageList/search.js'

export type { JumpHandle } from './virtualMessageList/engine.js'

type VirtualMessageListProps = {
  messages: readonly RenderableMessage[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
  itemKey: (msg: RenderableMessage, index: number) => string
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode
  onItemClick?: (msg: RenderableMessage) => void
  isItemClickable?: (msg: RenderableMessage) => boolean
  isItemExpanded?: (msg: RenderableMessage) => boolean
  extractSearchText?: (msg: RenderableMessage) => string
  extractFacets?: (msg: RenderableMessage) => TranscriptFacets
  selectedIndex: number | undefined
  selectedExpanded?: boolean
  cursorNavRef?: React.Ref<MessageActionsNav | null>
  setCursor?: (cursor: MessageActionsState | null) => void
  jumpRef?: React.Ref<JumpHandle | null>
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
  selectedIndex,
  selectedExpanded = false,
  cursorNavRef,
  setCursor,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: VirtualMessageListProps): React.ReactNode {
  const [instanceId] = useState(() => `vml-${++instanceCounter}`)

  const keysStateRef = useRef<ItemKeyState<RenderableMessage> | null>(null)
  keysStateRef.current = reconcileItemKeys(keysStateRef.current, messages, itemKey)
  const itemKeys: string[] = keysStateRef.current.keys

  const vs = useVirtualScroll(scrollRef, itemKeys, columns)

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

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  const isVisibleAt = useCallback(
    (index: number): boolean => {
      const msg = messagesRef.current[index]
      if (!msg) return false
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
        ...(hasNoticeFold(msg) ? { notice: true as const } : {}),
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
    (): MessageActionsNav => cursorNavHandleOf({ messagesRef, selectedIndexRef, isVisibleAt, publishCursor, exitCursorMode }),
    [isVisibleAt, publishCursor, exitCursorMode],
  )

  const vsRef = useRef(vs)
  vsRef.current = vs
  useLayoutPublish(() => {
    if (selectedIndex === undefined) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (el) scrollRef.current?.scrollToElement(el, 1)
    else vsRef.current.scrollToIndex(selectedIndex)
  }, [selectedIndex, scrollRef])

  const flipWasRef = useRef({ index: selectedIndex, expanded: selectedExpanded })
  const alignWhenMountedRef = useRef<{ index: number; renders: number } | null>(null)
  useMeasure(() => {
    const was = flipWasRef.current
    flipWasRef.current = { index: selectedIndex, expanded: selectedExpanded }
    if (was.index !== selectedIndex || was.expanded === selectedExpanded) return
    if (selectedIndex === undefined) return
    const handle = scrollRef.current
    if (!handle) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (!el) {
      alignWhenMountedRef.current = { index: selectedIndex, renders: ALIGN_WHEN_MOUNTED_RENDERS }
      vsRef.current.scrollToIndex(selectedIndex)
      return
    }
    const top = handle.getElementTop(el)
    if (top === undefined) return
    const viewTop = handle.getScrollTop()
    const viewBottom = viewTop + handle.getViewportHeight()
    if (top < viewTop || top >= viewBottom) handle.scrollToElement(el, 1)
    else if (selectedExpanded && (handle.isSticky() || viewBottom >= handle.getScrollHeight())) handle.scrollToElement(el, viewTop - top)
  }, [selectedExpanded, selectedIndex, scrollRef])

  useLayoutPublish(() => {
    const waiting = alignWhenMountedRef.current
    if (waiting === null) return
    const el = waiting.index === selectedIndex ? vsRef.current.getItemElement(waiting.index) : null
    if (el) scrollRef.current?.scrollToElement(el, 1)
    waiting.renders -= 1
    if (el || waiting.index !== selectedIndex || waiting.renders <= 0) alignWhenMountedRef.current = null
  })

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

  const settleOnMessage = useCallback(
    (index: number, direction: 1 | -1): void => settleOnMessageOf({ engineRef, stepRef, advanceRef, scrollRef, vsRef, scanElementRef, setPositionsRef, scrollMessageIntoView, reportBadge }, index, direction),
    [scrollRef, scrollMessageIntoView, reportBadge],
  )

  const seekToMessage = useCallback(
    (index: number, direction: 1 | -1, ordinal: number): void => {
      const engine = engineRef.current
      if (index < 0 || index >= messagesRef.current.length) return
      clearHighlight()
      engine.messagePointer = index
      engine.ordinal = ordinal
      reportBadge()
      scrollMessageIntoView(index)
      settleOnMessage(index, direction)
    },
    [clearHighlight, reportBadge, scrollMessageIntoView, settleOnMessage],
  )

  const advance = useCallback(
    (direction: 1 | -1): void => advanceOf({ engineRef, messagesRef, clearHighlight, seekToMessage }, direction),
    [clearHighlight, seekToMessage],
  )
  const advanceRef = useRef(advance)
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
    (): JumpHandle => jumpHandleOf({ messagesRef, engineRef, scrollRef, vsRef, getFacetsRef, onMatchChangeRef, scrollMessageIntoView, clearHighlight, seekToMessage, step, searchTextOf }),
    [clearHighlight, scrollMessageIntoView, seekToMessage, step, scrollRef, searchTextOf],
  )

  const [rangeStart, rangeEnd] = vs.range
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
      const box = scrollRef.current
      const scroll = box
        ? { top: box.getScrollTop(), pending: box.getPendingDelta(), sticky: box.isSticky(), viewport: box.getViewportHeight(), height: box.getScrollHeight() }
        : null
      appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), ev: 'list-render', range: [rangeStart, rangeEnd], messages: messages.length, keys: itemKeys.length, stale, dupKeys, tail, scroll })}\n`)
    } catch {
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
        expanded={expanded && msg.type !== 'turn_receipt'}
        clickable={clickable}
        measureRef={vs.measureRef(key)}
        onClick={
          clickable
            ? (event: ClickEvent) => {
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
      {}
      <Box flexShrink={0} height={vs.topSpacer} ref={vs.spacerRef} />
      {items}
      {vs.bottomSpacer > 0 ? (
        <Box flexShrink={0} height={vs.bottomSpacer} />
      ) : null}
    </>
  )
}

export default VirtualMessageList
