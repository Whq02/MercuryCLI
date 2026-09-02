// The layout shell. Outside fullscreen the slots render sequentially
// so native scrollback works unchanged. In fullscreen the scaffold is FIXED:
// the root element type never changes with the width, every optional region
// holds a permanent slot, the size-override keeps object identity while the
// geometry is unchanged, and a modal COVERS the cockpit without dismantling
// it. The unseen-divider machinery lives here too.

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
import { chromeModeLive } from '../hooks/useLayoutTier.js'
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
import { DeckPane } from './DeckPane.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { recessTargetFor } from '../utils/cockpit/recessBackdrop.js'
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

// ── the unseen divider ─────────────────────────────────────────────────────

export type UnseenDivider = { firstUnseenUuid: string; count: number }

/** Unseen count is assistant TURNS (non-assistant→assistant transitions):
 *  progress rows skipped; tool-call-only assistant rows skipped WITHOUT
 *  updating the previous-was-assistant state. */
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

/** The divider descriptor: undefined only when NOTHING has arrived past the
 *  divider; once any row exists past it the count floors at 1. The anchor
 *  row walks forward past progress rows and null-rendering attachments
 *  (those are filtered out of the render list). */
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
  // Mirrored into a ref DURING RENDER (an effect runs after paint; a wheel
  // event in the gap would read the previous count and land one short).
  const countRef = useRef(messageCount)
  countRef.current = messageCount
  const clearSnapshotRef = useRef(false)

  // Count dropping below the index (clear, rewind, view swap) clears both.
  if (dividerIndex !== null && messageCount < dividerIndex) {
    setDividerIndex(null)
    dividerYRef.current = null
  }

  useEffect(() => {
    // The y snapshot is cleared in an EFFECT after the null index commits,
    // so a momentum event in the same input batch cannot re-snapshot.
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
      // Nothing below the viewport ⇒ not a scroll-away at all.
      if (handle.getScrollTop() + handle.getPendingDelta() >= max) return
      // Snapshot ONLY on the first scroll-away.
      if (dividerYRef.current !== null) return
      dividerYRef.current = handle.getScrollHeight()
      setDividerIndex(countRef.current)
    },
    [],
  )

  const onRepin = useCallback(() => {
    // Clears the index but NOT the y snapshot (that follows in the effect).
    clearSnapshotRef.current = true
    setDividerIndex(null)
  }, [])

  const jumpToNew = useCallback((handle: ScrollBoxHandle | null) => {
    if (!handle) return
    // Scroll to bottom re-enables stickiness so the tail mounts and pins;
    // the divider stays rendered.
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

// ── scroll chrome context ──────────────────────────────────────────────────

/** The published sticky descriptor: text plus the jump action. 'clicked'
 *  suppresses the header while keeping the padding collapsed, so the jump
 *  target's marker lands at screen row 0 instead of shifting by a row. */
type StickyPrompt = { text: string; scrollTo: () => void }

export const ScrollChromeContext = createContext<{
  setStickyPrompt: (prompt: StickyPrompt | 'clicked' | null) => void
}>({ setStickyPrompt: () => {} })

// ── the jump pill ──────────────────────────────────────────────────────────

/** The prompt-published overlay: a dialog node wins; otherwise the published
 *  suggestion set renders in overlay form (hover/click driven — the inline
 *  selection stays with the prompt's own footer). */
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
  // Visibility subscribes directly to the scroll box with a boolean
  // snapshot, so per-frame scrolling never re-renders the layout owner.
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
  // The pill floats over a RESERVED blank row: the spacer never shrinks
  // (a normal-flow row under the transcript's height pressure collapses to
  // zero and the pill never paints), and the float takes no row of its own,
  // so a captured or copied frame keeps every content row while the pill
  // shows. A navigation cue, not a selection: the pill rides the info
  // channel at rest and brightens to infoShimmer under the pointer (the
  // RailPanel header grammar); the selection role stays reserved for the
  // cursor band.
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

// ── the shell ──────────────────────────────────────────────────────────────

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
  // The state setter itself is the context value — suppression sequencing
  // lives with the publisher (the tracker), not here.
  const chromeContextValue = useMemo(() => ({ setStickyPrompt }), [])

  // Hyperlink clicks (fullscreen only): file: URLs open locally, everything
  // else in the browser. Uninstalled on unmount.
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

  // Chrome mode is a per-render decision (the persisted deck-pane
  // opt-in is retired) behind the ONE cockpit hysteresis latch: the pure
  // threshold flapped the whole chrome (rails mount/unmount, transcript
  // rewrap) on every width report at the 99/100 boundary during a drag.
  const terminalRows = rows
  const chrome = chromeModeLive(columns, terminalRows)
  const cockpit = fullscreen && chrome === 'cockpit'
  const centerFrame = cockpit
  const plan = railPlan(columns)
  const modalUp = modal !== undefined && modal !== null

  // E8 bookkeeping (engine-mounted only): the modal slot is the cockpit's
  // compositing transient surface — declared to the engine so surface
  // opens are observable; settled history stays structurally untouched
  // (frozen ledger rows) whatever the surface does.
  useEffect(() => {
    cockpitEngine()?.noteOverlay(modalUp, false)
  }, [modalUp])

  // Rail focus release: rails off screen, the second rail folding away, or
  // an opaque modal — the availability stamp answers "can input reach the
  // rail NOW", which is not "is it mounted".
  useEffect(() => {
    const reachable = cockpit && !modalUp
    setHelmTelemetryAvailable(reachable && plan.telemetry)
    if (!reachable) setHelmFocus('prompt')
    else if (!plan.telemetry) {
      // The second rail folded while the first remains: release focus so a
      // stale telemetry focus cannot re-capture arrows when it returns.
      setHelmFocus('prompt')
    }
  }, [cockpit, modalUp, plan.telemetry])

  // The size override keeps OBJECT IDENTITY while the geometry is
  // unchanged. Centre width is already border-inner — never subtract again.
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
  // The transcript body sits one column in from each frame edge (the
  // bands above it — header, berth card — keep the full inner width), so
  // its wrap width is the frame-inner width minus the gutter. Same
  // identity rule as the override above.
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

  // Rail heights are MEASURED after layout, per rail (the first rail's
  // source unmounts on the single-rail tier).
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

  // The compositor half of the layered claim (LUSTRE L1): the recess pass
  // only runs while a target is published, and the target is a theme-family
  // fact, so the layout owner publishes it for the live tokens (memoized per
  // family × accent — this re-runs on real theme changes only). Activity
  // still comes solely from an elevated registration (the modal pane below,
  // CommandCenter's elevated prop), so an idle frame pays nothing. Without
  // this publish every layered claim painted its uncovered rows at full
  // strength — the backdrop was neither recessed nor blanked.
  useEffect(() => {
    setRecessTarget(recessTargetFor(tokens))
    return () => setRecessTarget(null)
  }, [tokens])

  if (!fullscreen) {
    // Sequential slots; native scrollback unchanged. The bottom block never
    // shrinks — squeezing it collapses the prompt's input row to a
    // border-only husk on tiny viewports; the transcript yields instead.
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

  // Peek rules: zero rows in cockpit and deck-strip chrome; two in inline.
  const modalPeek = chrome === 'inline' ? 2 : 0
  const t = tokens
  // The claim gate derives from the ONE peek decision; the recess mode from
  // the ONE policy seam — never a local env read.
  const modalClaims = modalPeek === 0;
  const recessOn = modal != null && recessTargetFor(t) !== null;
  const blankClaims = modalClaims && !recessOn;

  const stickyDescriptor =
    stickyPrompt !== null && stickyPrompt !== 'clicked' ? stickyPrompt : null
  const stickyVisible = !hideSticky && stickyDescriptor !== null
  const stickyTracked = stickyPrompt !== null

  const transcriptArea = (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={transcriptGutter}
    >
      {/* The header renders and the padding collapses on slightly different
          conditions ('clicked' keeps the collapse without the header). */}
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
        paddingTop={stickyTracked ? 0 : 1}
      >
        {scrollable}
      </ScrollBox>
      {!hidePill && dividerYRef && scrollRef ? (
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

  // The bottom block never shrinks — squeezing it collapses the prompt's
  // input row into a border-only husk; the transcript column yields instead
  // (the prompt sheds its own chrome on tight viewports).
  const bottomBlock = (
    <Box flexDirection="column" flexShrink={0}>
      <PromptOverlayStrip />
      {overlay ?? null}
      {bottom}
    </Box>
  )

  // The modal pane — the SURFACE-CLAIM invariant:
  // BLANK CLAIM (recess gate closed) — the opaque pane's height EQUALS the
  // viewport (a maxHeight cap alone was the sheared-splash bug) and grow
  // spacers on BOTH sides centre a short surface. LAYERED CLAIM (gate open)
  // — the pane stays fully opaque but bottom-anchors at content height and
  // registers its rect as the elevated surface so the compositor recesses
  // the genuinely-uncovered rows above the divider.
  // The whole window parks while the modal blank-claims; the modal slot
  // itself re-provides false so its own primitives stay live.
  const motionParked = modalUp && modalPeek === 0
  const modalPane = modalUp ? (
    <MotionParkContext.Provider value={false}>
      <Box ref={recessOn ? elevatedRef : undefined} position="absolute" bottom={0} width="100%" height={blankClaims ? terminalRows : undefined} maxHeight={terminalRows - modalPeek} flexDirection="column" overflow="hidden" opaque={true}>
        {blankClaims && <Box flexGrow={1} />}<Box flexShrink={0}><Text color="info">{"▔".repeat(Math.max(1, columns))}</Text></Box>
        <ModalContext.Provider
          value={{
            rows: terminalRows - modalPeek - 1,
            columns,
            scrollRef: modalScrollRef ?? null,
          }}
        >
          {/* The slot is FLUSH — no padding, no margin: a shell spans the
              slot's full width like the prompt and status boxes below it,
              and the ModalContext above advertises exactly that width. The
              layout engine resolves a child's percent width against its
              owner's BORDER box, so a padded wrapper handed every
              width="100%" shell the full terminal width from one column in
              and pushed its right border off-screen. */}
          <Box flexShrink={0} flexDirection="column">{modal}</Box>{blankClaims && <Box flexGrow={1} />}
        </ModalContext.Provider>
      </Box>
    </MotionParkContext.Provider>
  ) : null

  // ONE fixed scaffold at every width: permanent slots that hold empty
  // placeholders when a region is absent, providers always mounted with only
  // their VALUES switching, the centre box always mounted with only its
  // border flipping.
  return (
    <AlternateScreen>
      <PromptOverlayProvider>
        <CockpitActiveContext.Provider value={cockpit}>
          {/* Motion parking: a zero-peek modal pauses every subscriber
              outside the modal; inside it the pause lifts again. */}
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
              {fullscreen && chrome === 'deck-strip' ? <DeckPane /> : null}
              <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
                {/* Lanes rail slot (permanent). */}
                <Box ref={lanesBoxRef} flexDirection="column" overflow="hidden" flexShrink={0} width={cockpit && plan.lanes ? plan.lanesW : 0}>
                  {cockpit && plan.lanes ? (
                    <HelmLanesRail
                      width={plan.lanesW}
                      mergedTelemetry={!plan.telemetry}
                      availRows={lanesRows}
                    />
                  ) : null}
                </Box>
                {/* Centre column (always mounted; only the border flips). */}
                <Box
                  flexDirection="column"
                  flexGrow={1}
                  minWidth={0}
                  overflow="hidden"
                  borderStyle={centerFrame ? 'round' : undefined}
                  borderColor={centerFrame ? t.borderStrong : undefined}
                >
                  {/* Header band, then the berth card, then the transcript —
                      all inside the ONE width-true size override. */}
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
                {/* Telemetry rail slot (permanent). */}
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
      </PromptOverlayProvider>
    </AlternateScreen>
  )
}

export default FullscreenLayout
