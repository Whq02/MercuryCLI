
import React, {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, MotionParkContext, Text, measureElement } from '../ink.js'
import type { DOMElement } from '../ink.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../ink/components/ScrollBox.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import instances from '../ink/instances.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { CompactFooterNoticeContext, CompactFrameBudgetContext, useLayoutChrome } from '../context/layoutChromeContext.js'
import { compactFrameBudget } from './mercury-ui/geometry.js'
import { railPlan } from '../utils/helmGeometry.js'
import {
  setHelmFocus,
  setHelmTelemetryAvailable,
} from '../utils/cockpit/helmFocus.js'
import { ModalContext } from '../context/modalContext.js'
import {
  PromptOverlayProvider,
  usePromptOverlay,
  usePromptOverlayDialog,
} from '../context/promptOverlayContext.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { openBrowser, openPath } from '../utils/browser.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { setRecessTarget } from '../ink/recessLayer.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { recessTargetFor } from '../utils/cockpit/recessBackdrop.js'
import { DeckPane } from './DeckPane.js'
import { HelmCenterHeader } from './HelmCenterHeader.js'
import { HelmLanesRail } from './HelmLanesRail.js'
import { HelmTelemetryRail } from './HelmTelemetryRail.js'
import { PinnedCritterBerth, berthCritterCols } from './MercuryHome.js'
import { BerthCompanionLine } from './mercury-ui/MiniCritter.js'
import { WorkCapsule } from './mercury-ui/WorkCapsule.js'
import { PromptInputFooterSuggestions } from './PromptInput/PromptInputFooterSuggestions.js'
import type {
  Message as WireMessage,
  NormalizedMessage,
} from '../types/message.js'
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js'
import { cockpitEngine } from '../render-engine/cockpit/engineMount.js'


export type UnseenDivider = { firstUnseenUuid: string; count: number }

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
      isNullRenderingAttachment(message as never)
    ) {
      continue
    }
    anchor = message
    break
  }
  if (!anchor) return undefined
  const count = Math.max(1, countUnseenAssistantTurns(messages, dividerIndex))
  return { firstUnseenUuid: (anchor as { uuid: string }).uuid, count }
}

export function useUnseenDivider(messageCount: number): {
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

  if (dividerIndex !== null && messageCount < dividerIndex) {
    setDividerIndex(null)
    dividerYRef.current = null
  }

  useEffect(() => {
    if (clearSnapshotRef.current && dividerIndex === null) {
      clearSnapshotRef.current = false
      dividerYRef.current = null
    }
  }, [dividerIndex])

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


type StickyPrompt = { text: string; scrollTo: () => void }

export const ScrollChromeContext = createContext<{
  setStickyPrompt: (prompt: StickyPrompt | 'clicked' | null) => void
}>({ setStickyPrompt: () => {} })


function PromptOverlayStrip(): React.ReactNode {
  const data = usePromptOverlay()
  const dialog = usePromptOverlayDialog()
  if (dialog) return <Box flexDirection="column">{dialog}</Box>
  if (!data) return null
  return (
    <PromptInputFooterSuggestions
      suggestions={data.suggestions}
      overlay
      onPick={data.onPick}
      onHover={data.onHover}
      maxColumnWidth={data.maxColumnWidth}
      maxRows={data.maxRows}
    />
  )
}

function JumpPill({
  divider,
  scrollRef,
  dividerYRef,
  onClick,
}: {
  divider: UnseenDivider | undefined
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  dividerYRef: React.MutableRefObject<number | null>
  onClick: () => void
}): React.ReactNode {
  const visible = React.useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        scrollRef.current ? scrollRef.current.subscribe(listener) : () => {},
      [scrollRef],
    ),
    () => {
      const handle = scrollRef.current
      const y = dividerYRef.current
      if (!handle || y === null) return false
      return (
        handle.getScrollTop() +
          handle.getPendingDelta() +
          handle.getViewportHeight() <
        y
      )
    },
    () => false,
  )
  if (!visible) return null
  const count = divider?.count ?? 0
  const label =
    count === 0
      ? '[ back to the bottom · alt+↓ ]'
      : `[ ${count} new ${count === 1 ? 'message' : 'messages'} · alt+↓ ]`
  return (
    <>
      <Box height={1} flexShrink={0} />
      <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
        <InteractiveRow
          id="transcript:jump-to-new"
          directActivate
          onActivate={onClick}
          height={1}
        >
          {(hover: boolean) => (
            <Text backgroundColor={hover ? 'infoShimmer' : 'info'} bold>
              {label}
            </Text>
          )}
        </InteractiveRow>
      </Box>
    </>
  )
}


export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  bottomFloat,
  statusBand,
  statusBandActive = false,
  modal,
  modalScrollRef,
  scrollRef,
  dividerYRef,
  hidePill = false,
  hideSticky = false,
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
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  dividerYRef?: React.MutableRefObject<number | null>
  hidePill?: boolean
  hideSticky?: boolean
  newMessageCount?: number
  onPillClick?: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  const fullscreen = isFullscreenEnvEnabled()
  const [stickyPrompt, setStickyPrompt] = useState<
    StickyPrompt | 'clicked' | null
  >(null)
  const chromeContextValue = useMemo(() => ({ setStickyPrompt }), [])

  useEffect(() => {
    if (!fullscreen) return
    const ink = instances.get(process.stdout)
    if (!ink) return
    ink.onHyperlinkClick = (url: string) => {
      if (url.startsWith('file:')) {
        void openPath(url.replace(/^file:\/\//, ''))
      } else {
        void openBrowser(url)
      }
    }
    return () => {
      ink.onHyperlinkClick = undefined
    }
  }, [fullscreen])

  const terminalRows = rows
  const { chrome, isCompact } = useLayoutChrome()
  const [compactFooterNotice, setCompactFooterNotice] = useState(false)
  const compactBudget = useMemo(() => isCompact ? compactFrameBudget(columns, rows, statusBandActive, compactFooterNotice) : null, [isCompact, columns, rows, statusBandActive, compactFooterNotice])
  const cockpit = fullscreen && chrome === 'cockpit'
  const centerFrame = cockpit
  const plan = railPlan(columns)
  const modalUp = modal !== undefined && modal !== null

  useEffect(() => {
    cockpitEngine()?.noteOverlay(modalUp, false)
  }, [modalUp])

  useEffect(() => {
    const reachable = cockpit && !modalUp
    setHelmTelemetryAvailable(reachable && plan.telemetry)
    if (!reachable) setHelmFocus('prompt')
    else if (!plan.telemetry) {
      setHelmFocus('prompt')
    }
  }, [cockpit, modalUp, plan.telemetry])

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
  const telemetryBoxRef = useRef<DOMElement | null>(null)
  const [lanesRows, setLanesRows] = useState<number | undefined>(undefined)
  const [telemetryRows, setTelemetryRows] = useState<number | undefined>(
    undefined,
  )
  useLayoutEffect(() => {
    if (lanesBoxRef.current) {
      const { height } = measureElement(lanesBoxRef.current)
      if (height > 0 && height !== lanesRows) setLanesRows(height)
    }
    if (telemetryBoxRef.current) {
      const { height } = measureElement(telemetryBoxRef.current)
      if (height > 0 && height !== telemetryRows) setTelemetryRows(height)
    }
  })

  const elevatedRef = useElevatedSurface()

  useEffect(() => {
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
        </Box>
      </PromptOverlayProvider>
    )
  }

  const divider =
    newMessageCount !== undefined && newMessageCount > 0
      ? { firstUnseenUuid: '', count: newMessageCount }
      : undefined

  const modalPeek = isCompact ? 0 : chrome === 'inline' ? 2 : 0
  const modalSeparatorRows = !isCompact || terminalRows > 1 ? 1 : 0
  const t = tokens
  const modalClaims = modalPeek === 0;
  const recessOn = modal != null && recessTargetFor(t) !== null;
  const blankClaims = modalClaims && !recessOn;

  const stickyDescriptor =
    stickyPrompt !== null && stickyPrompt !== 'clicked' ? stickyPrompt : null
  const stickyVisible = !hideSticky && stickyDescriptor !== null && (!isCompact || (compactBudget?.transcriptMinRows ?? 0) > 0)
  const stickyTracked = stickyPrompt !== null

  const transcriptArea = (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={transcriptGutter}
    >
      {
}
      {stickyVisible && stickyDescriptor ? (
        <Box height={1} onClick={() => stickyDescriptor.scrollTo()}>
          <Text dimColor wrap="truncate-end">
            ❯ {stickyDescriptor.text}
          </Text>
        </Box>
      ) : null}
      <ScrollBox
        ref={scrollRef}
        stickyScroll
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingTop={isCompact || stickyTracked ? 0 : 1}
      >
        {scrollable}
      </ScrollBox>
      {!hidePill && dividerYRef && scrollRef && (!isCompact || (compactBudget?.transcriptMinRows ?? 0) > 0) ? (
        <JumpPill
          divider={divider}
          scrollRef={scrollRef}
          dividerYRef={dividerYRef}
          onClick={() => onPillClick?.()}
        />
      ) : null}
      {bottomFloat ? (
        <Box justifyContent="flex-end">{bottomFloat}</Box>
      ) : null}
    </Box>
  )

  const bottomBlock = (
    <Box flexDirection="column" flexShrink={0}>
      <PromptOverlayStrip />
      {overlay ?? null}
      {bottom}
    </Box>
  )

  const motionParked = modalUp && modalPeek === 0
  const modalPane = modalUp ? (
    <MotionParkContext.Provider value={false}>
      <Box ref={recessOn ? elevatedRef : undefined} position="absolute" bottom={0} width="100%" height={blankClaims ? terminalRows : undefined} maxHeight={Math.max(0, terminalRows - modalPeek)} flexDirection="column" overflow="hidden" opaque={true}>
        {blankClaims && <Box flexGrow={1} />}{modalSeparatorRows > 0 ? <Box flexShrink={0}><Text color="info">{"▔".repeat(Math.max(1, columns))}</Text></Box> : null}
        <ModalContext.Provider
          value={{
            rows: Math.max(0, terminalRows - modalPeek - modalSeparatorRows),
            columns,
            scrollRef: modalScrollRef ?? null,
          }}
        >
          {
}
          <Box flexShrink={0} flexDirection="column">{modal}</Box>{blankClaims && <Box flexGrow={1} />}
        </ModalContext.Provider>
      </Box>
    </MotionParkContext.Provider>
  ) : null

  return (
    <AlternateScreen>
      <PromptOverlayProvider>
        <CompactFooterNoticeContext.Provider value={isCompact ? setCompactFooterNotice : null}>
        <CompactFrameBudgetContext.Provider value={compactBudget}>
        <CockpitActiveContext.Provider value={cockpit}>
          {
}
          <MotionParkContext.Provider value={motionParked}>
            <Box
              flexDirection="column"
              width={columns}
              height={rows}
              overflow="hidden"
              {...(estateGroundBg(tokens) !== undefined
                ? { backgroundColor: estateGroundBg(tokens) }
                : {})}
            >
              {fullscreen && !isCompact && chrome === 'deck-strip' ? <DeckPane /> : null}
              <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
                {}
                <Box ref={lanesBoxRef} flexDirection="column" overflow="hidden" flexShrink={0} width={cockpit && plan.lanes ? plan.lanesW : 0}>
                  {cockpit && plan.lanes ? (
                    <HelmLanesRail
                      width={plan.lanesW}
                      mergedTelemetry={!plan.telemetry}
                      availRows={lanesRows}
                    />
                  ) : null}
                </Box>
                {}
                <Box
                  flexDirection="column"
                  flexGrow={1}
                  minWidth={0}
                  overflow="hidden"
                  borderStyle={centerFrame ? 'round' : undefined}
                  borderColor={centerFrame ? t.borderStrong : undefined}
                >
                  {
}
                  {centerFrame ? <HelmCenterHeader width={sizeVal.columns} /> : null}
                  <TerminalSizeContext.Provider value={sizeVal}>
                    {centerFrame && statusBand ? (
                      <Box
                        flexDirection="row"
                        flexShrink={0}
                        width={sizeVal.columns}
                        borderStyle="round"
                        borderColor={t.borderStrong}
                        paddingX={1}
                        gap={1}
                      >
                        <PinnedCritterBerth />
                        <Box
                          flexDirection="column"
                          flexGrow={1}
                          minWidth={0}
                          justifyContent="center"
                        >
                          <WorkCapsule
                            active={!!statusBandActive}
                            width={
                              sizeVal.columns - 4 - 1 -
                              berthCritterCols(sizeVal.columns, sizeVal.rows)
                            }
                          >
                            {statusBand}
                          </WorkCapsule>
                          <BerthCompanionLine />
                        </Box>
                      </Box>
                    ) : null}
                    <TerminalSizeContext.Provider value={transcriptSize}>
                      {transcriptArea}
                    </TerminalSizeContext.Provider>
                  </TerminalSizeContext.Provider>
                </Box>
                {}
                <Box ref={telemetryBoxRef} flexDirection="column" overflow="hidden" flexShrink={0} width={cockpit && plan.telemetry ? plan.telemetryW : 0}>
                  {cockpit && plan.telemetry ? (
                    <HelmTelemetryRail
                      width={plan.telemetryW}
                      availRows={telemetryRows}
                    />
                  ) : null}
                </Box>
              </Box>
              <ScrollChromeContext.Provider value={chromeContextValue}>
                {bottomBlock}
              </ScrollChromeContext.Provider>
              {modalPane}
            </Box>
          </MotionParkContext.Provider>
        </CockpitActiveContext.Provider>
        </CompactFrameBudgetContext.Provider>
        </CompactFooterNoticeContext.Provider>
      </PromptOverlayProvider>
    </AlternateScreen>
  )
}

export default FullscreenLayout
