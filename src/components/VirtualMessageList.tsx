
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
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

const JUMP_HEADROOM_ROWS = 3
const PHANTOM_LIMIT = 20
const MOUNT_ATTEMPT_LIMIT = 3
const WARM_CHUNK = 500
const STICKY_TEXT_CAP = 500

export type StickyPrompt = { text: string; scrollTo: () => void } | 'clicked'

export type JumpHandle = {
  jumpToIndex: (index: number) => void
  setSearchQuery: (query: string) => void
  nextMatch: () => void
  prevMatch: () => void
  setAnchor: () => void
  warmSearchIndex: () => Promise<number>
  disarmSearch: () => void
}

export type VirtualMessageListProps = {
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
  trackStickyPrompt?: boolean
  selectedIndex: number | undefined
  cursorNavRef?: React.Ref<MessageActionsNav | null>
  setCursor?: (cursor: MessageActionsState | null) => void
  jumpRef?: React.Ref<JumpHandle | null>
  onSearchMatchesChange?: (total: number, current: number) => void
  scanElement?: (el: DOMElement) => MatchPosition[]
  setPositions?: (state: SearchPositionsState | null) => void
}

let instanceCounter = 0


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


type SearchEngineState = {
  query: SearchQuery | null
  counts: number[]
  prefix: number[]
  total: number
  messagePointer: number
  ordinal: number
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

  const vsRef = useRef(vs)
  vsRef.current = vs
  useEffect(() => {
    if (selectedIndex === undefined) return
    const el = vsRef.current.getItemElement(selectedIndex)
    if (el) scrollRef.current?.scrollToElement(el, 1)
    else vsRef.current.scrollToIndex(selectedIndex)
  }, [selectedIndex, scrollRef])

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
        if (index < 0 || index >= messagesRef.current.length) return
        scrollMessageIntoView(index)
      },
      setSearchQuery: (raw: string): void => {
        const engine = engineRef.current
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
              if (!facets || !facetsSatisfy(facets, query)) continue
            }
            if (needle === '') {
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
          if (engine.anchor !== null) scrollRef.current?.scrollTo(engine.anchor)
          return
        }

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
      appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), ev: 'list-render', range: [rangeStart, rangeEnd], messages: messages.length, keys: itemKeys.length, stale, dupKeys, tail })}\n`)
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
        expanded={expanded}
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
      {
}
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
  const suppressionRef = useRef<'idle' | 'armed' | 'bypass'>('idle')
  const pendingTargetRef = useRef<{ index: number; attempts: number } | null>(
    null,
  )
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    const handle = scrollRef.current
    if (!handle) return
    if (handle.isSticky()) {
      if (lastPublishedIndexRef.current !== null) {
        lastPublishedIndexRef.current = null
        setStickyPrompt(null)
      }
      return
    }
    const target = handle.getScrollTop() + handle.getPendingDelta()
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
        suppressionRef.current = 'armed'
        setStickyPrompt('clicked')
        const el = getItemElement(index)
        if (el) {
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
