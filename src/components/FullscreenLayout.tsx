import React, { useCallback, useContext, useInsertionEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useClaim, useMeasure, usePublish } from '../hooks/effects.js'
import { fileURLToPath } from 'node:url'
import { logError } from '../utils/log.js'
import { Box, MotionParkContext, measureElement, type DOMElement } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { InkInstanceContext } from '../ink/components/InkInstanceContext.js'
import instances from '../ink/instances.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import { compactBandRows, compactFrameBudget } from './mercury-ui/geometry.js'
import { railPlan } from '../utils/helmGeometry.js'
import { setHelmFocus, setHelmVitalsAvailable } from '../utils/cockpit/helmFocus.js'
import { PromptOverlayProvider } from '../context/promptOverlayContext.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { openBrowser, openPath } from '../utils/browser.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { setRecessTarget } from '../ink/recessLayer.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { recessTargetFor } from '../utils/cockpit/recessBackdrop.js'
import { modelPickerPopupClaimed, subscribeModelPickerPopup } from '../utils/cockpit/modelPickerPopup.js'
import { commandPopupClaim, subscribeCommandPopup } from '../utils/cockpit/commandPopup.js'
import { SettingsPopupSlot } from './SettingsPopupSlot.js'
import { useViewedCrewmate } from './tasks/useCrewmateView.js'
import { AppStoreContext, useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { enqueueNotification } from '../context/notifications.js'
import type { Message as WireMessage, NormalizedMessage } from '../types/message.js'
import { isNullRenderingAttachment, isNullRenderingSystemRow } from './messages/nullRenderingAttachments.js'
import type { UnseenDivider } from './fullscreenLayout/panes.js'
import { fullscreenFrame } from './fullscreenLayout/frame.js'
import { notBuilt } from '../pi/holes.js'
export type { UnseenDivider } from './fullscreenLayout/panes.js'


export function countUnseenAssistantTurns(
  messages: readonly WireMessage[],
  dividerIndex: number,
): number {
  let turns = 0
  let previousWasAssistant = false
  for (let i = dividerIndex; i < messages.length; i++) {
    const message = messages[i]!
    if (message.type === 'progress') continue
    if (message.type === 'assistant') {
      const content = (message as NormalizedMessage & { message: { content: unknown } })
        .message?.content
      const hasVisibleText =
        Array.isArray(content) &&
        content.some(
          block =>
            (block as { type?: string; text?: string }).type === 'text' &&
            ((block as { text?: string }).text ?? '') !== '',
        )
      if (!hasVisibleText) continue
      if (!previousWasAssistant) turns += 1
      previousWasAssistant = true
      continue
    }
    previousWasAssistant = false
  }
  return turns
}

export function computeUnseenDivider(
  messages: readonly WireMessage[],
  dividerIndex: number | null,
): UnseenDivider | undefined {
  if (dividerIndex === null || dividerIndex < 0 || dividerIndex >= messages.length) {
    return undefined
  }
  let anchor: WireMessage | undefined
  for (let i = dividerIndex; i < messages.length; i++) {
    const message = messages[i]!
    if (message.type === 'progress') continue
    if (
      message.type === 'attachment' &&
      isNullRenderingAttachment(message)
    ) {
      continue
    }
    if (message.type === 'system' && isNullRenderingSystemRow(message)) {
      continue
    }
    anchor = message
    break
  }
  if (!anchor) return undefined
  const count = Math.max(1, countUnseenAssistantTurns(messages, dividerIndex))
  return { firstUnseenUuid: (anchor as { uuid: string }).uuid, count }
}

export function useUnseenDivider(
  messageCount: number,
  scrollRef?: React.RefObject<ScrollBoxHandle | null>,
): {
  dividerIndex: number | null
  dividerYRef: React.MutableRefObject<number | null>
  onScrollAway: (handle: ScrollBoxHandle) => void
  onRepin: () => void
  jumpToNew: (handle: ScrollBoxHandle | null) => void
  shiftDivider: (indexDelta: number, heightDelta: number) => void
} {
  return notBuilt('src/components/FullscreenLayout.tsx:92')
}


export function FullscreenLayout(arg0: {
  scrollable: React.ReactNode
  bottom: React.ReactNode
  overlay?: React.ReactNode
  bottomFloat?: React.ReactNode
  statusBand?: React.ReactNode
  statusBandActive?: boolean
  modal?: React.ReactNode
  modalActive?: boolean
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  dividerYRef?: React.MutableRefObject<number | null>
  hidePill?: boolean
  newMessageCount?: number
  onPillClick?: () => void
}): React.ReactNode {
  return notBuilt('src/components/FullscreenLayout.tsx:207')
}

export default FullscreenLayout
