import type * as React from 'react'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import type { useVirtualScroll } from './useVirtualScroll.js'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { facetsSatisfy, parseSearchQuery, type TranscriptFacets } from './transcriptSearch.js'
import type { MessageActionsNav } from '../messages/messageActions.js'
import { sleep } from '../../platform/async/sleep.js'
import { countOccurrences, WARM_CHUNK, type JumpHandle, type SearchEngineState } from './engine.js'
import { stopTimeout } from '../../platform/async/timers.js'

type CursorNavArgs = {
  messagesRef: { current: readonly RenderableMessage[] }
  selectedIndexRef: { current: number | undefined }
  isVisibleAt: (index: number) => boolean
  publishCursor: (index: number) => void
  exitCursorMode: () => void
}

export function cursorNavHandleOf({ messagesRef, selectedIndexRef, isVisibleAt, publishCursor, exitCursorMode }: CursorNavArgs): MessageActionsNav {
  return {
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
  }
}

type JumpArgs = {
  messagesRef: { current: readonly RenderableMessage[] }
  engineRef: { current: SearchEngineState }
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  vsRef: { current: ReturnType<typeof useVirtualScroll> }
  getFacetsRef: { current: ((msg: RenderableMessage) => TranscriptFacets) | undefined }
  onMatchChangeRef: { current: ((total: number, current: number) => void) | undefined }
  scrollMessageIntoView: (index: number) => void
  clearHighlight: () => void
  seekToMessage: (index: number, direction: 1 | -1, ordinal: number) => void
  step: (direction: 1 | -1) => void
  searchTextOf: (msg: RenderableMessage) => string
}

export function jumpHandleOf({ messagesRef, engineRef, scrollRef, vsRef, getFacetsRef, onMatchChangeRef, scrollMessageIntoView, clearHighlight, seekToMessage, step, searchTextOf }: JumpArgs): JumpHandle {
  return {
    jumpToIndex: (index: number): void => {
      if (index < 0 || index >= messagesRef.current.length) return
      scrollMessageIntoView(index)
    },
    setSearchQuery: (raw: string): void => {
      const engine = engineRef.current
      if (engine.pendingTimer !== null) stopTimeout(engine.pendingTimer)
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
        await sleep(0)
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
      if (engine.pendingTimer !== null) stopTimeout(engine.pendingTimer)
      engine.seekInFlight = false
      engine.queuedStep = null
      clearHighlight()
    },
  }
}
