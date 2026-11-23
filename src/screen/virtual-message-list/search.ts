import type * as React from 'react'
import { elementScreenLeft } from '../themedRenderer.js'
import type { DOMElement } from '../renderer/dom.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import type { MatchPosition } from '../renderer/matchPositions.js'
import type { SearchPositionsState } from '../renderer/bindings/use-search-highlight.js'
import type { useVirtualScroll } from './useVirtualScroll.js'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { JUMP_HEADROOM_ROWS, MOUNT_ATTEMPT_LIMIT, PHANTOM_LIMIT, type SearchEngineState } from './engine.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

type SettleArgs = {
  engineRef: { current: SearchEngineState }
  stepRef: { current: (direction: 1 | -1) => void }
  advanceRef: { current: (direction: 1 | -1) => void }
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  vsRef: { current: ReturnType<typeof useVirtualScroll> }
  scanElementRef: { current: ((el: DOMElement) => MatchPosition[]) | undefined }
  setPositionsRef: { current: ((state: SearchPositionsState | null) => void) | undefined }
  scrollMessageIntoView: (index: number) => void
  reportBadge: () => void
}

export function settleOnMessageOf({ engineRef, stepRef, advanceRef, scrollRef, vsRef, scanElementRef, setPositionsRef, scrollMessageIntoView, reportBadge }: SettleArgs, index: number, direction: 1 | -1): void {
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
      engine.pendingTimer = startTimeout(attempt, 0)
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
      Math.max(0, engine.ordinal),
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
  if (engine.pendingTimer !== null) stopTimeout(engine.pendingTimer)
  engine.pendingTimer = startTimeout(attempt, 0)
}

type AdvanceArgs = {
  engineRef: { current: SearchEngineState }
  messagesRef: { current: readonly RenderableMessage[] }
  clearHighlight: () => void
  seekToMessage: (index: number, direction: 1 | -1, ordinal: number) => void
}

export function advanceOf({ engineRef, messagesRef, clearHighlight, seekToMessage }: AdvanceArgs, direction: 1 | -1): void {
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
}
