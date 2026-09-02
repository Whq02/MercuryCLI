// Scroll input: the rebindable scroll actions, the two wheel
// acceleration models (empirical constants — data, not parameters), the
// transcript-mode modal pager keys, selection clearing/extension/copy, and
// drag-to-scroll autoscroll. Renders nothing.

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

// ── wheel acceleration (measured constants, treat as data) ──────────

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

/** Baseline rows per wheel event: fixed at 1 — no env knob exists. */
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

/** One wheel event → row count. Mutates state; returns 0 while a direction
 *  flip is deferred (encoder-bounce detection). */
export function computeWheelStep(
  state: WheelAccelState,
  dir: 1 | -1,
  now: number,
): number {
  const gap = state.time === 0 ? Number.POSITIVE_INFINITY : now - state.time

  if (state.xtermJs) {
    // Browser-hosted model: exactly one event per notch, no
    // pre-amplification.
    if (dir === state.dir && gap < SAME_BATCH_GAP_MS) {
      state.time = now
      return 1
    }
    if (dir !== state.dir || gap > 500) {
      state.dir = dir
      state.time = now
      // 2, not 1: a single row is easy to miss after a pause.
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

  // Native model.
  if (state.wheelMode && gap > NATIVE_DISENGAGE_GAP_MS) {
    state.wheelMode = false
    state.burstCount = 0
    state.cadenceCount = 0
    state.mult = state.base
  }

  // Encoder-bounce deferral: a direction change yields zero and is resolved
  // by the NEXT event.
  if (state.pendingFlip !== 0) {
    const pending = state.pendingFlip
    state.pendingFlip = 0
    if (dir === pending) {
      // The direction persisted — a real reversal. Commit it at baseline;
      // only the flip event's row was dropped, so THIS event falls through
      // to yield normally.
      state.dir = pending
      state.mult = state.base
    } else if (now - state.time <= FLIP_WINDOW_MS) {
      // Flip-back inside the window: an encoder bounce. Keep the pre-bounce
      // direction and multiplier and engage wheel mode — only a physical
      // encoder produces this pattern; this event continues normally.
      state.wheelMode = true
    } else {
      // The flip-back came late: the flip was real (committed at baseline),
      // and this late opposite event starts its own deferred flip.
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

  // Cadence engagement: three same-direction events with human-notch gaps.
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
        // A flick's proportional burst — trackpad signature.
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

  // Trackpad / high-resolution path.
  if (gap > TRACKPAD_WINDOW_MS) {
    state.mult = state.base
  } else {
    state.mult = Math.min(Math.max(6, state.base * 2), state.mult + 0.3)
  }
  state.time = now
  return Math.floor(state.mult)
}

// ── keyboard jump helpers ───────────────────────────────────────────────────

/** Write the offset directly, clear the pending accumulator, and return the
 *  resulting stickiness. Target measured from scrollTop + pendingDelta; at
 *  or past the max the offset is written EAGERLY, then stickiness re-enabled
 *  (the render-phase follow must see zero remaining travel). */
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

// ── selection-interaction helpers ───────────────────────────────────────────

/** Bare keys clear; wheel and modified navigation never clear; the
 *  input-seam carve-out is the CALLER's (it knows whether a live input range
 *  exists). */
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

/** Drag-autoscroll direction: before autoscroll runs the anchor must
 *  sit inside the viewport; while running, only same-direction continuation
 *  is allowed. */
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

// ── the handler component ───────────────────────────────────────────────────

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

  // Post-movement stickiness report (transcript only — a modal's scroll
  // position is not conversation scroll state).
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

  // The ONE copy receipt: "Copied to
  // clipboard", ~2 s, bottom-right (the notifications column's transient
  // row), on every selection-copy path — drag-release, plain ctrl+c with a
  // selection, and the explicit copy chords. A copy that rode a
  // multiplexer/escape transfer keeps its short where-clause (and a longer
  // read window), because "clipboard" alone would over-promise there.
  //
  // C1 clipboard honesty: the toast is raised from the PREDICTED route
  // (getClipboardPath — the selection layer's copy is fire-and-forget by
  // contract, so nothing awaits), and a one-shot settlement listener
  // corrects the words if the copy settles WORSE than predicted (pbcopy
  // missing, tmux load-buffer failed): the owner's own offer sentence
  // replaces the over-promise. A truthful settlement re-confirms nothing.
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
      if (path === 'osc52') return // already the offer wording — nothing to correct
      copySettleWatchRef.current?.()
      const unsubscribe = subscribeClipboardReceipts(receipt => {
        copySettleWatchRef.current?.()
        if (receipt.settled.length > 0) return // the toast told the truth
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

  // Copy-on-select + selection background colour ride this handler.
  useCopyOnSelect(selection, isActive, raiseCopyToast)
  useSelectionBgColor(selection)

  // ── plain ctrl+c with a selection copies ───
  // Raw and chord-exact on purpose: ctrl+c is hard-coded, never rebindable
  // (reservedShortcuts NON_REBINDABLE), and the action-level registry cannot
  // tell this chord apart from the copy chords' no-selection consume rule.
  // The key record here is the decoder's platform-neutral projection — the
  // legacy \x03 byte and the kitty CSI-u form both land as {ctrl, 'c'} on
  // darwin and win32 alike. Ordering is load-bearing and mount-stable: this
  // component sits in REPL's permanent early JSX, so this listener registers
  // BEFORE CancelRequestHandler (interrupt) and the composer's raw chord
  // (exit arm) — with a selection the copy consumes the press; without one
  // it falls through untouched, so interrupt/exit grammar is unchanged.
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
      // Translate only when both anchor AND focus sit inside the viewport.
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
      if (max <= 0) return false
      translateOrClear(delta)
      // The composed jump is the ONE owner of page/line travel: in the
      // virtualised transcript the resting content pin re-derives the
      // landing against every offsets rebuild (row-exact at settle,
      // scripts/scroll/prove-scroll-travel.ts), and in modals the content
      // is fully mounted so composed rows ARE real rows.
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
      // Half/full-page actions ship with no default chord and deliberately
      // do NOT consult the overlay — they only route around a modal.
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

  // ── wheel events (via the input stream's wheel keys) ─────────────────────
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
      // Wheel clears the selection through its own path (the drain is
      // non-deterministic; outgoing rows cannot be captured synchronously).
      selection.clearSelection()
      if (wheelState.current === null) {
        // Lazily selected on the first event (the capability probe may not
        // have resolved at mount, especially over SSH).
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
          // Clamp at the top by WRITING zero — a negative pending delta
          // grows the span past what can be mounted (blank frames).
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

  // ── key-driven selection clear ───────────────────────────────────────────
  // Input-consumable keys defer to the prompt's registered selection
  // consumer (interaction-finish widened the set beyond ⌫ to
  // printables and bare ←/→ — a printable would otherwise lose its selection to
  // this clear and append at the cursor). Everything else clearing-shaped
  // clears the transcript selection.
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

  // ── drag-to-scroll autoscroll ────────────────────────────────────────────
  const autoscrollDirRef = useRef<-1 | 0 | 1>(0)
  const autoscrollTicksRef = useRef(0)
  useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => {
      const handle = activeHandle()
      const state = selection.getState()
      const dragging = Boolean(
        (state as { dragging?: boolean } | null)?.dragging,
      )
      if (!handle || !state || !dragging) {
        autoscrollDirRef.current = 0
        autoscrollTicksRef.current = 0
        return
      }
      if (autoscrollTicksRef.current > AUTOSCROLL_MAX_TICKS) return
      // Skip entirely while a pending delta is outstanding: the screen
      // buffer has not updated, so a capture would read stale rows.
      if (handle.getPendingDelta() !== 0) return
      const top = handle.getViewportTop()
      const bottom = top + handle.getViewportHeight() - 1
      const focusRow = (state as { focus?: { row: number } }).focus?.row ?? 0
      const anchorRow = (state as { anchor?: { row: number } }).anchor?.row ?? 0
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
          // Blocked reversal: clear the captures so read-back matches the
          // visible highlight.
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
        // The downward clamp uses the viewport top, not zero (the padding
        // row would otherwise insert a blank line on read-back).
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
