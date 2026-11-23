import { Box, Text } from '../../themedRenderer.js'
import { concourseWayBack, plainWorldWhy } from '../../routes/surfaceRoute.js'
import { ROW_LINE_GLYPH_CELLS, rowLineLines } from '../rowLine.js'
import { mayArmBoardModal } from '../boardModalOwner.js'
import { InteractiveRow } from '../../widgets/InteractiveRow.js'
import { concourseWaitCopy } from '../contracts.js'
import { clampCaret } from '../lineDraft.js'
import { ageLabelOf, OLDER_CHATS_ROW_PREFIX } from '../../concourse-model/concourseSnapshot.js'
import { paneWindow } from '../../widgets/geometry.js'
import { SessionMirror } from '../SessionMirror.js'
import { askTileCopy } from '../liveTiles.js'
import { ConcourseLayout } from '../ConcourseLayout.js'
import { CREW_ASK_WAIT_WORDS } from '../../../engine/connector/crewFacts.js'
import type { Draft, Faces, Filter, Frame, Geometry, Marks, Panes, Rail, RowLine, ScreenDoors, ScreenProps, Selection } from './state.js'

export function concourseFullTree({ snapshot, callbacks, degraded, controlNotes, reducedStage, beginAnswer, boardArmed, boardGroups, boardScroll, boardSel, chipRows, closeChordStaged, enterSession, filter, filtering, geo, groundPickerOpen, keyMapHint, liveComposerFace, liveDraft, liveDraftDesired, markedIds, mirrorSlot, modalFactsNow, olderList, olderRows, openObligationOrDoor, peekLive, peekSelRow, railIndex, railSelRef, region, rowLineWidth, rowPeekOpen, selectSession, selectedRowLine, setGroundPickerOpen, setOlderList, setRailSel, setRegion, splitGeo, t, thirdPaneRows }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'degraded' | 'controlNotes' | 'reducedStage'> & Pick<ScreenDoors, 'beginAnswer' | 'enterSession' | 'modalFactsNow' | 'openObligationOrDoor' | 'selectSession'> & Pick<Marks, 'boardArmed' | 'markedIds'> & Pick<Filter, 'boardGroups' | 'filter' | 'filtering'> & Pick<Selection, 'boardScroll' | 'boardSel' | 'olderList' | 'rowPeekOpen' | 'setOlderList'> & Pick<Geometry, 'chipRows' | 'geo' | 'liveDraftDesired' | 'olderRows' | 'rowLineWidth' | 'selectedRowLine' | 'thirdPaneRows'> & Pick<RowLine, 'closeChordStaged' | 'peekLive' | 'peekSelRow'> & Pick<Panes, 'groundPickerOpen' | 'region' | 'setGroundPickerOpen' | 'setRegion'> & Pick<Frame, 'keyMapHint' | 'splitGeo'> & Pick<Faces, 'liveComposerFace' | 'mirrorSlot' | 't'> & Pick<Draft, 'liveDraft'> & Pick<Rail, 'railIndex' | 'railSelRef' | 'setRailSel'>) {
  const fullTree = (
      <ConcourseLayout
        snapshot={snapshot}
        boardGroups={boardGroups}
        rowPeekOpen={rowPeekOpen}
        rowChipRows={chipRows}
        olderRows={olderRows}
        armedSelected={boardArmed !== null}
        closeChordStaged={closeChordStaged}
        markedIds={markedIds}
        rowPeekNode={(rows, width) => {
          const sel = peekSelRow
          if (sel === undefined) return null
          const rowLine =
            selectedRowLine === null ? null : (() => {
              const ink =
                selectedRowLine.tone === 'success' ? t.success
                : selectedRowLine.tone === 'instruction' ? t.textInstruction
                : selectedRowLine.tone === 'warning' ? t.warning
                : selectedRowLine.tone === 'failure' ? t.failureText
                : t.info
              const lines = rowLineLines(selectedRowLine.words, rowLineWidth)
              const whole = rows >= lines.length
              return (
                <Box height={whole ? rows : 1} flexShrink={0} overflow="hidden" flexDirection="row">
                  <Box width={ROW_LINE_GLYPH_CELLS} flexShrink={0}>
                    <Text color={ink}>{selectedRowLine.glyph} </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="column">
                    {(whole ? lines : [selectedRowLine.words]).map((line, at) => (
                      <Text key={at} color={ink} wrap="truncate-end">
                        {line}
                      </Text>
                    ))}
                  </Box>
                </Box>
              )
            })()
          if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) && olderList !== null) {
            const span = Math.max(1, rows - 1)
            const win = paneWindow(olderList.entries.length, olderList.at, span)
            const beyond = olderList.total - olderList.entries.length
            const tailParts = [
              ...(win.above > 0 ? [`↑ ${win.above}`] : []),
              ...(win.below > 0 ? [`↓ ${win.below}`] : []),
              ...(beyond > 0 ? [`+${beyond} more — /sessions lists everything`] : []),
              '↵ brings it back',
              'esc folds',
            ]
            return (
              <Box flexDirection="column" height={rows} overflow="hidden">
                {olderList.entries.slice(win.start, win.end).map((e, wi) => {
                  const at = win.start + wi
                  const isAt = at === olderList.at
                  return (
                    <Box key={e.sessionId} height={1} flexShrink={0} overflow="hidden">
                      <InteractiveRow
                        id={`concourse:older:${e.sessionId}`}
                        selected={isAt}
                        onSelect={() => setOlderList(prev => (prev === null ? prev : { ...prev, at }))}
                        onActivate={() => {
                          if (callbacks.resumeOlderChat === undefined) return
                          setOlderList(null)
                          callbacks.resumeOlderChat(e.sessionId, e.transcriptPath, e.title)
                        }}
                        flexGrow={1}
                      >
                        <Box flexGrow={1} overflow="hidden">
                          <Text wrap="truncate-end">
                            <Text color={isAt ? t.info : t.textMuted}>{isAt ? '▸ ' : '  '}</Text>
                            <Text color={isAt ? t.textPrimary : t.textSecondary} bold={isAt}>
                              {e.title}
                            </Text>
                          </Text>
                        </Box>
                        <Box width={7} justifyContent="flex-end" flexShrink={0}>
                          <Text color={t.textInstruction}>{ageLabelOf(Date.now(), Date.now() - e.ageMs)}</Text>
                        </Box>
                      </InteractiveRow>
                    </Box>
                  )
                })}
                <Box height={1} flexShrink={0} overflow="hidden">
                  <Text color={t.textInstruction} wrap="truncate-end">
                    {tailParts.join(' · ')}
                  </Text>
                </Box>
              </Box>
            )
          }
          if (!rowPeekOpen) return rowLine
          if (sel.sessionId.startsWith('dispatch:') || sel.workspaceDir === undefined) {
            return (
              <Box flexDirection="column" height={rows} overflow="hidden">
                <Text color={t.textMuted} wrap="truncate-end">
                  {sel.state === 'queued'
                    ? `${concourseWaitCopy(sel.waitReason, sel.waitDetail)} — no live view until it starts`
                    : sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)
                      ? 'older chats — ↵ unfolds the list right here'
                    : sel.door !== undefined
                      ? sel.door.kind === 'switch-project'
                        ? `↵ switches the board to ${sel.projectLabel} — its sessions show as live rows there`
                        : '↵ opens the repo picker'
                      : sel.state === 'parked'
                        ? 'parked — ↵ brings it back'
                        : 'no live view for this row yet'}
                </Text>
              </Box>
            )
          }
          const ask = snapshot.needsYou.find(o => o.sessionId === sel.sessionId)?.question
          const chipTake = rowLine !== null && rows > 2 ? 1 : 0
          return (
            <Box flexDirection="column" height={rows} overflow="hidden">
              {chipTake > 0 ? rowLine : null}
              {ask !== undefined ? (
                <Box height={1} flexShrink={0} overflow="hidden">
                  <Text color={t.warning} wrap="truncate-end">
                    {CREW_ASK_WAIT_WORDS} · {askTileCopy(sel.title, ask)}
                  </Text>
                </Box>
              ) : null}
              <SessionMirror
                bare
                sessionId={sel.sessionId}
                workspaceId={sel.workspaceDir}
                title={sel.title}
                paneRows={(ask !== undefined ? rows - 1 : rows) - chipTake}
                paneWidth={width}
                focused={false}
                state={sel.state}
                {...(sel.nowLabel !== undefined ? { nowLabel: sel.nowLabel } : {})}
                {...(sel.nowLive === true ? { nowLive: true } : {})}
                liveTailLine={peekLive.now.kind === 'streaming' ? peekLive.now.line : null}
              />
            </Box>
          )
        }}
        filtering={filtering}
        filterText={filter.text}
        filterCaret={clampCaret(filter.text, filter.caret)}
        region={region}
        boardSelectedId={boardSel}
        railIndex={railIndex}
        boardScrollStart={boardScroll ?? undefined}
        degraded={degraded}
        liveDraftRows={liveDraftDesired}
        liveDraftEmpty={liveDraft.text.length === 0}
        thirdPaneRows={thirdPaneRows}
        groundPickerOpen={groundPickerOpen}
        thirdPaneNode={(rows, width) => (
          <Box flexDirection="column" height={rows} width={width} overflow="hidden" borderStyle={geo.constrained ? undefined : 'round'} borderColor={t.borderSubtle} paddingX={1}>
            <Text color={t.textSecondary} wrap="truncate-end">{`live view — the concourse is off${(() => { const why = plainWorldWhy(); return why !== null && why !== 'concourse off' ? ` (${why})` : '' })()}`}</Text>
            <Text color={t.textMuted} wrap="truncate-end">{`your sessions run and show here · ↵ enters one${keyMapHint.length > 0 ? ` · ${keyMapHint}` : ''}`}</Text>
            <Text color={t.textMuted} wrap="truncate-end">{concourseWayBack()}</Text>
          </Box>
        )}
        mirrorNode={mirrorSlot}
        liveComposerNode={liveComposerFace}
        wiring={{
          selectSession: id => {
            setRegion('list')
            selectSession(id)
          },
          enterSession: id => enterSession(id, { pointer: true }),
          selectObligation: i => {
            setRegion('rail')
            railSelRef.current =
              snapshot.needsYou[Math.max(0, Math.min(snapshot.needsYou.length - 1, i))]?.obligationId ?? null
            setRailSel(railSelRef.current)
          },
          answerObligation: id => beginAnswer(id),
          openObligation: id => openObligationOrDoor(id),
          ...(callbacks.withdrawObligation !== undefined
            ? { withdrawObligation: (id: string) => callbacks.withdrawObligation?.(id) }
            : {}),
          focusList: () => setRegion('list'),
          openGroundPicker: () => {
            if (!mayArmBoardModal(modalFactsNow(), 'ground-picker')) return
            setGroundPickerOpen(v => !v)
          },
          ...(callbacks.retrySnapshot !== undefined ? { retrySnapshot: callbacks.retrySnapshot } : {}),
          ...(reducedStage || callbacks.newSession === undefined ? {} : { newSession: () => callbacks.newSession?.() }),
        }}
        {...(controlNotes?.['board:new-session'] !== undefined ? { newSessionNote: controlNotes['board:new-session'] } : {})}
        {...(splitGeo !== null ? { frameCols: splitGeo.boardCols, splitOn: true } : {})}
      />
  )
  return fullTree
}
