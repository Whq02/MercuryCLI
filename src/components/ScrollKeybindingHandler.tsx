
import React, { useCallback, useEffect, useRef } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import useInput from '../ink/hooks/use-input.js'
import type { Key } from '../ink/events/input-event.js'
import {
  useSelection,
  type SelectionApi,
} from '../ink/hooks/use-selection.js'
import type { FocusMove } from '../ink/geometry/selection.js'
import { useCopyOnSelect, useSelectionBgColor } from '../hooks/useCopyOnSelect.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { topOverlay, topOverlayOwnsPageKeys } from '../context/overlayStack.js'
import { useNotifications } from '../context/notifications.js'
import { getClipboardPath, subscribeClipboardReceipts } from '../ink/termio/osc.js'
import { logForDebugging } from '../utils/debug.js'
import { peekInputSelectionRange } from '../utils/cockpit/inputSelectionBridge.js'
import { isXtermJs } from '../ink/session/capabilities.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'


export type WheelAccelState = {
  time: number
  mult: number
  dir: 1 | -1 | 0
  xtermJs: boolean
  frac: number
  base: number
  pendingFlip: 1 | -1 | 0
  wheelMode: boolean
  burstCount: number
  cadenceCount: number
}

const NATIVE_HALFLIFE_MS = 150
const NATIVE_DISENGAGE_GAP_MS = 1500
const FLIP_WINDOW_MS = 200
const CADENCE_MIN_GAP_MS = 30
const CADENCE_MAX_GAP_MS = 400
const SAME_BATCH_GAP_MS = 5
const TRACKPAD_WINDOW_MS = 40

export function readScrollSpeedBase(): number {
  return 1
}

export function initWheelAccel(
  xtermJs = false,
  base: number = readScrollSpeedBase(),
): WheelAccelState {
  return {
    time: 0,
    mult: base,
    dir: 0,
    xtermJs,
    frac: 0,
    base,
    pendingFlip: 0,
    wheelMode: false,
    burstCount: 0,
    cadenceCount: 0,
  }
}

export function computeWheelStep(
  state: WheelAccelState,
  dir: 1 | -1,
  now: number,
): number {
  const gap = state.time === 0 ? Number.POSITIVE_INFINITY : now - state.time

  if (state.xtermJs) {
    if (dir === state.dir && gap < SAME_BATCH_GAP_MS) {
      state.time = now
      return 1
    }
    if (dir !== state.dir || gap > 500) {
      state.dir = dir
      state.time = now
      state.mult = 2
      state.frac = 0
      return 2
    }
    const momentum = Math.pow(0.5, gap / NATIVE_HALFLIFE_MS)
    const cap = gap >= 80 ? 3 : 6
    state.mult = Math.min(cap, 1 + (state.mult - 1) * momentum + 5 * momentum)
    state.time = now
    const total = state.mult + state.frac
    const rows = Math.floor(total)
    state.frac = total - rows
    return rows
  }

  if (state.wheelMode && gap > NATIVE_DISENGAGE_GAP_MS) {
    state.wheelMode = false
    state.burstCount = 0
    state.cadenceCount = 0
    state.mult = state.base
  }

  if (state.pendingFlip !== 0) {
    const pending = state.pendingFlip
    state.pendingFlip = 0
    if (dir === pending) {
      state.dir = pending
      state.mult = state.base
    } else if (now - state.time <= FLIP_WINDOW_MS) {
      state.wheelMode = true
    } else {
      state.dir = pending
      state.mult = state.base
      state.pendingFlip = dir
      state.time = now
      return 0
    }
  }
  if (state.dir !== 0 && dir !== state.dir) {
    state.pendingFlip = dir
    state.time = now
    return 0
  }
  state.dir = dir

  if (!state.wheelMode) {
    if (gap > CADENCE_MIN_GAP_MS && gap < CADENCE_MAX_GAP_MS) {
      state.cadenceCount += 1
      if (state.cadenceCount >= 3) {
        state.wheelMode = true
        state.cadenceCount = 0
      }
    } else {
      state.cadenceCount = 0
    }
  }

  if (state.wheelMode) {
    if (gap < SAME_BATCH_GAP_MS) {
      state.burstCount += 1
      if (state.burstCount >= 5) {
        state.wheelMode = false
        state.mult = state.base
        state.burstCount = 0
      }
      state.time = now
      return 1
    }
    state.burstCount = 0
    const momentum = Math.pow(0.5, gap / NATIVE_HALFLIFE_MS)
    const next = 1 + (state.mult - 1) * momentum + 15 * momentum
    const cap = Math.max(15, state.base * 2)
    state.mult = Math.min(Math.min(cap, next), state.mult + 3)
    state.time = now
    return Math.floor(state.mult)
  }

  if (gap > TRACKPAD_WINDOW_MS) {
    state.mult = state.base
  } else {
    state.mult = Math.min(Math.max(6, state.base * 2), state.mult + 0.3)
  }
  state.time = now
  return Math.floor(state.mult)
}


export function jumpBy(handle: ScrollBoxHandle, delta: number): boolean {
  const max = Math.max(
    0,
    handle.getScrollHeight() - handle.getViewportHeight(),
  )
  const target = handle.getScrollTop() + handle.getPendingDelta() + delta
  if (target >= max) {
    handle.scrollTo(max)
    handle.scrollToBottom()
    return true
  }
  handle.scrollTo(Math.max(0, target))
  return false
}


export function shouldClearSelectionOnKey(key: Key): boolean {
  if (key.shift || key.meta) return false
  return true
}

export function selectionFocusMoveForKey(key: Key): FocusMove | null {
  if (!key.shift || key.meta) return null
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.home) return 'lineStart'
  if (key.end) return 'lineEnd'
  return null
}

export function dragScrollDirection(
  sel: { anchorRow: number; focusRow: number },
  top: number,
  bottom: number,
  alreadyScrollingDir?: -1 | 0 | 1,
): -1 | 0 | 1 {
  const focusAbove = sel.focusRow < top
  const focusBelow = sel.focusRow > bottom
  const anchorInside = sel.anchorRow >= top && sel.anchorRow <= bottom
  if (!alreadyScrollingDir) {
    if (!anchorInside) return 0
    if (focusAbove) return -1
    if (focusBelow) return 1
    return 0
  }
  if (focusAbove && alreadyScrollingDir === -1) return -1
  if (focusBelow && alreadyScrollingDir === 1) return 1
  return 0
}


const PAGE_OVERLAP_ROWS = 2
const AUTOSCROLL_STEP_ROWS = 2
const AUTOSCROLL_TICK_MS = 50
const AUTOSCROLL_MAX_TICKS = 200
const COPY_TOAST_KEY = 'selection-copy'

export function ScrollKeybindingHandler({
  scrollRef,
  isActive,
  onScroll,
  isModal = false,
  modalScrollRef,
  modalUp = false,
}: {
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  isActive: boolean
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void
  isModal?: boolean
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>
  modalUp?: boolean
}): React.ReactNode {
  const selection = useSelection()
  const { addNotification } = useNotifications()
  const wheelState = useRef<WheelAccelState | null>(null)
  const wheelModelLogged = useRef(false)
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll

  const activeHandle = useCallback((): ScrollBoxHandle | null => {
    if (modalUp && modalScrollRef?.current) return modalScrollRef.current
    if (modalUp) return null
    return scrollRef.current
  }, [modalUp, modalScrollRef, scrollRef])

  const notifyScroll = useCallback(
    (handle: ScrollBoxHandle) => {
      if (modalUp) return
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      const sticky = handle.getScrollTop() + handle.getPendingDelta() >= max
      onScrollRef.current?.(sticky, handle)
    },
    [modalUp],
  )

  const copySettleWatchRef = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => copySettleWatchRef.current?.(), [])
  const raiseCopyToast = useCallback(
    (text: string) => {
      void text
      const path = getClipboardPath()
      const where =
        path === 'native'
          ? ''
          : path === 'tmux-buffer'
            ? ' (multiplexer buffer — paste with the prefix chord then ])'
            : " (terminal escape transfer — check the terminal's clipboard settings if pasting fails)"
      addNotification({
        key: COPY_TOAST_KEY,
        priority: 'immediate',
        timeoutMs: path === 'native' ? 2000 : 4000,
        text: `Copied to clipboard${where}`,
      })
      if (path === 'osc52') return
      copySettleWatchRef.current?.()
      const unsubscribe = subscribeClipboardReceipts(receipt => {
        copySettleWatchRef.current?.()
        if (receipt.settled.length > 0) return
        addNotification({
          key: COPY_TOAST_KEY,
          priority: 'immediate',
          timeoutMs: 4000,
          text: `Copy did not settle — ${receipt.confirmation}`,
        })
      })
      copySettleWatchRef.current = () => {
        unsubscribe()
        copySettleWatchRef.current = null
      }
    },
    [addNotification],
  )

  useCopyOnSelect(selection, isActive, raiseCopyToast)
  useSelectionBgColor(selection)

  useInput(
    (input, key, event) => {
      if (!key.ctrl || key.shift || key.meta || key.super) return
      if (input !== 'c') return
      if (!selection.hasSelection()) return
      const text = selection.copySelection()
      if (text) raiseCopyToast(text)
      event.stopImmediatePropagation()
    },
    { isActive },
  )

  const translateOrClear = useCallback(
    (delta: number) => {
      const handle = activeHandle()
      const state = selection.getState()
      if (!handle || !state) return
      const top = handle.getViewportTop()
      const bottom = top + handle.getViewportHeight() - 1
      selection.shiftSelection(-delta, 0, Number.MAX_SAFE_INTEGER)
      void top
      void bottom
    },
    [activeHandle, selection],
  )

  const pageStep = useCallback((): number => {
    const handle = activeHandle()
    if (!handle) return 1
    if (modalUp) return Math.max(1, handle.getViewportHeight() - 2)
    return Math.max(1, handle.getViewportHeight() - PAGE_OVERLAP_ROWS)
  }, [activeHandle, modalUp])

  const runScroll = useCallback(
    (delta: number): boolean => {
      const handle = activeHandle()
      if (!handle) return false
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      const tracePath = flagEnv('MERCURY_CONNECTOR_TRACE')
      if (tracePath) {
        try {
          appendFileSync(
            tracePath,
            `${JSON.stringify({ t: Date.now(), ev: 'scroll-request', delta, top: handle.getScrollTop(), pending: handle.getPendingDelta(), max, viewport: handle.getViewportHeight(), sticky: handle.isSticky() })}\n`,
          )
        } catch {
        }
      }
      if (max <= 0) return false
      translateOrClear(delta)
      jumpBy(handle, delta)
      notifyScroll(handle)
      return true
    },
    [activeHandle, translateOrClear, notifyScroll],
  )

  useKeybindings(
    {
      'scroll:pageUp': () => {
          if (topOverlayOwnsPageKeys()) return false
          runScroll(-pageStep())
        },
      'scroll:pageDown': () => {
          if (topOverlayOwnsPageKeys()) return false
          runScroll(pageStep())
        },
      'scroll:lineUp': () => {
          if (topOverlayOwnsPageKeys()) return false
          runScroll(-(modalUp ? 3 : 1))
        },
      'scroll:lineDown': () => {
          if (topOverlayOwnsPageKeys()) return false
          runScroll(modalUp ? 3 : 1)
        },
      'scroll:top': () => {
          if (topOverlayOwnsPageKeys()) return false
          const handle = activeHandle()
          if (handle) {
            translateOrClear(-handle.getScrollTop())
            handle.scrollTo(0)
            notifyScroll(handle)
          }
        },
      'scroll:bottom': () => {
          if (topOverlayOwnsPageKeys()) return false
          const handle = activeHandle()
          if (handle) {
            const max = Math.max(
              0,
              handle.getScrollHeight() - handle.getViewportHeight(),
            )
            translateOrClear(max - handle.getScrollTop())
            handle.scrollTo(max)
            handle.scrollToBottom()
            notifyScroll(handle)
          }
        },
      'scroll:halfPageUp': () => {
        runScroll(-Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2)))
      },
      'scroll:halfPageDown': () => {
        runScroll(Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2)))
      },
      'scroll:fullPageUp': () => {
        runScroll(-Math.max(1, activeHandle()?.getViewportHeight() ?? 1))
      },
      'scroll:fullPageDown': () => {
        runScroll(Math.max(1, activeHandle()?.getViewportHeight() ?? 1))
      },
      'selection:copy': () => {
          if (selection.hasSelection()) {
            const text = selection.copySelection()
            if (text) raiseCopyToast(text)
          }
        },
    },
    { context: 'Scroll', isActive },
  )

  useInput(
    (input, key) => {
      const wheelUp = (key as { wheelUp?: boolean }).wheelUp === true
      const wheelDown = (key as { wheelDown?: boolean }).wheelDown === true
      if (!wheelUp && !wheelDown) return
      const handle = activeHandle()
      if (!handle) return
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      if (max <= 0) return
      selection.clearSelection()
      if (wheelState.current === null) {
        const xtermJs = isXtermJs()
        wheelState.current = initWheelAccel(xtermJs)
        if (!wheelModelLogged.current) {
          wheelModelLogged.current = true
          logForDebugging(
            `wheel model: ${isXtermJs() ? 'browser-hosted' : 'native'} (TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ''})`,
          )
        }
      }
      const dir: 1 | -1 = wheelDown ? 1 : -1
      const rows = computeWheelStep(wheelState.current, dir, Date.now())
      if (rows === 0) return
      const effective = handle.getScrollTop() + handle.getPendingDelta()
      if (dir === -1) {
        if (effective - rows <= 0) {
          handle.scrollTo(0)
        } else {
          handle.scrollBy(-rows)
        }
      } else {
        if (effective + rows >= max) {
          handle.scrollTo(max)
          handle.scrollToBottom()
        } else {
          handle.scrollBy(rows)
        }
      }
      notifyScroll(handle)
    },
    { isActive },
  )

  useInput(
    (input_0, key_0) => {
      if (!selection.hasSelection()) return
      const printable =
        input_0.length > 0 && !key_0.ctrl && !key_0.meta && !key_0.escape
      const deleteShaped = key_0.backspace || key_0.delete || input_0.includes('\x7f');
      const bareArrow = (key_0.leftArrow || key_0.rightArrow) && !key_0.shift && !key_0.ctrl && !key_0.meta;
      if ((deleteShaped || bareArrow || printable) && peekInputSelectionRange()) {
        return;
      }
      if (shouldClearSelectionOnKey(key_0)) {
        selection.clearSelection()
      }
    },
    { isActive },
  )

  const autoscrollDirRef = useRef<-1 | 0 | 1>(0)
  const autoscrollTicksRef = useRef(0)
  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => {
      const handle = activeHandle()
      const state = selection.getState()
      const dragging = state !== null && state.isDragging
      if (!handle || !state || !dragging) {
        autoscrollDirRef.current = 0
        autoscrollTicksRef.current = 0
        return
      }
      if (autoscrollTicksRef.current > AUTOSCROLL_MAX_TICKS) return
      if (handle.getPendingDelta() !== 0) return
      if (!state.focus || !state.anchor) return
      const top = handle.getViewportTop()
      const bottom = top + handle.getViewportHeight() - 1
      const focusRow = state.focus.row
      const anchorRow = state.anchor.row
      const direction = dragScrollDirection(
        { anchorRow, focusRow },
        top,
        bottom,
        autoscrollDirRef.current,
      )
      if (direction === 0) {
        if (
          autoscrollDirRef.current !== 0 &&
          (focusRow < top || focusRow > bottom)
        ) {
          selection.clearSelection()
          autoscrollDirRef.current = 0
        }
        return
      }
      autoscrollDirRef.current = direction
      autoscrollTicksRef.current += 1
      const offset = handle.getScrollTop()
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      if (direction === -1) {
        if (offset <= 0) return
        const distance = Math.min(AUTOSCROLL_STEP_ROWS, offset)
        selection.captureScrolledRows(bottom - distance + 1, bottom, 'below')
        selection.shiftAnchor(distance, 0, bottom)
        handle.scrollBy(-AUTOSCROLL_STEP_ROWS)
        notifyScroll(handle)
      } else {
        const room = max - offset
        if (room <= 0) return
        const distance = Math.min(AUTOSCROLL_STEP_ROWS, room)
        selection.captureScrolledRows(top, top + distance - 1, 'above')
        selection.shiftAnchor(-distance, top, bottom)
        handle.scrollBy(AUTOSCROLL_STEP_ROWS)
        notifyScroll(handle)
      }
    }, AUTOSCROLL_TICK_MS)
    return () => clearInterval(timer)
  }, [isActive, activeHandle, selection, notifyScroll])

  void isModal
  void topOverlay
  return null
}

export default ScrollKeybindingHandler
