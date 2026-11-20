
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
  const [dividerIndex, setDividerIndex] = useState<number | null>(null)
  const dividerYRef = useRef<number | null>(null)
  const countRef = useRef(messageCount)
  countRef.current = messageCount
  const clearSnapshotRef = useRef(false)
  const previousCountRef = useRef(messageCount)
  const shrunkRef = useRef(false)
  if (messageCount < previousCountRef.current) shrunkRef.current = true
  previousCountRef.current = messageCount
  const viewKey = useAppStateMaybeOutsideOfProvider(state => state.viewingAgentTaskId) ?? ''
  const viewKeyRef = useRef(viewKey)
  const parkedRef = useRef(new Map<string, { index: number | null; y: number | null }>())
  if (viewKey !== viewKeyRef.current) {
    parkedRef.current.set(viewKeyRef.current, { index: dividerIndex, y: clearSnapshotRef.current ? null : dividerYRef.current })
    clearSnapshotRef.current = false
    viewKeyRef.current = viewKey
    const parked = parkedRef.current.get(viewKey)
    dividerYRef.current = parked?.y ?? null
    if ((parked?.index ?? null) !== dividerIndex) setDividerIndex(parked?.index ?? null)
  }

  if (dividerIndex !== null && messageCount < dividerIndex) {
    setDividerIndex(null)
    dividerYRef.current = null
  }

  usePublish(() => {
    if (clearSnapshotRef.current && dividerIndex === null) {
      clearSnapshotRef.current = false
      dividerYRef.current = null
    }
  }, [dividerIndex])

  useMeasure(() => {
    if (!shrunkRef.current) return
    shrunkRef.current = false
    const handle = scrollRef?.current
    if (!handle) return
    const height = handle.getFreshScrollHeight()
    const max = Math.max(0, height - handle.getViewportHeight())
    const atBottom =
      handle.isSticky() ||
      handle.getScrollTop() + handle.getPendingDelta() >= max
    if (!atBottom) {
      if (dividerYRef.current !== null && dividerYRef.current > height) {
        dividerYRef.current = height
      }
      return
    }
    const past = handle.getScrollTop() > max
    if (!past && dividerYRef.current === null && dividerIndex === null) return
    if (past) handle.scrollTo(max)
    handle.scrollToBottom()
    dividerYRef.current = null
    setDividerIndex(null)
  })

  const onScrollAway = useCallback(
    (handle: ScrollBoxHandle) => {
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      if (handle.getScrollTop() + handle.getPendingDelta() >= max) return
      if (dividerYRef.current !== null) return
      dividerYRef.current = handle.getScrollHeight()
      setDividerIndex(countRef.current)
    },
    [],
  )

  const onRepin = useCallback(() => {
    clearSnapshotRef.current = true
    setDividerIndex(null)
  }, [])

  const jumpToNew = useCallback((handle: ScrollBoxHandle | null) => {
    if (!handle) return
    handle.scrollToBottom()
  }, [])

  const shiftDivider = useCallback(
    (indexDelta: number, heightDelta: number) => {
      setDividerIndex(previous =>
        previous === null ? null : previous + indexDelta,
      )
      if (dividerYRef.current !== null) {
        dividerYRef.current += heightDelta
      }
    },
    [],
  )

  return {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider,
  }
}


export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  bottomFloat,
  statusBand,
  statusBandActive = false,
  modal,
  modalActive = true,
  modalScrollRef,
  scrollRef,
  dividerYRef,
  hidePill = false,
  newMessageCount,
  onPillClick,
}: {
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
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  const fullscreen = isFullscreenEnvEnabled()
  const appStore = useContext(AppStoreContext)

  useClaim(() => {
    if (!fullscreen) return
    const ink = instances.get(process.stdout)
    if (!ink) return
    const notifyOpenFailed = (target: string, error: string): void => {
      if (!appStore) return
      enqueueNotification(appStore.setState, {
        key: 'hyperlink-open-failed',
        text: `${target} could not be opened (${error}) — open it yourself`,
        color: 'warning',
        priority: 'high',
      })
    }
    ink.onHyperlinkClick = (url: string) => {
      if (url.startsWith('file:')) {
        try {
          const target = fileURLToPath(url)
          void openPath(target, error => notifyOpenFailed(target, error))
        } catch (error) {
          logError(error)
          notifyOpenFailed(url, error instanceof Error ? error.message : String(error))
        }
      } else {
        void openBrowser(url, error => notifyOpenFailed(url, error))
      }
    }
    return () => {
      ink.onHyperlinkClick = undefined
    }
  }, [fullscreen, appStore])

  const terminalRows = rows
  const { chrome, isCompact } = useLayoutChrome()
  const [compactFooterNotice, setCompactFooterNotice] = useState(0)
  const bandRows = isCompact ? compactBandRows(columns, rows) : 0
  const compactBudget = useMemo(() => isCompact ? compactFrameBudget(columns, rows - bandRows, statusBandActive, compactFooterNotice) : null, [isCompact, columns, rows, bandRows, statusBandActive, compactFooterNotice])
  const cockpit = fullscreen && chrome === 'cockpit'
  const centerFrame = cockpit
  const plan = railPlan(columns)
  const modalMounted = modal !== undefined && modal !== null
  const modalUp = modalMounted && modalActive
  const popupUp = useSyncExternalStore(subscribeModelPickerPopup, modelPickerPopupClaimed, modelPickerPopupClaimed) && modalMounted
  const commandPopup = useSyncExternalStore(subscribeCommandPopup, commandPopupClaim, commandPopupClaim)
  const commandPopupUp = commandPopup !== null && modalMounted
  const ink = useContext(InkInstanceContext)
  const covered = useContext(MotionParkContext)
  useInsertionEffect(() => {
    if (fullscreen && !covered) ink?.repaintAfterNestedAltScreenClose()
  }, [ink, fullscreen, covered, modalUp])

  usePublish(() => {
    const reachable = cockpit && !modalUp
    setHelmVitalsAvailable(reachable && plan.vitals)
    if (!reachable) setHelmFocus('prompt')
    else if (!plan.vitals) {
      setHelmFocus('prompt')
    }
  }, [cockpit, modalUp, plan.vitals])

  const overrideRef = useRef<{ columns: number; rows: number } | null>(null)
  const sizeVal = useMemo(() => {
    const next = cockpit
      ? { columns: plan.centerCols, rows: Math.max(8, rows - 2) }
      : { columns, rows }
    const previous = overrideRef.current
    if (
      previous &&
      previous.columns === next.columns &&
      previous.rows === next.rows
    ) {
      return previous
    }
    overrideRef.current = next
    return next
  }, [cockpit, plan.centerCols, columns, rows])
  const transcriptGutter = cockpit ? 1 : 0
  const transcriptSizeRef = useRef<{ columns: number; rows: number } | null>(null)
  const transcriptSize = useMemo(() => {
    const next = {
      columns: Math.max(1, sizeVal.columns - 2 * transcriptGutter),
      rows: sizeVal.rows,
    }
    const previous = transcriptSizeRef.current
    if (
      previous &&
      previous.columns === next.columns &&
      previous.rows === next.rows
    ) {
      return previous
    }
    transcriptSizeRef.current = next
    return next
  }, [sizeVal, transcriptGutter])

  const lanesBoxRef = useRef<DOMElement | null>(null)
  const vitalsBoxRef = useRef<DOMElement | null>(null)
  const centreBoxRef = useRef<DOMElement | null>(null)
  const statusBandRef = useRef<DOMElement | null>(null)
  const [lanesRows, setLanesRows] = useState<number | undefined>(undefined)
  const [vitalsRows, setVitalsRows] = useState<number | undefined>(
    undefined,
  )
  const [centreRows, setCentreRows] = useState<number | undefined>(undefined)
  const [statusBandRows, setStatusBandRows] = useState<number | undefined>(undefined)
  useMeasure(() => {
    if (lanesBoxRef.current) {
      const { height } = measureElement(lanesBoxRef.current)
      if (height > 0 && height !== lanesRows) setLanesRows(height)
    }
    if (vitalsBoxRef.current) {
      const { height } = measureElement(vitalsBoxRef.current)
      if (height > 0 && height !== vitalsRows) setVitalsRows(height)
    }
    if (centreBoxRef.current) {
      const { height } = measureElement(centreBoxRef.current)
      if (height > 0 && height !== centreRows) setCentreRows(height)
    }
    if (statusBandRef.current) {
      const { height } = measureElement(statusBandRef.current)
      if (height > 0 && height !== statusBandRows) setStatusBandRows(height)
    }
  })
  const bandFits = centreRows === undefined || statusBandRows === undefined || centreRows - 2 >= statusBandRows

  const elevatedRef = useElevatedSurface()
  const viewedCrewmate = useViewedCrewmate()

  useClaim(() => {
    setRecessTarget(recessTargetFor(tokens))
    return () => setRecessTarget(null)
  }, [tokens])

  if (!fullscreen) {
    return (
      <PromptOverlayProvider>
        <Box flexDirection="column">
          {scrollable}
          <Box flexDirection="column" flexShrink={0}>
            {bottom}
          </Box>
          {overlay ?? null}
          {modal ?? null}
          <SettingsPopupSlot overlay={false} />
        </Box>
      </PromptOverlayProvider>
    )
  }

  return fullscreenFrame({ bandFits, bottom, bottomFloat, centerFrame, centreBoxRef, chrome, cockpit, columns, commandPopup, commandPopupUp, compactBudget, dividerYRef, elevatedRef, fullscreen, hidePill, isCompact, lanesBoxRef, lanesRows, modal, modalMounted, modalScrollRef, modalUp, newMessageCount, onPillClick, overlay, plan, popupUp, rows, scrollRef, scrollable, setCompactFooterNotice, sizeVal, statusBand, statusBandActive, statusBandRef, terminalRows, tokens, transcriptGutter, transcriptSize, viewedCrewmate, vitalsBoxRef, vitalsRows })
}

export default FullscreenLayout
