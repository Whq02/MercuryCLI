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
  return { firstUnseenUuid: anchor.uuid, count }
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
  const viewKey = useAppStateMaybeOutsideOfProvider(s => s.viewingAgentTaskId) ?? ''
  const [dividerIndex, setDividerIndex] = useState<number | null>(null)
  const [repinEpoch, setRepinEpoch] = useState(0)
  const dividerYRef = useRef<number | null>(null)
  const pendingClearYRef = useRef(false)
  const countRef = useRef(messageCount)
  countRef.current = messageCount
  const dividerIndexRef = useRef<number | null>(dividerIndex)
  dividerIndexRef.current = dividerIndex
  const parkedRef = useRef<Map<string, { index: number | null; y: number | null }>>(
    new Map(),
  )
  const prevViewRef = useRef<string>(viewKey)
  const prevCountRef = useRef(messageCount)
  const pendingShrinkRef = useRef(false)

  if (prevViewRef.current !== viewKey) {
    parkedRef.current.set(prevViewRef.current, {
      index: dividerIndex,
      y: pendingClearYRef.current ? null : dividerYRef.current,
    })
    prevViewRef.current = viewKey
    prevCountRef.current = messageCount
    const restored = parkedRef.current.get(viewKey)
    const restoredIndex = restored?.index ?? null
    const nextIndex =
      restoredIndex !== null && messageCount < restoredIndex ? null : restoredIndex
    pendingClearYRef.current = false
    dividerYRef.current = nextIndex === null ? null : (restored?.y ?? null)
    pendingShrinkRef.current = false
    if (nextIndex !== dividerIndex) {
      setDividerIndex(nextIndex)
    }
  } else {
    if (messageCount < prevCountRef.current) {
      pendingShrinkRef.current = true
      if (dividerIndex !== null && messageCount < dividerIndex) {
        pendingClearYRef.current = false
        dividerYRef.current = null
        setDividerIndex(null)
      }
    }
    prevCountRef.current = messageCount
  }

  usePublish(() => {
    if (pendingClearYRef.current) {
      pendingClearYRef.current = false
      dividerYRef.current = null
    }
  }, [dividerIndex, repinEpoch])

  useMeasure(() => {
    if (!pendingShrinkRef.current) return
    pendingShrinkRef.current = false
    const handle = scrollRef?.current
    if (!handle) return
    const contentHeight = handle.getFreshScrollHeight()
    const viewportHeight = handle.getFreshViewportHeight()
    const max = Math.max(0, contentHeight - viewportHeight)
    const scrollTop = handle.getScrollTop()
    const atBottom =
      handle.isSticky() || scrollTop + handle.getPendingDelta() >= max
    if (atBottom) {
      if (scrollTop > max) {
        handle.scrollTo(max)
      }
      handle.scrollToBottom()
      if (dividerIndexRef.current !== null || dividerYRef.current !== null) {
        pendingClearYRef.current = false
        dividerYRef.current = null
        setDividerIndex(null)
      }
    } else if (dividerYRef.current !== null && dividerYRef.current > contentHeight) {
      dividerYRef.current = contentHeight
    }
  }, [messageCount, scrollRef])

  const onScrollAway = useCallback((handle: ScrollBoxHandle) => {
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight())
    if (
      handle.getScrollTop() + handle.getPendingDelta() < max &&
      (dividerYRef.current === null || pendingClearYRef.current)
    ) {
      pendingClearYRef.current = false
      dividerYRef.current = handle.getScrollHeight()
      setDividerIndex(countRef.current)
    }
  }, [])

  const onRepin = useCallback(() => {
    pendingClearYRef.current = true
    setDividerIndex(null)
    setRepinEpoch(n => n + 1)
  }, [])

  const jumpToNew = useCallback((handle: ScrollBoxHandle | null) => {
    handle?.scrollToBottom()
  }, [])

  const shiftDivider = useCallback((indexDelta: number, heightDelta: number) => {
    setDividerIndex(prev => (prev === null ? null : prev + indexDelta))
    if (dividerYRef.current !== null) {
      dividerYRef.current += heightDelta
    }
  }, [])

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
  const terminalRows = rows
  const fullscreen = isFullscreenEnvEnabled()
  const { chrome, isCompact } = useLayoutChrome()
  const appStore = useContext(AppStoreContext)
  const tokens = useMercuryTokens()
  const elevatedRef = useElevatedSurface()
  const viewedCrewmate = useViewedCrewmate()
  const ink = useContext(InkInstanceContext)
  const motionParked = useContext(MotionParkContext)

  const modelPickerClaimed = useSyncExternalStore(
    subscribeModelPickerPopup,
    modelPickerPopupClaimed,
    modelPickerPopupClaimed,
  )
  const commandPopup = useSyncExternalStore(
    subscribeCommandPopup,
    commandPopupClaim,
    commandPopupClaim,
  )

  const modalMounted = modal !== null && modal !== undefined
  const modalUp = modalMounted && modalActive
  const popupUp = modalMounted && modelPickerClaimed
  const commandPopupUp = modalMounted && commandPopup !== null

  const cockpit = fullscreen && chrome === 'cockpit'
  const centerFrame = cockpit
  const plan = railPlan(columns)

  const [compactFooterNotice, setCompactFooterNotice] = useState(0)
  const compactBudget = isCompact
    ? compactFrameBudget(
        columns,
        Math.max(0, rows - compactBandRows(columns, rows)),
        statusBandActive,
        compactFooterNotice,
      )
    : null

  const lanesBoxRef = useRef<DOMElement | null>(null)
  const vitalsBoxRef = useRef<DOMElement | null>(null)
  const centreBoxRef = useRef<DOMElement | null>(null)
  const statusBandRef = useRef<DOMElement | null>(null)
  const [lanesRows, setLanesRows] = useState<number | undefined>(undefined)
  const [vitalsRows, setVitalsRows] = useState<number | undefined>(undefined)
  const [centreRows, setCentreRows] = useState<number | undefined>(undefined)
  const [statusBandRows, setStatusBandRows] = useState<number | undefined>(undefined)

  useClaim(() => {
    if (!fullscreen) return
    const instance = instances.get(process.stdout)
    if (!instance) return
    const notifyFailed = (target: string, error: string): void => {
      if (!appStore) return
      enqueueNotification(appStore.setState, {
        key: 'hyperlink-open-failed',
        text: `${target} could not be opened (${error}) — open it yourself`,
        color: 'warning',
        priority: 'high',
      })
    }
    instance.onHyperlinkClick = (url: string) => {
      if (url.startsWith('file:')) {
        let filePath: string
        try {
          filePath = fileURLToPath(url)
        } catch (error) {
          logError(error)
          notifyFailed(url, error instanceof Error ? error.message : String(error))
          return
        }
        void openPath(filePath, error => notifyFailed(filePath, error))
        return
      }
      void openBrowser(url, error => notifyFailed(url, error))
    }
    return () => {
      instance.onHyperlinkClick = undefined
    }
  }, [fullscreen, appStore])

  useInsertionEffect(() => {
    if (!fullscreen || motionParked) return
    ink?.repaintAfterNestedAltScreenClose()
  }, [fullscreen, motionParked, ink, modalMounted, modalUp, popupUp, commandPopupUp])

  const recessTarget = useMemo(() => recessTargetFor(tokens), [tokens])
  useClaim(() => {
    if (!fullscreen) return
    setRecessTarget(recessTarget)
    return () => {
      setRecessTarget(null)
    }
  }, [fullscreen, recessTarget])

  const helmVitalsAvailable = cockpit && !modalUp && plan.vitals
  usePublish(() => {
    setHelmVitalsAvailable(helmVitalsAvailable)
    if (!helmVitalsAvailable) {
      setHelmFocus('prompt')
    }
  }, [cockpit, modalUp, helmVitalsAvailable])

  useMeasure(() => {
    if (!fullscreen) return
    if (lanesBoxRef.current) {
      const h = measureElement(lanesBoxRef.current).height
      if (h > 0 && h !== lanesRows) setLanesRows(h)
    }
    if (vitalsBoxRef.current) {
      const h = measureElement(vitalsBoxRef.current).height
      if (h > 0 && h !== vitalsRows) setVitalsRows(h)
    }
    if (centreBoxRef.current) {
      const h = measureElement(centreBoxRef.current).height
      if (h > 0 && h !== centreRows) setCentreRows(h)
    }
    if (statusBandRef.current) {
      const h = measureElement(statusBandRef.current).height
      if (h > 0 && h !== statusBandRows) setStatusBandRows(h)
    }
  })

  const sizeCols = cockpit ? plan.centerCols : columns
  const sizeRows = cockpit ? Math.max(8, rows - 2) : rows
  const sizeVal = useMemo(
    () => ({ columns: sizeCols, rows: sizeRows }),
    [sizeCols, sizeRows],
  )
  const transcriptGutter = cockpit ? 1 : 0
  const transcriptCols = cockpit ? Math.max(1, sizeCols - 2) : sizeCols
  const transcriptSize = useMemo(
    () => ({ columns: transcriptCols, rows: sizeRows }),
    [transcriptCols, sizeRows],
  )

  const bandFits =
    centreRows === undefined ||
    statusBandRows === undefined ||
    centreRows - 2 >= statusBandRows

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

  return fullscreenFrame({
    bandFits,
    bottom,
    bottomFloat,
    centerFrame,
    centreBoxRef,
    chrome,
    cockpit,
    columns,
    commandPopup,
    commandPopupUp,
    compactBudget,
    dividerYRef,
    elevatedRef,
    fullscreen,
    hidePill,
    isCompact,
    lanesBoxRef,
    lanesRows,
    modal,
    modalMounted,
    modalScrollRef,
    modalUp,
    newMessageCount,
    onPillClick,
    overlay,
    plan,
    popupUp,
    rows,
    scrollRef,
    scrollable,
    setCompactFooterNotice,
    sizeVal,
    statusBand,
    statusBandActive,
    statusBandRef,
    terminalRows,
    tokens,
    transcriptGutter,
    transcriptSize,
    viewedCrewmate,
    vitalsBoxRef,
    vitalsRows,
  })
}
export default FullscreenLayout
