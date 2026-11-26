import React from 'react'
import { Box, Text, paletteCollapsed } from '../../themedRenderer.js'
import { GLYPH, padStartTo, branchChip } from '../../theme/glyphs.js'
import { keyHintLabel } from '../../widgets/keyHintLabel.js'
import { truncateToWidth } from '../../../platform/text/truncate.js'
import { caretLens } from '../lineDraft.js'
import { InteractiveRow } from '../../widgets/InteractiveRow.js'
import { WorkingGlyph } from '../../widgets/LiveGlyphs.js'
import { type fitGroupedWindow, shedToFit } from '../../widgets/geometry.js'
import { controlNoteOf, type ConcourseRowV1, type ConcourseSnapshotV1, type ControlNoteState } from '../contracts.js'
import { boardSelectionClassOf, managerPaneKeysFor, newSessionTabLabel } from '../controlManifest.js'
import { LiveNowCell } from '../LiveNowCell.js'
import { NeedsYouRail } from '../NeedsYouRail.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import { NEW_SESSION_ROW_ID, newSessionDoorWords, newSessionDoorTail, rowNeedsOperator, MORE_BEYOND_ROW, type ConcourseRegion, type SwitchboardGeometry, STATE_GLYPH, STATE_WORD, stateWordCell, type ConcourseLayoutWiring } from './shared.js'

function sectionNoticeNodes(notices: readonly string[] | undefined, t: MercuryThemeTokens): React.ReactNode[] {
  if (!notices || notices.length === 0) return []
  return notices.map((notice, i) => (
    <Box key={`notice:${i}`} flexShrink={0} paddingX={1}>
      <Text color={t.warning} wrap="wrap">
        {notice}
      </Text>
    </Box>
  ))
}

function boardRowsOf({
  rightWidth,
  geo,
  t,
  filtering,
  filterText,
  interior,
  sessionRows,
  win,
  boardSelectedId,
  region,
  wiring,
  colProject,
  colAge,
  nowWidth,
  door,
  lineShown,
  lineSelected,
  boardGroups,
  showHeadings,
  groupRole,
  askBySession,
  stateCellShown,
  markedIds,
  rowPeekNode,
  sectionNotices,
}: {
  rightWidth: number
  geo: SwitchboardGeometry
  t: MercuryThemeTokens
  filtering: boolean
  filterText: string
  interior: number
  sessionRows: ConcourseRowV1[]
  win: ReturnType<typeof fitGroupedWindow>
  boardSelectedId: string | null
  region: ConcourseRegion
  wiring: ConcourseLayoutWiring
  colProject: number
  colAge: number
  nowWidth: number
  door: ConcourseSnapshotV1['newSession']['door'] | undefined
  lineShown: boolean
  lineSelected: boolean
  boardGroups: ConcourseSnapshotV1['groups']
  showHeadings: boolean
  groupRole: (id: string) => string
  askBySession: Map<string, string>
  stateCellShown: boolean
  markedIds: ReadonlySet<string> | undefined
  rowPeekNode: ((rows: number, width: number) => React.ReactNode) | undefined
  sectionNotices: readonly string[] | undefined
}): React.ReactNode {
  const columnHeaderRow = (
    <Box key="columns" paddingX={1} flexShrink={0} height={1}>
      <Box flexGrow={1}>
        <Text color={t.textInstruction}>status & title</Text>
      </Box>
      <Box width={colProject} flexShrink={0} paddingRight={1}>
        <Text color={t.textInstruction}>project</Text>
      </Box>
      {nowWidth > 0 ? (
        <Box width={nowWidth} flexShrink={0} paddingRight={1}>
          <Text color={t.textInstruction}>now</Text>
        </Box>
      ) : null}
      <Box width={colAge} justifyContent="flex-end" flexShrink={0}>
        <Text color={t.textInstruction}>last used</Text>
      </Box>
    </Box>
  )
  if (sessionRows.length === 0 && filterText.trim().length === 0) {
    const emptyWrap = geo.listContentRows > 2 ? 'wrap' : 'truncate-end'
    return (
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        <Box flexShrink={0} height={1} />
        <Box flexShrink={0} paddingX={1}>
          <Text wrap={emptyWrap}>
            <Text color={t.textSecondary} bold>
              no sessions yet
            </Text>
            <Text color={t.textMuted}> — this board fills as you start them</Text>
          </Text>
        </Box>
        {wiring.newSession !== undefined ? (
          <Box flexShrink={0} paddingX={1}>
            <InteractiveRow id="concourse:board:empty-new" directActivate hoverStyle="row-fill" flexGrow={1} onActivate={() => wiring.newSession?.()}>
              {hover => (
                <Text wrap={emptyWrap}>
                  <Text color={hover ? t.textPrimary : t.info}>{'▸ '}</Text>
                  <Text color={hover ? t.textPrimary : t.info}>{newSessionDoorWords({ region, filtering })}</Text>
                  {door !== undefined ? (
                    <Text color={hover ? t.textPrimary : t.info}>{newSessionDoorTail(door)}</Text>
                  ) : null}
                </Text>
              )}
            </InteractiveRow>
          </Box>
        ) : null}
        {sectionNoticeNodes(sectionNotices, t)}
      </Box>
    )
  }
  if (sessionRows.length === 0) {
    return (
      <>
        {columnHeaderRow}
        <Box flexShrink={0} paddingX={1}>
          {}
          <Text color={t.textSecondary}>no sessions match "{truncateToWidth(filterText, Math.max(8, interior - 24))}"</Text>
        </Box>
        <Box flexShrink={0} paddingX={1}>
          <Text color={t.textMuted}>esc clears the filter</Text>
        </Box>
        {sectionNoticeNodes(sectionNotices, t)}
      </>
    )
  }
  const visible = new Set(sessionRows.slice(win.start, win.end).map(r => r.sessionId))
  const out: React.ReactNode[] = [columnHeaderRow]
  if (lineShown) {
    out.push(
      <Box key={NEW_SESSION_ROW_ID} flexShrink={0} paddingX={1}>
        <InteractiveRow
          id="concourse:board:empty-new"
          selected={lineSelected}
          focused={region === 'list'}
          onSelect={() => wiring.selectSession(NEW_SESSION_ROW_ID)}
          onActivate={() => wiring.newSession?.()}
          flexGrow={1}
        >
          <Box flexGrow={1} overflow="hidden">
            <Text wrap="truncate-end">
              {lineSelected ? <Text color={region === 'list' ? t.info : t.textPrimary}>{'▸ '}</Text> : <Text>{'  '}</Text>}
              <Text color={t.info}>{newSessionDoorWords({ region, filtering })}</Text>
              {door !== undefined ? <Text color={t.info}>{newSessionDoorTail(door)}</Text> : null}
            </Text>
          </Box>
        </InteractiveRow>
      </Box>,
    )
  }
  for (const g of boardGroups) {
    const inWindow = g.rows.filter(r => visible.has(r.sessionId))
    if (inWindow.length === 0) continue
    if (showHeadings)
      out.push(
        <Box key={`h:${g.id}`} flexShrink={0} paddingX={1}>
          <Text>
            <Text color={groupRole(g.id)} bold>
              {g.label}
            </Text>
            <Text color={groupRole(g.id)}> · {g.rows.length}</Text>
          </Text>
        </Box>,
      )
    for (const r of inWindow) {
      const isSel = r.sessionId === boardSelectedId
      const base = STATE_GLYPH[r.state] ?? { glyph: GLYPH.read, color: 'textMuted' as const }
      const sg = r.state === 'working' && isSel ? { glyph: GLYPH.ok, color: 'info' as const } : r.finishedUnseen === true ? { glyph: base.glyph, color: 'warning' as const } : base
      const ageBlock = padStartTo(r.state === 'queued' ? 'waits' : (r.ageLabel ?? '—'), 5)
      const ask = askBySession.get(r.sessionId)
      const operatorCell = nowWidth === 0 && rowNeedsOperator(r, ask)
      out.push(
        <Box key={r.sessionId} flexShrink={0} paddingX={1}>
          <InteractiveRow
            id={`concourse:board:row:${r.sessionId}`}
            selected={isSel}
            focused={region === 'list'}
            onSelect={() => wiring.selectSession(r.sessionId)}
            onActivate={() => wiring.enterSession(r.sessionId)}
            flexGrow={1}
          >
            <Box flexGrow={1} overflow="hidden" paddingRight={1}>
              <Text wrap="truncate-end">
                {isSel ? <Text color={region === 'list' ? t.info : t.textPrimary}>{'▸ '}</Text> : <Text>{'  '}</Text>}
                {markedIds?.has(r.sessionId) === true ? (
                  <Text color={t.info}>{GLYPH.check} </Text>
                ) : null}
                {r.state === 'working' ? (
                  <WorkingGlyph color={t.info} active />
                ) : (
                  <Text color={t[sg.color]}>{sg.glyph}</Text>
                )}
                {}
                {stateCellShown ? (
                  <Text color={t[sg.color]}>
                    {stateWordCell(
                      isSel && !r.sessionId.startsWith('older:')
                        ? (STATE_WORD[r.state] ?? r.state)
                        : null,
                    )}
                  </Text>
                ) : null}
                <Text> </Text>
                {r.foreignProject !== undefined ? (
                  <Text color={t.info}>{GLYPH.sparkBright} </Text>
                ) : null}
                <Text color={t.textPrimary} bold={isSel}>
                  {r.title}
                </Text>
                {r.foreignProject !== undefined ? (
                  <Text color={t.textMuted}> from {r.foreignProject}</Text>
                ) : null}
              </Text>
            </Box>
            {operatorCell ? (
              <Box width={colProject + colAge} flexShrink={0}>
                <LiveNowCell row={r} ask={ask} brief />
              </Box>
            ) : (
              <>
                <Box width={colProject} flexShrink={0} paddingRight={1}>
                  {}
                  <Text wrap="truncate-end">
                    {r.worktreeBranch !== undefined ? <Text color={t.info}>{branchChip('')}</Text> : null}
                    <Text color={t.textSecondary}>{r.projectLabel}</Text>
                  </Text>
                </Box>
                {nowWidth > 0 ? (
                  <Box width={nowWidth} flexShrink={0} paddingRight={1}>
                    {}
                    <LiveNowCell row={r} ask={ask} />
                  </Box>
                ) : null}
                <Box width={colAge} justifyContent="flex-end" flexShrink={0}>
                  <Text color={t.textInstruction}>{ageBlock}</Text>
                </Box>
              </>
            )}
          </InteractiveRow>
        </Box>,
      )
      if (isSel && geo.peekRows > 0 && rowPeekNode !== undefined) {
        const paneW = rightWidth
        out.push(
          <Box
            key={`peek:${r.sessionId}`}
            flexShrink={0}
            height={geo.peekRows}
            paddingLeft={3}
            paddingRight={1}
            overflow="hidden"
          >
            {rowPeekNode(geo.peekRows, Math.max(16, paneW - 7))}
          </Box>,
        )
      }
    }
  }
  if (win.above > 0 || win.below > 0) {
    out.push(
      <Box key="win" flexShrink={0} paddingX={1}>
        <Text color={t.textMuted}>{MORE_BEYOND_ROW}</Text>
      </Box>,
    )
  }
  out.push(...sectionNoticeNodes(sectionNotices, t))
  return out
}

export function listPaneOf({
  wide,
  rightWidth,
  listRows,
  geo,
  managerFocused,
  t,
  filtering,
  filterText,
  filterCaret,
  interior,
  sessionRows,
  win,
  boardSelectedId,
  region,
  wiring,
  newSessionNote,
  colProject,
  colAge,
  nowWidth,
  door,
  lineShown,
  lineSelected,
  boardGroups,
  showHeadings,
  groupRole,
  askBySession,
  stateCellShown,
  markedIds,
  rowPeekNode,
  snapshot,
  railIndex,
  listInner,
}: {
  wide: boolean
  rightWidth: number
  listRows: number
  geo: SwitchboardGeometry
  managerFocused: boolean
  t: MercuryThemeTokens
  filtering: boolean
  filterText: string
  filterCaret: number
  interior: number
  sessionRows: ConcourseRowV1[]
  win: ReturnType<typeof fitGroupedWindow>
  boardSelectedId: string | null
  region: ConcourseRegion
  wiring: ConcourseLayoutWiring
  newSessionNote: ControlNoteState | undefined
  colProject: number
  colAge: number
  nowWidth: number
  door: ConcourseSnapshotV1['newSession']['door'] | undefined
  lineShown: boolean
  lineSelected: boolean
  boardGroups: ConcourseSnapshotV1['groups']
  showHeadings: boolean
  groupRole: (id: string) => string
  askBySession: Map<string, string>
  stateCellShown: boolean
  markedIds: ReadonlySet<string> | undefined
  rowPeekNode: ((rows: number, width: number) => React.ReactNode) | undefined
  snapshot: ConcourseSnapshotV1
  railIndex: number
  listInner: number
}): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      width={wide ? rightWidth : undefined}
      height={listRows}
      overflow="hidden"
      borderStyle={geo.constrained ? undefined : paletteCollapsed() && managerFocused ? 'bold' : 'round'}
      borderColor={managerFocused ? t.info : t.borderSubtle}
      flexShrink={0}
    >
      {geo.constrained ? (
        <Box flexDirection="column">
          {filtering ? <Text wrap="truncate-end">{(() => { const lens = caretLens({ text: filterText, caret: filterCaret }, interior); return `${lens.before}${lens.at || ' '}${lens.after}` })()}</Text> : null}
          {sessionRows.length === 0 ? <Text wrap="truncate-end">no sessions · n starts one</Text> : sessionRows.slice(win.start, win.end).map(r => (
            <Box key={r.sessionId} height={1}>
              <InteractiveRow
                id={`concourse:board:row:${r.sessionId}`}
                selected={r.sessionId === boardSelectedId}
                focused={region === 'list'}
                onSelect={() => wiring.selectSession(r.sessionId)}
                onActivate={() => wiring.enterSession(r.sessionId)}
                flexGrow={1}
              >
                <Text bold={r.sessionId === boardSelectedId} color={r.sessionId === boardSelectedId ? t.info : t.textSecondary} wrap="truncate-end">{r.title}</Text>
              </InteractiveRow>
            </Box>
          ))}
          {sectionNoticeNodes(snapshot.sectionNotices, t)}
        </Box>
      ) : <>
      <Box flexShrink={0} paddingX={1} flexDirection="row" overflow="hidden">
        {}
        <Box flexShrink={0} overflow="hidden">
          <InteractiveRow id="concourse:board:focus" directActivate hoverStyle="chrome-ink" onActivate={() => wiring.focusList?.()}>
            {hover => (
              <Text color={region === 'list' || hover ? t.infoText : t.textMuted} bold>
                sessions
              </Text>
            )}
          </InteractiveRow>
        </Box>
        <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          {filtering ? (
            (() => {
              const lens = caretLens({ text: filterText, caret: filterCaret }, 40)
              return (
                <Text>
                  <Text color={t.textMuted}> · / </Text>
                  {lens.clippedLeft ? <Text color={t.textMuted}>…</Text> : null}
                  <Text color={t.textPrimary}>{lens.before}</Text>
                  {lens.at === '' ? (
                    <Text color={t.info}>{GLYPH.caretBlock}</Text>
                  ) : (
                    <Text color={t.textPrimary} inverse>
                      {lens.at}
                    </Text>
                  )}
                  <Text color={t.textPrimary}>{lens.after}</Text>
                  {lens.clippedRight ? <Text color={t.textMuted}>…</Text> : null}
                </Text>
              )
            })()
          ) : filterText.trim().length > 0 ? (
            <Text color={t.textMuted}> · filter: {filterText}</Text>
          ) : null}
        </Text>
        </Box>
        {wiring.newSession !== undefined ? (
          <>
            <Box flexGrow={1} />
            <Box flexShrink={0} marginLeft={1} overflow="hidden">
              <InteractiveRow id="concourse:board:new-session" directActivate hoverStyle="chrome-ink" onActivate={() => wiring.newSession?.()}>
                {hover => {
                  const n = newSessionNote !== undefined ? controlNoteOf(newSessionNote) : undefined
                  return n === undefined ? (
                    <Text color={hover ? t.textPrimary : t.info} wrap="truncate-end">
                      {newSessionTabLabel({ region, filtering })}
                    </Text>
                  ) : n.state === 'refused' || n.state === 'failed' ? (
                    <Text color={t.failureText} wrap="truncate-end">
                      {GLYPH.fail} {n.reason ?? 'refused'}
                      {n.next !== undefined ? ` · ${n.next}` : ''}
                    </Text>
                  ) : n.state === 'applied' ? (
                    <Text color={t.success} wrap="truncate-end">
                      {GLYPH.ok} {n.reason ?? 'entering'}
                    </Text>
                  ) : (
                    <Text color={t.textInstruction} wrap="truncate-end">
                      {n.reason ?? 'starting…'}
                    </Text>
                  )
                }}
              </InteractiveRow>
            </Box>
          </>
        ) : null}
      </Box>
      {boardRowsOf({ rightWidth, geo, t, filtering, filterText, interior, sessionRows, win, boardSelectedId, region, wiring, colProject, colAge, nowWidth, door, lineShown, lineSelected, boardGroups, showHeadings, groupRole, askBySession, stateCellShown, markedIds, rowPeekNode, sectionNotices: snapshot.sectionNotices })}
      <Box flexGrow={1} />
      <Box flexDirection="column" flexShrink={0} paddingX={1} overflow="hidden">
        <NeedsYouRail
          bare
          snapshot={snapshot}
          focused={region === 'rail'}
          selectedIndex={railIndex}
          width={listInner}
          maxRows={geo.railWindowRows}
          onSelectRow={i => wiring.selectObligation(i)}
          onAnswer={id => wiring.answerObligation(id)}
          onOpen={id => wiring.openObligation(id)}
          {...(wiring.withdrawObligation !== undefined
            ? { onDismiss: (id: string) => wiring.withdrawObligation?.(id) }
            : {})}
        />
      </Box>
      <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
        <Text color={t.textInstruction} wrap="truncate-end">
          {shedToFit(
            managerPaneKeysFor({
              newSession: wiring.newSession !== undefined,
              paused: boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSelectedId)) === 'paused',
            }).map((k, i) => ({ text: `${keyHintLabel(k.keys)} ${k.label}`, priority: -i })),
            listInner,
            ' · ',
          )
            .map(p => p.text)
            .join(' · ')}
        </Text>
      </Box>
      </>}
    </Box>
  )
}
