import React, { useCallback, useRef } from 'react'
import { useClaim } from '../effects/effects.js'
import { WHEEL_ROWS_PER_NOTCH } from '../widgets/composerFloor.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { ScreenInstanceContext } from '../renderer/elements/InkInstanceContext.js'
import { isMessageCursorActive } from '../messages/messageCursorStore.js'
import { getHelmFocus } from '../cockpit/helmFocus.js'
import { settingsPopupRequest } from '../cockpit/settingsPopup.js'
import { isCrewViewOpen } from '../cockpit/crewView.js'
import useInput from '../renderer/bindings/use-input.js'
import type { InputEvent, Key } from '../renderer/events/input-event.js'
import {
  useSelection,
} from '../renderer/bindings/use-selection.js'
import { useCopyOnSelect, useSelectionBgColor } from '../composer/useCopyOnSelect.js'
import { useKeybindings } from '../keys/useKeybinding.js'
import { topOverlay } from '../overlays/overlayStack.js'
import { hasElevatedSurface } from '../renderer/recessLayer.js'
import { useNotifications } from '../notifications/notifications.js'
import { copyReceipt, getClipboardPath, subscribeClipboardReceipts } from '../renderer/termio/osc.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import {
  clearOwnInputSelection,
  peekInputSelectionRange,
  peekOwnInputSelection,
} from '../cockpit/inputSelectionBridge.js'
import { isXtermJs } from '../renderer/terminal-session/capabilities.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'
import { scrollKeyHandlersOf } from './scrollKeyHandlers.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'


export type WheelAccelState = {
  time: number
  mult: number
  dir: -1 | 0 | 1
  xtermJs: boolean
  frac: number
  base: number
  pendingFlip: -1 | 0 | 1
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
  const dt = state.time === 0 ? Infinity : now - state.time
  if (state.xtermJs) {
    if (dir === state.dir && dt < SAME_BATCH_GAP_MS) {
      state.time = now
      return 1
    }
    if (dir !== state.dir || dt > 500) {
      state.dir = dir
      state.mult = 2
      state.frac = 0
      state.time = now
      return 2
    }
    const decay = 0.5 ** (dt / NATIVE_HALFLIFE_MS)
    const cap = dt >= 80 ? 3 : 6
    state.mult = Math.min(cap, 1 + (state.mult - 1) * decay + 5 * decay)
    state.time = now
    const total = state.mult + state.frac
    const step = Math.floor(total)
    state.frac = total - step
    return step
  }

  if (state.wheelMode && dt > NATIVE_DISENGAGE_GAP_MS) {
    state.wheelMode = false
    state.burstCount = 0
    state.cadenceCount = 0
    state.mult = state.base
  }

  if (state.pendingFlip !== 0) {
    if (dir === state.pendingFlip) {
      state.dir = dir
      state.pendingFlip = 0
      state.mult = state.base
      state.cadenceCount = 0
      state.burstCount = 0
      state.time = now
      return Math.floor(state.mult)
    }
    if (dt <= FLIP_WINDOW_MS) {
      state.pendingFlip = 0
      state.wheelMode = true
      state.cadenceCount = 0
    } else {
      state.dir = state.pendingFlip
      state.pendingFlip = dir
      state.time = now
      return 0
    }
  } else if (state.dir !== 0 && dir !== state.dir) {
    state.pendingFlip = dir
    state.time = now
    return 0
  } else {
    state.dir = dir
  }

  if (!state.wheelMode) {
    if (dt > CADENCE_MIN_GAP_MS && dt < CADENCE_MAX_GAP_MS) {
      state.cadenceCount += 1
      if (state.cadenceCount >= 3) {
        state.wheelMode = true
      }
    } else {
      state.cadenceCount = 0
    }
  }

  if (!state.wheelMode) {
    if (dt > TRACKPAD_WINDOW_MS) {
      state.mult = state.base
    } else {
      state.mult = Math.min(Math.max(6, state.base * 2), state.mult + 0.3)
    }
    state.time = now
    return Math.floor(state.mult)
  }

  if (dt < SAME_BATCH_GAP_MS) {
    state.burstCount += 1
    if (state.burstCount >= 5) {
      state.wheelMode = false
      state.burstCount = 0
      state.cadenceCount = 0
      state.mult = state.base
    }
    state.time = now
    return 1
  }

  state.burstCount = 0
  const decay = 0.5 ** (dt / NATIVE_HALFLIFE_MS)
  const cap = Math.max(15, state.base * 2)
  const next = 1 + (state.mult - 1) * decay + 15 * decay
  state.mult = Math.min(cap, state.mult + 3, next)
  state.time = now
  return Math.floor(state.mult)
}


const WHEEL_OWNING_OVERLAYS: ReadonlySet<string> = new Set([
  'select',
  'model-picker',
  'command-palette',
  'quick-open',
  'file-open',
  'content-search',
  'files-menu',
  'effort-popup',
  'health-popup',
])

export function wheelYieldsToTopOverlay(): boolean {
  const top = topOverlay()
  if (top !== null && WHEEL_OWNING_OVERLAYS.has(top.id)) return true
  if (settingsPopupRequest()?.scrollRef) return false
  return isCrewViewOpen()
}

export function shouldClearSelectionOnKey(key: Key): boolean {
  if (key.shift || key.meta) return false
  if (key.wheelUp || key.wheelDown) return false
  return true
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
export const AUTOSCROLL_STEP_ROWS = 2
export const AUTOSCROLL_TICK_MS = 50
const AUTOSCROLL_MAX_TICKS = 200
const COPY_TOAST_KEY = 'selection-copy'

function traceScrollRequest(
  delta: number,
  handle: ScrollBoxHandle,
  max: number,
): void {
  const tracePath = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!tracePath) return
  try {
    appendFileSync(
      tracePath,
      `${JSON.stringify({
        t: Date.now(),
        ev: 'scroll-request',
        delta,
        top: handle.getScrollTop(),
        pending: handle.getPendingDelta(),
        max,
        viewport: handle.getViewportHeight(),
        sticky: handle.isSticky(),
      })}\n`,
    )
  } catch (error) {
    passedOver(error)
  }
}

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
  const instance = React.useContext(ScreenInstanceContext)
  const selection = useSelection()
  const { addNotification } = useNotifications()
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  const wheelAccelRef = useRef<WheelAccelState | null>(null)
  const receiptUnsubRef = useRef<(() => void) | null>(null)

  const activeHandle = useCallback((): ScrollBoxHandle | null => {
    const popupScroll = settingsPopupRequest()?.scrollRef
    if (popupScroll) return popupScroll.current
    if (modalUp) return modalScrollRef?.current ?? null
    return scrollRef.current
  }, [modalUp, modalScrollRef, scrollRef])

  const notifyScroll = useCallback(
    (handle: ScrollBoxHandle): void => {
      if (modalUp || settingsPopupRequest()?.scrollRef) return
      const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight())
      const projected = handle.getScrollTop() + handle.getPendingDelta()
      onScrollRef.current?.(projected >= max, handle)
    },
    [modalUp],
  )

  useClaim(() => {
    if (!instance) return
    return instance.registerTranscriptScrollTarget(() => {
      if (!isActive || isModal || modalUp) return false
      if (topOverlay() !== null) return false
      if (settingsPopupRequest() !== null) return false
      if (isCrewViewOpen()) return false
      if (getHelmFocus() !== 'prompt') return false
      const handle = scrollRef.current
      return handle !== null && handle.getScrollHeight() > handle.getViewportHeight()
    })
  }, [instance, isActive, isModal, modalUp, scrollRef])

  useClaim(() => {
    if (!instance) return
    return instance.registerArrowKeyOwner(isMessageCursorActive)
  }, [instance])

  useClaim(() => {
    return () => {
      receiptUnsubRef.current?.()
      receiptUnsubRef.current = null
    }
  }, [])

  const raiseCopyToast = useCallback((): void => {
    const path = getClipboardPath()
    addNotification({
      key: COPY_TOAST_KEY,
      ...copyReceipt(path),
      priority: 'immediate',
      timeoutMs: path === 'native' ? 2000 : 4000,
    })
    if (path === 'osc52') return
    receiptUnsubRef.current?.()
    const unsub = subscribeClipboardReceipts(settledReceipt => {
      unsub()
      if (receiptUnsubRef.current === unsub) {
        receiptUnsubRef.current = null
      }
      if (settledReceipt.settled.length === 0) {
        addNotification({
          key: COPY_TOAST_KEY,
          ...copyReceipt('unsettled'),
          priority: 'immediate',
          timeoutMs: 4000,
        })
      }
    })
    receiptUnsubRef.current = unsub
  }, [addNotification])

  const copyOwnInputSelection = useCallback((): boolean => {
    const own = peekOwnInputSelection()
    if (!own) return false
    selection.copyText(own.text)
    clearOwnInputSelection()
    if (own.text) raiseCopyToast()
    return true
  }, [selection, raiseCopyToast])

  useCopyOnSelect(selection, isActive, raiseCopyToast)
  useSelectionBgColor(selection)

  const pageStep = useCallback((): number => {
    const handle = activeHandle()
    if (!handle) return 1
    return Math.max(1, handle.getViewportHeight() - PAGE_OVERLAP_ROWS)
  }, [activeHandle])

  const runScroll = useCallback(
    (delta: number): boolean => {
      const handle = activeHandle()
      if (!handle) return false
      const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight())
      if (max === 0) return false
      const current = handle.getScrollTop() + handle.getPendingDelta()
      const target = Math.max(0, Math.min(max, current + delta))
      if (target >= max) {
        handle.scrollTo(max)
        handle.scrollToBottom()
      } else {
        handle.scrollTo(target)
      }
      traceScrollRequest(delta, handle, max)
      notifyScroll(handle)
      return true
    },
    [activeHandle, notifyScroll],
  )

  const keyHandlers = scrollKeyHandlersOf({
    runScroll,
    pageStep,
    modalUp,
    wheelYieldsToTopOverlay,
    activeHandle,
    notifyScroll,
    selection,
    raiseCopyToast,
    copyOwnInputSelection,
  })
  useKeybindings(keyHandlers, { context: 'Scroll', isActive })

  useInput(
    (input: string, key: Key, event: InputEvent) => {
      if (key.wheelUp || key.wheelDown) {
        if (wheelYieldsToTopOverlay()) return
        const popupScroll = settingsPopupRequest()?.scrollRef
        if (popupScroll) {
          event.stopImmediatePropagation()
        } else if (event.wheelStep && (topOverlay() !== null || hasElevatedSurface())) {
          return
        }
        if (event.wheelStep) {
          event.stopImmediatePropagation()
        }
        const handle = activeHandle()
        if (!handle) return
        const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight())
        if (max === 0) return
        if (wheelAccelRef.current === null) {
          const hosted = isXtermJs()
          wheelAccelRef.current = initWheelAccel(hosted)
          logForDebugging(
            `wheel model: ${hosted ? 'browser-hosted' : 'native'} (TERM_PROGRAM=${hostEnv().TERM_PROGRAM ?? ''})`,
          )
        }
        const dir: 1 | -1 = key.wheelUp ? -1 : 1
        const step = event.wheelStep
          ? WHEEL_ROWS_PER_NOTCH
          : computeWheelStep(wheelAccelRef.current, dir, performance.now())
        if (step === 0) return
        const delta = dir * step
        const current = handle.getScrollTop() + handle.getPendingDelta()
        const target = current + delta
        if (target <= 0) {
          handle.scrollTo(0)
        } else if (target >= max) {
          handle.scrollTo(max)
          handle.scrollToBottom()
        } else {
          handle.scrollBy(delta)
        }
        traceScrollRequest(delta, handle, max)
        notifyScroll(handle)
        return
      }

      if (key.ctrl && input === 'c' && !key.shift && !key.meta && !key.super) {
        if (selection.hasSelection()) {
          const text = selection.copySelection()
          if (text) raiseCopyToast()
          event.stopImmediatePropagation()
          return
        }
        if (copyOwnInputSelection()) {
          event.stopImmediatePropagation()
          return
        }
        return
      }

      if (!shouldClearSelectionOnKey(key)) return
      if (!selection.hasSelection()) return
      const reachesEditorRange =
        peekInputSelectionRange() !== null &&
        ((input.length > 0 && !key.ctrl && !key.super) ||
          key.backspace ||
          key.delete ||
          ((key.leftArrow || key.rightArrow) && !key.ctrl && !key.super))
      if (!reachesEditorRange) {
        selection.clearSelection()
      }
    },
    { isActive },
  )

  useClaim(() => {
    if (!isActive) return
    let dir: -1 | 0 | 1 = 0
    let ticks = 0
    return subscribeUiClock(AUTOSCROLL_TICK_MS, () => {
      const handle = activeHandle()
      const sel = selection.getState()
      if (!handle || !sel || !sel.isDragging) {
        dir = 0
        ticks = 0
        return
      }
      if (handle.getPendingDelta() !== 0) return
      if (!sel.anchor || !sel.focus) return
      const top = handle.getViewportTop()
      const viewport = handle.getViewportHeight()
      if (viewport <= 0) return
      const bottom = top + viewport - 1
      const nextDir = dragScrollDirection(
        { anchorRow: sel.anchor.row, focusRow: sel.focus.row },
        top,
        bottom,
        dir,
      )
      if (nextDir === 0) {
        const outOfBand = sel.focus.row < top || sel.focus.row > bottom
        if (dir !== 0 && outOfBand) {
          selection.clearSelection()
        }
        dir = 0
        ticks = 0
        return
      }
      dir = nextDir
      ticks += 1
      if (ticks > AUTOSCROLL_MAX_TICKS) return
      const max = Math.max(0, handle.getScrollHeight() - viewport)
      const scrollTop = handle.getScrollTop()
      const hasRoom = nextDir === -1 ? scrollTop > 0 : scrollTop < max
      if (!hasRoom) return
      handle.scrollBy(nextDir * AUTOSCROLL_STEP_ROWS)
      notifyScroll(handle)
    })
  }, [isActive, activeHandle, selection, notifyScroll])

  return null
}
