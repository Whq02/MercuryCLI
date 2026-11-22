import React, { useCallback, useRef } from 'react'
import { useClaim } from '../hooks/effects.js'
import { WHEEL_ROWS_PER_NOTCH } from './mercury-ui/composerFloor.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { InkInstanceContext } from '../ink/components/InkInstanceContext.js'
import { isMessageCursorActive } from './messageCursorStore.js'
import { getHelmFocus } from '../utils/cockpit/helmFocus.js'
import { settingsPopupRequest } from '../utils/cockpit/settingsPopup.js'
import { isCrewViewOpen } from '../utils/cockpit/crewView.js'
import useInput from '../ink/hooks/use-input.js'
import type { Key } from '../ink/events/input-event.js'
import {
  useSelection,
} from '../ink/hooks/use-selection.js'
import { useCopyOnSelect, useSelectionBgColor } from '../hooks/useCopyOnSelect.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { topOverlay } from '../context/overlayStack.js'
import { hasElevatedSurface } from '../ink/recessLayer.js'
import { useNotifications } from '../context/notifications.js'
import { copyReceipt, getClipboardPath, subscribeClipboardReceipts } from '../ink/termio/osc.js'
import { logForDebugging } from '../utils/debug.js'
import {
  clearOwnInputSelection,
  peekInputSelectionRange,
  peekOwnInputSelection,
} from '../utils/cockpit/inputSelectionBridge.js'
import { isXtermJs } from '../ink/session/capabilities.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { subscribeUiClock } from '../utils/cockpit/uiClock.js'
import { scrollKeyHandlersOf } from './scrollKeybinding/handlers.js'
import { passedOver } from '../utils/passedOver.js'
import { hostEnv } from '../utils/hostEnv.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export type WheelAccelState = Unbuilt

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
  return notBuilt('src/components/ScrollKeybindingHandler.tsx:80')
}


const WHEEL_OWNING_OVERLAYS: Unbuilt = unbuilt('src/components/ScrollKeybindingHandler.tsx:197')

export function wheelYieldsToTopOverlay(): boolean {
  if (settingsPopupRequest()?.scrollRef) return false
  if (isCrewViewOpen()) return true
  const top = topOverlay()
  return top !== null && WHEEL_OWNING_OVERLAYS.has(top.id)
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

export function ScrollKeybindingHandler(arg0: {
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  isActive: boolean
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void
  isModal?: boolean
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>
  modalUp?: boolean
}): React.ReactNode {
  return notBuilt('src/components/ScrollKeybindingHandler.tsx:239')
}

export default ScrollKeybindingHandler
