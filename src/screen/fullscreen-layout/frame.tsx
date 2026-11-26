import React from 'react'
import type { MeasuredHost } from '../overlays/PopupHost.js'
import { Box, MotionParkContext, Text, type DOMElement } from '../themedRenderer.js'
import ScrollBox, { type ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { AlternateScreen } from '../renderer/elements/AlternateScreen.js'
import { TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js'
import { CompactFooterNoticeContext, CompactFrameBudgetContext, type useLayoutChrome } from './layoutChromeContext.js'
import type { compactFrameBudget } from '../widgets/geometry.js'
import { CompactIdentityBand } from './CompactIdentityBand.js'
import type { railPlan } from './helmGeometry.js'
import { ModalContext } from '../overlays/modalContext.js'
import { PromptOverlayProvider } from '../overlays/promptOverlay.js'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { estateGroundBg } from '../theme/mercuryTokens.js'
import type { useElevatedSurface } from '../widgets/useElevatedSurface.js'
import { recessTargetFor } from '../cockpit/recessBackdrop.js'
import { DeckPane } from '../deck-pane/DeckPane.js'
import { HelmLanesRail } from './HelmLanesRail.js'
import { HelmVitalsRail } from './HelmVitalsRail.js'
import { FilesMenuSlot } from './FilesMenuSlot.js'
import { ModelPickerPopupSlot } from '../overlays/ModelPickerPopupSlot.js'
import { CommandPopupSlot } from '../overlays/CommandPopupSlot.js'
import type { commandPopupClaim, CommandPopupShape } from '../cockpit/commandPopup.js'
import { SettingsPopupSlot } from '../overlays/SettingsPopupSlot.js'
import { PinnedCritterBerth } from './MercuryHome.js'
import { CR_COLS } from '../cockpit/critterData.js'
import { WorkCapsule } from '../widgets/WorkCapsule.js'
import { CrewViewSlot } from './CrewViewSlot.js'
import { CrewmateCard } from './CrewmateCard.js'
import type { useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { ModalPaneBody, JumpPill, PromptOverlayStrip } from './panes.js'

export function fullscreenFrame({ host, bottom, bottomFloat, centerFrame, centreBoxRef, chrome, cockpit, columns, commandPopup, commandPopupUp, compactBudget, crewDoor, dividerYRef, elevatedRef, fullscreen, hidePill, isCompact, modal, modalMounted, modalScrollRef, modalUp, newMessageCount, onPillClick, overlay, plan, popupUp, rows, scrollRef, scrollable, setCompactFooterNotice, sizeVal, statusBand, statusBandActive, statusBandRef, terminalRows, tokens, transcriptGutter, transcriptSize, viewedCrewmate }: { host: MeasuredHost | null; bottom: React.ReactNode; bottomFloat: React.ReactNode; centerFrame: boolean; centreBoxRef: React.RefObject<DOMElement | null>; chrome: ReturnType<typeof useLayoutChrome>['chrome']; cockpit: boolean; columns: number; commandPopup: ReturnType<typeof commandPopupClaim>; commandPopupUp: boolean; compactBudget: ReturnType<typeof compactFrameBudget> | null; crewDoor: CommandPopupShape | null; dividerYRef: React.MutableRefObject<number | null> | undefined; elevatedRef: ReturnType<typeof useElevatedSurface>; fullscreen: boolean; hidePill: boolean; isCompact: boolean; modal: React.ReactNode; modalMounted: boolean; modalScrollRef: React.RefObject<ScrollBoxHandle | null> | undefined; modalUp: boolean; newMessageCount: number | undefined; onPillClick: (() => void) | undefined; overlay: React.ReactNode; plan: ReturnType<typeof railPlan>; popupUp: boolean; rows: number; scrollRef: React.RefObject<ScrollBoxHandle | null> | undefined; scrollable: React.ReactNode; setCompactFooterNotice: React.Dispatch<React.SetStateAction<number>>; sizeVal: { columns: number; rows: number }; statusBand: React.ReactNode; statusBandActive: boolean; statusBandRef: React.RefObject<DOMElement | null>; terminalRows: number; tokens: ReturnType<typeof useMercuryTokens>; transcriptGutter: number; transcriptSize: { columns: number; rows: number }; viewedCrewmate: ReturnType<typeof useViewedCrewmate> }) {
  const bandFits = !host || host.rows >= host.bandRows
  const railRows = host?.outerRows
  const divider =
    newMessageCount !== undefined && newMessageCount > 0
      ? { firstUnseenUuid: '', count: newMessageCount }
      : undefined

  const modalPeek = isCompact ? 0 : chrome === 'inline' ? 2 : 0
  const modalSeparatorRows = modalUp && (!isCompact || terminalRows > 1) ? 1 : 0
  const t = tokens
  const modalClaims = modalPeek === 0;
  const recessOn = modalUp && recessTargetFor(t) !== null;
  const blankClaims = modalUp && modalClaims && !recessOn;

  const transcriptArea = (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      paddingX={transcriptGutter}
    >
      <ScrollBox
        ref={scrollRef}
        stickyScroll
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingTop={isCompact ? 0 : 1}
      >
        {scrollable}
      </ScrollBox>
      {!hidePill && dividerYRef && scrollRef && (!isCompact || (compactBudget?.transcriptMinRows ?? 0) > 0) ? (
        <JumpPill
          divider={viewedCrewmate === null ? divider : undefined}
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
  const modalPane = popupUp ? (
    <MotionParkContext.Provider value={false}>
      <ModelPickerPopupSlot host={host} scrollRef={modalScrollRef ?? null}>
        {modal}
      </ModelPickerPopupSlot>
    </MotionParkContext.Provider>
  ) : commandPopupUp ? (
    <MotionParkContext.Provider value={false}>
      <CommandPopupSlot host={host} scrollRef={modalScrollRef ?? null} shape={commandPopup!.shape}>
        {modal}
      </CommandPopupSlot>
    </MotionParkContext.Provider>
  ) : crewDoor !== null ? null : modalMounted ? (
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
          <ModalPaneBody rows={Math.max(0, terminalRows - modalPeek - modalSeparatorRows)} columns={columns} scrollRef={modalScrollRef ?? null}>{modal}</ModalPaneBody>{blankClaims && <Box flexGrow={1} />}
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
                <Box flexDirection="column" overflow="hidden" flexShrink={0} width={cockpit && plan.lanes ? plan.lanesW : 0}>
                  {cockpit && plan.lanes ? (
                    <HelmLanesRail
                      width={plan.lanesW}
                      mergedVitals={!plan.vitals}
                      availRows={railRows}
                    />
                  ) : null}
                </Box>
                <Box
                  ref={centreBoxRef}
                  flexDirection="column"
                  flexGrow={1}
                  minWidth={0}
                  overflow="hidden"
                  borderStyle={centerFrame ? 'round' : undefined}
                  borderColor={centerFrame ? t.borderStrong : undefined}
                >
                  <TerminalSizeContext.Provider value={sizeVal}>
                    {isCompact ? <CompactIdentityBand /> : null}
                    {centerFrame && statusBand ? (
                      <Box
                        ref={statusBandRef}
                        display={bandFits ? 'flex' : 'none'}
                        flexDirection="row"
                        flexShrink={0}
                        width={Math.max(0, sizeVal.columns - 2)}
                        marginX={1}
                        borderStyle="round"
                        borderTop={false}
                        borderLeft={false}
                        borderRight={false}
                        borderColor={t.borderStrong}
                        paddingX={1}
                        gap={1}
                      >
                        <Box
                          flexDirection="column"
                          flexShrink={0}
                          width={CR_COLS}
                          justifyContent="center"
                        >
                          <PinnedCritterBerth />
                        </Box>
                        <Box
                          flexDirection="column"
                          flexGrow={1}
                          minWidth={0}
                          justifyContent="center"
                        >
                          {viewedCrewmate !== null ? (
                            <CrewmateCard crewmate={viewedCrewmate} width={sizeVal.columns - 4 - 1 - CR_COLS} />
                          ) : (
                            <WorkCapsule
                              active={!!statusBandActive}
                              width={sizeVal.columns - 4 - 1 - CR_COLS}
                            >
                              {statusBand}
                            </WorkCapsule>
                          )}
                        </Box>
                      </Box>
                    ) : null}
                    <TerminalSizeContext.Provider value={transcriptSize}>
                      {transcriptArea}
                    </TerminalSizeContext.Provider>
                  </TerminalSizeContext.Provider>
                  <FilesMenuSlot host={host} />
                  <MotionParkContext.Provider value={false}>
                    <CrewViewSlot host={host} modal={crewDoor === null ? null : { shape: crewDoor, scrollRef: modalScrollRef ?? null, surfaceRef: recessOn ? elevatedRef : undefined, node: modal }} />
                  </MotionParkContext.Provider>
                </Box>
                <Box flexDirection="column" overflow="hidden" flexShrink={0} width={cockpit && plan.vitals ? plan.vitalsW : 0}>
                  {cockpit && plan.vitals ? (
                    <HelmVitalsRail
                      width={plan.vitalsW}
                      availRows={railRows}
                    />
                  ) : null}
                </Box>
              </Box>
              {bottomBlock}
              {modalPane}
              <SettingsPopupSlot host={host} overlay={true} />
            </Box>
          </MotionParkContext.Provider>
        </CockpitActiveContext.Provider>
        </CompactFrameBudgetContext.Provider>
        </CompactFooterNoticeContext.Provider>
      </PromptOverlayProvider>
    </AlternateScreen>
  )
}
