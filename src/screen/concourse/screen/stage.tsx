import { Box, Text } from '../../themedRenderer.js'
import { chatPresent } from '../../routes/surfaceRoute.js'
import { gitOfferOwnsTheKeys } from '../boardModalOwner.js'
import { boardSelectionClassOf } from '../controlManifest.js'
import { clampCaret } from '../lineDraft.js'
import { panelWidth } from '../../widgets/geometry.js'
import { MODEL_PICKER_PANEL } from '../../../models/facts/modelPickerGroups.js'
import { GitOfferCard } from '../GitOfferCard.js'
import { RowPickModal } from '../RowPickModal.js'
import { MercuryModelDefaultPicker, MercurySessionModelPicker } from '../../../commands/model/mercuryModel.js'
import { ModalContext } from '../../overlays/modalContext.js'
import { FloatingPopup } from '../../overlays/PopupGutter.js'
import { getOriginalCwd } from '../../../boot/process-state/processState.js'
import { SplitChatPane } from '../SplitChatPane.js'
import { CompactConcourse } from '../CompactConcourse.js'
import { COMPACT_DOOR_NOTE } from '../compactBoard.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { EFFORT_LEVELS } from '../../../models/effort/effort.js'
import { GroundPicker } from '../GroundPicker.js'
import { armSignInPickerReturn, consumeSignInPickerReturn } from './signInPicker.js'
import { TrustAskModal, CapacityAskModal, ConcourseKeyAtlas, gitOfferCardRows } from './modals.js'
import type { Asks, Draft, Faces, Filter, Frame, Geometry, Marks, Panes, ScreenDoors, ScreenProps, Selection } from './state.js'

export function concourseStage({ snapshot, callbacks, reducedStage, answerCapacityAsk, answerTrustAsk, boardSel, capacityAsk, cols, compactNote, compactProfile, compactSteerOrEnter, doorNote, filter, filtering, fullTree, geo, gitOffer, groundPickerOpen, helpOpen, liveComposerFace, liveDraft, liveDraftDesired, mirrorSlot, modelDefaultOpen, pickGround, region, rowPick, selectSession, sessionRows, setGroundPickerOpen, setModelDefaultOpen, setRegion, setRowPick, splitActive, splitGeo, t, termCols, termRows, trustAsk }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'reducedStage'> & Pick<Asks, 'answerCapacityAsk' | 'answerTrustAsk' | 'capacityAsk' | 'pickGround' | 'trustAsk'> & Pick<Selection, 'boardSel'> & Pick<Frame, 'cols' | 'compactProfile' | 'splitActive' | 'splitGeo' | 'termCols' | 'termRows'> & Pick<Faces, 'compactNote' | 'liveComposerFace' | 'mirrorSlot' | 't'> & Pick<ScreenDoors, 'compactSteerOrEnter' | 'fullTree' | 'gitOffer' | 'selectSession'> & Pick<Marks, 'doorNote' | 'modelDefaultOpen' | 'rowPick' | 'setModelDefaultOpen' | 'setRowPick'> & Pick<Filter, 'filter' | 'filtering' | 'sessionRows'> & Pick<Geometry, 'geo' | 'liveDraftDesired'> & Pick<Panes, 'groundPickerOpen' | 'helpOpen' | 'region' | 'setGroundPickerOpen' | 'setRegion'> & Pick<Draft, 'liveDraft'>) {
  const boardTree =
    compactProfile !== null ? (
      <CompactConcourse
        cols={termCols}
        rows={termRows}
        region={region === 'live' ? 'live' : 'list'}
        sessionRows={sessionRows}
        selectedId={boardSel}
        filtering={filtering}
        filterText={filter.text}
        filterCaret={clampCaret(filter.text, filter.caret)}
        reduced={reducedStage}
        liveDraftRows={liveDraftDesired}
        liveDraftHeld={liveDraft.text.trim().length > 0}
        verbsFire={region !== 'live' || liveDraft.text.length === 0}
        note={compactNote}
        composerNote={doorNote ? COMPACT_DOOR_NOTE : null}
        mirrorNode={(rows, width) => mirrorSlot(rows, width, true)}
        {...(reducedStage ? {} : { liveComposerNode: liveComposerFace })}
        wiring={{
          selectSession: id => {
            setRegion('list')
            selectSession(id)
          },
          activateSession: id => {
            const sel = sessionRows.find(r => r.sessionId === id)
            if (sel !== undefined) compactSteerOrEnter(sel)
          },
          focusList: () => setRegion('list'),
          focusLive: () => setRegion('live'),
          ...(reducedStage || callbacks.newSession === undefined ? {} : { newSession: () => callbacks.newSession?.() }),
        }}
      />
    ) : (
      fullTree
    )
  return (
    <>
      {splitGeo !== null ? (
        <Box flexDirection="row" width="100%" height={termRows}>
          <Box flexDirection="column" width={splitGeo.boardCols} flexShrink={0} overflow="hidden">
            {boardTree}
          </Box>
          <Box flexDirection="column" width={1} flexShrink={0}>
            {Array.from({ length: termRows }, (_, i) => (
              <Box key={i} height={1} flexShrink={0}>
                <Text color={region === 'chat' ? t.info : t.borderSubtle}>│</Text>
              </Box>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <SplitChatPane
              rows={termRows}
              width={splitGeo.chatCols}
              wheelBand={[splitGeo.dividerCol + 1, termCols - 1] as [number, number]}
              focused={region === 'chat'}
              snapshot={snapshot}
              onEnterFull={() => callbacks.exitToChat()}
              onNewSession={() => callbacks.newSession?.()}
            />
          </Box>
        </Box>
      ) : (
        boardTree
      )}
      {}
      {helpOpen ? <ConcourseKeyAtlas cols={termCols} rows={termRows} chat={chatPresent()} reducedStage={reducedStage} splitOn={splitActive} selection={boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSel))} /> : null}
      {capacityAsk ? <CapacityAskModal cols={cols} rows={termRows} onAnswer={answerCapacityAsk} /> : null}
      {groundPickerOpen ? (
        <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows: termRows }} width={74} top={Math.floor(termRows / 2) - 9}>
          <GroundPicker
            currentGround={getCwd()}
            bootGround={getOriginalCwd()}
            onPick={dir => pickGround(dir)}
            onClose={() => setGroundPickerOpen(false)}
          />
        </FloatingPopup>
      ) : null}
      {trustAsk !== null ? (
        <TrustAskModal cols={cols} rows={termRows} dir={trustAsk.dir} onAnswer={answerTrustAsk} />
      ) : null}
      {rowPick !== null && rowPick.kind === 'model' ? (
        <FloatingPopup host={{ left: 0, top: Math.max(0, geo.mainBand[0] - 1), columns: cols, rows: Math.min(geo.mainRows + 1, Math.max(0, geo.helpTop - 1) - Math.max(0, geo.mainBand[0] - 1)) }} width={panelWidth(cols, MODEL_PICKER_PANEL)} top={geo.mainBand[0]}>
          {size => <ModalContext.Provider value={{ rows: size.rows, columns: cols, scrollRef: null }}>
            <MercurySessionModelPicker
              currentModel={sessionRows.find(r => r.sessionId === rowPick.sessionId)?.modelId}
              currentEffort={snapshot.peek?.sessionId === rowPick.sessionId ? snapshot.context.effortLabel : undefined}
              onSelect={(id, label) => {
                const target = rowPick
                setRowPick(null)
                callbacks.setSessionModel?.(target.sessionId, id, label)
              }}
              onEffort={effort => callbacks.setSessionEffort?.(rowPick.sessionId, effort)}
              onDone={() => setRowPick(null)}
              onSignIn={family => {
                const target = rowPick
                setRowPick(null)
                armSignInPickerReturn({ kind: 'session', sessionId: target.sessionId, title: target.title })
                if (!callbacks.enterBootSettings('logins', { family, returnToOpener: true })) consumeSignInPickerReturn()
              }}
            />
          </ModalContext.Provider>}
        </FloatingPopup>
      ) : null}
      {rowPick !== null && rowPick.kind === 'effort' ? (
        <RowPickModal
          cols={cols}
          rows={termRows}
          titlePrefix="EFFORT"
          title={rowPick.title}
          legend="↵ sets this session's effort · esc keeps it"
          options={EFFORT_LEVELS.map(l => ({ id: l, label: l }))}
          onPick={id => {
            const target = rowPick
            setRowPick(null)
            callbacks.setSessionEffort?.(target.sessionId, id)
          }}
          onClose={() => setRowPick(null)}
        />
      ) : null}
      {gitOffer !== undefined &&
      gitOfferOwnsTheKeys({
        capacityAsk,
        trustAsk: trustAsk !== null,
        groundPickerOpen,
        rowPick: rowPick !== null,
        modelDefault: modelDefaultOpen,
        gitOffer: true,
        helpOpen,
      }) ? (
        <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows: geo.mainBand[1] + 1 }} width={geo.interior} top={geo.mainBand[1] - gitOfferCardRows(gitOffer.folder, geo.interior, gitOffer.folderHeld === true)}>
          <GitOfferCard
            offer={gitOffer}
            onAnswer={(requestId, allow, obligationId) => callbacks.answerPermission?.(requestId, allow, obligationId)}
          />
        </FloatingPopup>
      ) : null}
      {modelDefaultOpen ? (
        <FloatingPopup host={{ left: 0, top: Math.max(0, geo.mainBand[0] - 1), columns: cols, rows: Math.min(geo.mainRows + 1, Math.max(0, geo.helpTop - 1) - Math.max(0, geo.mainBand[0] - 1)) }} width={panelWidth(cols, MODEL_PICKER_PANEL)} top={geo.mainBand[0]}>
          {size => <ModalContext.Provider value={{ rows: size.rows, columns: cols, scrollRef: null }}>
            <MercuryModelDefaultPicker
              onDone={() => {
                setModelDefaultOpen(false)
                callbacks.retrySnapshot?.()
              }}
              onSignIn={family => {
                setModelDefaultOpen(false)
                armSignInPickerReturn({ kind: 'default' })
                if (!callbacks.enterBootSettings('logins', { family, returnToOpener: true })) consumeSignInPickerReturn()
              }}
            />
          </ModalContext.Provider>}
        </FloatingPopup>
      ) : null}
    </>
  )
}
