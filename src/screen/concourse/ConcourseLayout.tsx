import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { keyHintLabel } from '../widgets/keyHintLabel.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { fitGroupedWindow, paneWindow, scrolledWindow, shedToFit } from '../widgets/geometry.js'
import { sessionDraftQueues, type ConcourseRowV1, type ConcourseSnapshotV1, type ControlNoteState } from './contracts.js'
import { boardSelectionClassOf, browseKeysFor, CONCOURSE_HELP_KEY, helpKeyFiresFor, legendPriorityOf, regionKeysFor, withoutManagerPaneKeys, withSplitViewTruth } from './controlManifest.js'
import { chatPresent, subscribeSurfaceRoute, surfaceRouteVersion } from '../routes/surfaceRoute.js'
import { landingInFlight } from '../../engine/connector/focusedConnector.js'
import { listColumns } from './rowLine.js'
import { useSyncExternalStore } from 'react'
import { useLiveTilesDegraded } from './liveTiles.js'
import { RAIL_MAX_ROWS } from './NeedsYouRail.js'
import { ConcourseStatusRail } from './ConcourseStrips.js'
import { type ConcourseProfile, NEW_SESSION_ROW_ID, type ConcourseRegion, type SwitchboardGeometry, type ConcourseLayoutWiring } from './layout/shared.js'
import { listPaneOf } from './layout/listPane.js'
import { livePaneOf } from './layout/livePane.js'

export { NEW_SESSION_ROW_ID, NEW_SESSION_DOOR_WORDS, newSessionDoorWords, newSessionDoorTail, rowNeedsOperator, type ConcourseRegion, STATE_GLYPH, STATE_WORD, STATE_WORD_RESERVE, stateWordCell } from './layout/shared.js'

export const ROW_PEEK_DESIRED_ROWS = 8

export function newSessionLineShown(facts: { newSession: boolean; sessionRows: number; filterText: string }): boolean {
  return facts.newSession && facts.sessionRows > 0 && facts.filterText.trim().length === 0
}

export const CONCOURSE_TWO_PANE_MIN_COLS = 100
export const MANAGER_MIN_COLS = 43
const MANAGER_SHARE_PCT = 36
export const REDUCED_NOTICE_ROWS = 5
const MANAGER_FLOOR_ROWS = 8
const LIVE_FLOOR_ROWS = 6
const MIRROR_FLOOR_ROWS = 2
const MANAGER_CHROME_ROWS = 6

export function resolveConcourseProfile(cols: number, _rows?: number): ConcourseProfile {
  return cols >= CONCOURSE_TWO_PANE_MIN_COLS ? 'wide' : 'stacked'
}

function liveComposerRowsOf(paneInner: number, ask: number): number {
  let band = Math.max(0, Math.min(3, ask))
  while (band > 1 && paneInner - (3 + band) < MIRROR_FLOOR_ROWS) band -= 1
  return band > 0 && paneInner - (3 + band) >= MIRROR_FLOOR_ROWS ? 3 + band : 0
}

function managerSplitOf(
  managerRows: number,
  needsYouCount: number,
  expandedRows: number,
): { railWindowRows: number; listContentRows: number; peekRows: number } {
  let railWindowRows = needsYouCount > 0 ? Math.min(needsYouCount, RAIL_MAX_ROWS) : 0
  let listSpace = managerRows - MANAGER_CHROME_ROWS - railWindowRows
  while (listSpace < 2 && railWindowRows > 1) {
    railWindowRows -= 1
    listSpace += 1
  }
  listSpace = Math.max(1, listSpace)
  const peekRows = Math.max(0, Math.min(expandedRows, listSpace - 2))
  return { railWindowRows, listContentRows: Math.max(1, listSpace - peekRows), peekRows }
}

export function switchboardGeometry(
  cols: number,
  rows: number,
  needsYouCount: number,
  sessionRowCount: number,
  groupCount: number,
  liveDraftRows: number,
  expandedRows = 0,
  focusedRegion: ConcourseRegion = 'list',
  thirdPaneRows = 0,
): SwitchboardGeometry {
  const profile = resolveConcourseProfile(cols, rows)
  const empty: [number, number] = [0, -1]
  if (cols < 80 || rows < 22) {
    const width = Math.max(0, Math.floor(cols))
    const total = Math.max(0, Math.floor(rows))
    const helpRows = total > 1 ? 1 : 0
    const mainRows = total - helpRows
    const all: [number, number] = mainRows > 0 ? [1, mainRows] : empty
    const span: [number, number] = width > 0 ? [1, width] : empty
    const liveComposerRows = focusedRegion === 'live' && liveDraftRows > 0 ? Math.min(mainRows, Math.max(1, Math.min(3, liveDraftRows))) : 0
    const liveComposerBand: [number, number] = liveComposerRows > 0 ? [mainRows - liveComposerRows + 1, mainRows] : empty
    return {
      constrained: true, profile: 'stacked', interior: width,
      railRows: focusedRegion === 'rail' ? mainRows : 0,
      railWindowRows: focusedRegion === 'rail' ? Math.min(mainRows, needsYouCount) : 0,
      mainBand: all, mainRows, liveComposerRows, liveComposerBand,
      statusTop: total + 1, helpTop: helpRows > 0 ? total : total + 1,
      liveCols: span, rightCols: span,
      listBand: focusedRegion === 'list' || focusedRegion === 'chat' ? all : empty,
      listContentRows: focusedRegion === 'list' || focusedRegion === 'chat' ? mainRows : 0,
      thirdBand: empty,
      mirrorBand: focusedRegion === 'live' && mainRows > liveComposerRows ? [1, mainRows - liveComposerRows] : empty,
      peekRows: 0,
    }
  }
  const interior = cols - 4
  const mainRows = rows - 2
  const mainTop = 1
  const mainEnd = mainTop + mainRows - 1
  const mainBand: [number, number] = [mainTop, mainEnd]
  const statusTop = mainTop + mainRows
  const helpTop = statusTop + 1
  if (profile === 'wide') {
    const managerW = Math.max(MANAGER_MIN_COLS, Math.round((interior * MANAGER_SHARE_PCT) / 100))
    const liveW = interior - managerW - 1
    const liveCols: [number, number] = [3, 2 + liveW]
    const rightCols: [number, number] = [3 + liveW + 1, 2 + interior]
    const managerRows = mainRows - thirdPaneRows
    const split = managerSplitOf(managerRows, needsYouCount, expandedRows)
    const composerRows = liveComposerRowsOf(mainRows - 2, liveDraftRows)
    return {
      profile, interior,
      railRows: 1 + split.railWindowRows, railWindowRows: split.railWindowRows,
      mainBand, mainRows,
      liveComposerRows: composerRows,
      liveComposerBand: composerRows > 0 ? [mainEnd - composerRows, mainEnd - 1] : empty,
      statusTop, helpTop, liveCols, rightCols,
      listBand: [mainTop, mainTop + managerRows - 1],
      mirrorBand: mainBand,
      thirdBand: thirdPaneRows > 0 ? [mainTop + managerRows, mainEnd] : empty,
      listContentRows: split.listContentRows,
      peekRows: split.peekRows,
    }
  }
  const fullCols: [number, number] = [3, 2 + interior]
  const rest = mainRows - thirdPaneRows
  const managerWant = MANAGER_CHROME_ROWS + Math.min(needsYouCount, RAIL_MAX_ROWS) + Math.max(1, sessionRowCount + Math.max(1, groupCount)) + expandedRows
  const managerRows = Math.max(MANAGER_FLOOR_ROWS, Math.min(managerWant, rest - Math.max(LIVE_FLOOR_ROWS, Math.ceil(rest / 2))))
  const liveRows = rest - managerRows
  const liveEnd = mainTop + liveRows - 1
  const split = managerSplitOf(managerRows, needsYouCount, expandedRows)
  const composerRows = liveComposerRowsOf(liveRows - 2, liveDraftRows)
  return {
    profile, interior,
    railRows: 1 + split.railWindowRows, railWindowRows: split.railWindowRows,
    mainBand, mainRows,
    liveComposerRows: composerRows,
    liveComposerBand: composerRows > 0 ? [liveEnd - composerRows, liveEnd - 1] : empty,
    statusTop, helpTop, liveCols: fullCols, rightCols: fullCols,
    listBand: [liveEnd + 1, liveEnd + managerRows],
    mirrorBand: [mainTop, liveEnd],
    thirdBand: thirdPaneRows > 0 ? [liveEnd + managerRows + 1, mainEnd] : empty,
    listContentRows: split.listContentRows,
    peekRows: split.peekRows,
  }
}

function boardHelpLegend({
  region,
  olderRows,
  sessionRows,
  boardSelectedId,
  liveDraftEmpty,
  armedSelected,
  closeChordStaged,
  rowPeekOpen,
  browseKeys,
  newSession,
  door,
  chat,
  splitOn,
  tilesDegraded,
  interior,
}: {
  region: ConcourseRegion
  olderRows: number
  sessionRows: ConcourseRowV1[]
  boardSelectedId: string | null
  liveDraftEmpty: boolean
  armedSelected: boolean
  closeChordStaged: boolean
  rowPeekOpen: boolean
  browseKeys: ReadonlyArray<{ keys: string; label: string }>
  newSession: boolean
  door: boolean
  chat: boolean
  splitOn: boolean
  tilesDegraded: boolean
  interior: number
}): string {
  const prio = (keys: string): number => legendPriorityOf(keys, { splitOn })
  const olderBrowse = olderRows > 0
  const selectedRow = sessionRows.find(r => r.sessionId === boardSelectedId)
  const selectionClass = boardSelectionClassOf(selectedRow)
  const composerEnter =
    region === 'live' && !olderBrowse
      ? !liveDraftEmpty
        ? [{ keys: '↵', label: sessionDraftQueues(selectedRow) ? 'queue' : 'send' }]
        : armedSelected
          ? [
              { keys: '↵', label: 'enters (armed)' },
              { keys: '→', label: 'enter' },
            ]
          : [
              selectionClass === 'parked'
                ? { keys: '↵', label: 'brings it back' }
                : selectionClass === 'door'
                  ? { keys: '↵', label: 'open' }
                  : { keys: '↵↵', label: 'enter session' },
              { keys: '→', label: rowPeekOpen ? 'close peek' : 'peek' },
            ]
      : []
  const regionParts = [
    ...browseKeys.filter(k => k.keys !== 'esc'),
    ...composerEnter,
    ...withSplitViewTruth(
      regionKeysFor(region, {
        newSession,
        olderBrowse,
        ...(region === 'list'
          ? { selection: selectionClass, armed: armedSelected, liveDraftHeld: !liveDraftEmpty, chordStaged: closeChordStaged, modelDefault: door }
          : {}),
        ...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),
      }),
      { splitOn },
    ),
  ]
  const paneTwinsDropped = region === 'list' && !olderBrowse
  const restingList =
    paneTwinsDropped &&
    !armedSelected &&
    !closeChordStaged &&
    !splitOn &&
    (selectionClass === 'live' || selectionClass === 'paused' || selectionClass === 'attached')
  const browseKeySet = new Set(browseKeys.map(k => k.keys))
  const parts = (restingList
    ? [
        browseKeys.find(k => k.keys === 'tab')!,
        { keys: '/', label: 'filter' },
        ...(helpKeyFiresFor(region, liveDraftEmpty) ? [CONCOURSE_HELP_KEY] : []),
        browseKeys.find(k => k.keys === 'esc')!,
      ]
    : [
        ...(paneTwinsDropped ? withoutManagerPaneKeys(regionParts) : regionParts),
        ...(helpKeyFiresFor(region, liveDraftEmpty) ? [CONCOURSE_HELP_KEY] : []),
        browseKeys.find(k => k.keys === 'esc')!,
      ])
    .map(k =>
      olderBrowse && k.keys === '↑↓'
        ? { keys: k.keys, label: 'choose' }
        : olderBrowse && k.keys === 'esc'
          ? { keys: k.keys, label: 'fold the list' }
          : armedSelected && k.keys === 'esc'
            ? { keys: k.keys, label: 'disarm' }
            : k,
    )
    .map(k => ({
      text: `${keyHintLabel(k.keys)} ${k.label}`,
      priority: paneTwinsDropped && !browseKeySet.has(k.keys) && prio(k.keys) <= 3 ? 0.9 : prio(k.keys),
    }))
  if (tilesDegraded)
    parts.unshift({ text: '· tiles show summaries — the machine is busy', priority: 5 })
  return shedToFit(parts, interior, ' · ')
    .map(p => p.text)
    .join(' · ')
}
export function ConcourseLayout({
  snapshot,
  boardGroups,
  filtering,
  filterText,
  filterCaret,
  region,
  boardSelectedId,
  railIndex,
  boardScrollStart,
  degraded = false,
  liveDraftRows,
  liveDraftEmpty = true,
  thirdPaneRows = 0,
  groundPickerOpen = false,
  rowPeekOpen = false,
  rowPeekNode,
  rowChipRows = 0,
  olderRows = 0,
  armedSelected = false,
  closeChordStaged = false,
  markedIds,
  thirdPaneNode,
  mirrorNode,
  liveComposerNode,
  wiring,
  newSessionNote,
  frameCols,
  splitOn = false,
}: {
  snapshot: ConcourseSnapshotV1
  boardGroups: ConcourseSnapshotV1['groups']
  filtering: boolean
  filterText: string
  filterCaret: number
  region: ConcourseRegion
  boardSelectedId: string | null
  railIndex: number
  boardScrollStart?: number | undefined
  degraded?: boolean
  liveDraftRows: number
  liveDraftEmpty?: boolean
  thirdPaneRows?: number
  groundPickerOpen?: boolean
  rowPeekOpen?: boolean
  rowPeekNode?: (rows: number, width: number) => React.ReactNode
  rowChipRows?: number
  olderRows?: number
  armedSelected?: boolean
  closeChordStaged?: boolean
  markedIds?: ReadonlySet<string>
  thirdPaneNode: (rows: number, width: number) => React.ReactNode
  mirrorNode: (rows: number, width: number) => React.ReactNode
  liveComposerNode?: (bandRows: number, width: number) => React.ReactNode
  wiring: ConcourseLayoutWiring
  newSessionNote?: ControlNoteState
  frameCols?: number
  splitOn?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const cols = frameCols ?? termCols
  const sessionRows: ConcourseRowV1[] = boardGroups.flatMap(g => g.rows)
  const lineShown = newSessionLineShown({ newSession: wiring.newSession !== undefined, sessionRows: sessionRows.length, filterText })
  const lineSelected = lineShown && boardSelectedId === NEW_SESSION_ROW_ID
  const door = region === 'list' && wiring.newSession !== undefined && filterText.trim().length === 0 ? snapshot.newSession.door : undefined
  const geo = switchboardGeometry(
    cols,
    termRows,
    snapshot.needsYou.length,
    sessionRows.length + (lineShown ? 1 : 0),
    boardGroups.filter(g => g.rows.length > 0).length,
    liveDraftRows,
    rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : rowChipRows,
    region,
    thirdPaneRows,
  )
  const tilesDegraded = useLiveTilesDegraded()
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const chat = chatPresent()
  const browseKeys = browseKeysFor({ chatPresent: chat, region })


  const interior = geo.interior
  const wide = geo.profile === 'wide'
  const liveWidth = wide ? geo.liveCols[1] - geo.liveCols[0] + 1 : interior
  const rightWidth = wide ? geo.rightCols[1] - geo.rightCols[0] + 1 : interior
  const listRows = geo.listBand[1] - geo.listBand[0] + 1
  const mirrorRows = geo.mirrorBand[1] - geo.mirrorBand[0] + 1
  const thirdRows = geo.thirdBand[1] - geo.thirdBand[0] + 1
  const listInner = geo.constrained ? interior : rightWidth - 4
  const managerFocused = region === 'list' || region === 'rail'

  const selectedIdx = Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelectedId))
  const askBySession = new Map<string, string>()
  for (const o of snapshot.needsYou) {
    if (!askBySession.has(o.sessionId)) askBySession.set(o.sessionId, o.question)
  }
  const groupOfRow = new Map<string, string>()
  for (const g of boardGroups) for (const r of g.rows) groupOfRow.set(r.sessionId, g.id)
  const windowFor = (span: number): ReturnType<typeof paneWindow> =>
    boardScrollStart !== undefined
      ? scrolledWindow(sessionRows.length, boardScrollStart, Math.max(0, span))
      : paneWindow(sessionRows.length, selectedIdx, Math.max(0, span))
  const contentRows = Math.max(1, geo.listContentRows - (lineShown ? 1 : 0))
  let win = fitGroupedWindow(
    sessionRows.length,
    contentRows,
    windowFor,
    i => groupOfRow.get(sessionRows[i]!.sessionId) ?? '',
  )
  let showHeadings = true
  {
    const groupsInWin = new Set<string>()
    for (let i = win.start; i < win.end; i++) groupsInWin.add(groupOfRow.get(sessionRows[i]!.sessionId) ?? '')
    const moreRow = win.above > 0 || win.below > 0 ? 1 : 0
    const groupedRows = win.end - win.start
    const overflow = groupedRows + groupsInWin.size + moreRow > contentRows
    const headinglessSpan =
      sessionRows.length <= contentRows
        ? sessionRows.length
        : Math.max(1, contentRows - 1)
    if (overflow || (groupedRows < 2 && sessionRows.length > 1 && headinglessSpan > groupedRows)) {
      showHeadings = false
      win = windowFor(headinglessSpan)
    }
  }

  const { colProject, colAge, nowWidth } = listColumns(listInner)
  const stateCellShown = listInner >= 48

  const groupRole = (id: string): string =>
    id === 'needs-you' || id === 'stalled'
      ? t.warning
      : id === 'ready-to-review'
        ? t.success
        : id === 'working' || id === 'elsewhere'
          ? t.info
          : id === 'attached'
            ? t.infoText
            : t.textMuted

  const listPane = listPaneOf({ wide, rightWidth, listRows, geo, managerFocused, t, filtering, filterText, filterCaret, interior, sessionRows, win, boardSelectedId, region, wiring, newSessionNote, colProject, colAge, nowWidth, door, lineShown, lineSelected, boardGroups, showHeadings, groupRole, askBySession, stateCellShown, markedIds, rowPeekNode, snapshot, railIndex, listInner })

  const livePane = livePaneOf({ wide, geo, t, interior, region, mirrorRows, mirrorNode, liveComposerNode, liveWidth })

  const thirdPane =
    thirdPaneRows > 0 && thirdRows > 0 ? (
      <Box
        flexDirection="column"
        width={wide ? rightWidth : undefined}
        height={thirdRows}
        overflow="hidden"
        flexShrink={0}
      >
        {thirdPaneNode(thirdRows, wide ? rightWidth : interior)}
      </Box>
    ) : null

  const edgeRail = (
    <Box width={geo.constrained ? 0 : 2} flexShrink={0} flexDirection="column">
      {Array.from({ length: termRows }, (_, i) => (
        <Box key={i} height={1} flexShrink={0} />
      ))}
    </Box>
  )

  return (
    <Box flexDirection="row" width="100%" height={termRows}>
      {edgeRail}
      <Box flexDirection="column" flexGrow={1} height={termRows}>
        {geo.constrained ? (
          <Box flexGrow={1} flexDirection="column">
            <Box flexDirection="column" flexShrink={0} height={geo.railRows} overflow="hidden">
              {region === 'rail' ? <Text color={t.warning} wrap="truncate-end">{snapshot.needsYou[railIndex]?.question ?? 'nothing needs you'}</Text> : null}
            </Box>
            {listPane}
            {livePane}
            {thirdPane}
          </Box>
        ) : wide ? (
          <Box flexGrow={1} flexDirection="row">
            {livePane}
            <Box width={1} flexShrink={0} flexDirection="column">
              {Array.from({ length: geo.mainRows }, (_, i) => (
                <Box key={i} height={1} flexShrink={0} />
              ))}
            </Box>
            <Box flexDirection="column" flexShrink={0} width={rightWidth}>
              {listPane}
              {thirdPane}
            </Box>
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column">
            {livePane}
            {listPane}
            {thirdPane}
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0} height={geo.constrained ? 0 : 1} overflow="hidden">
          <ConcourseStatusRail
            snapshot={snapshot}
            width={interior}
            groundPickerOpen={groundPickerOpen}
            {...(wiring.openGroundPicker !== undefined ? { onOpenGround: wiring.openGroundPicker } : {})}
          />
        </Box>
        <Box height={geo.helpTop <= termRows ? 1 : 0} flexShrink={0} overflow="hidden">
          {degraded ? (
            <InteractiveRow id="concourse:help:retry-refresh" directActivate hoverStyle="chrome-ink" {...(wiring.retrySnapshot ? { onActivate: () => wiring.retrySnapshot?.() } : {})}>
              {hover => (
                <Text color={t.warning} bold={hover} wrap="truncate-end">
                  {keyHintLabel('live updates stalled — showing the last good view · ⌃r retry')}
                </Text>
              )}
            </InteractiveRow>
          ) : (
            <Text color={t.textInstruction} wrap="truncate-end">
              {filtering
                ? 'type to filter · ↵ apply · esc clear'
                : boardHelpLegend({
                    region,
                    olderRows,
                    sessionRows,
                    boardSelectedId,
                    liveDraftEmpty,
                    armedSelected,
                    closeChordStaged,
                    rowPeekOpen,
                    browseKeys,
                    newSession: wiring.newSession !== undefined,
                    door: door !== undefined,
                    chat,
                    splitOn,
                    tilesDegraded,
                    interior,
                  })}
            </Text>
          )}
        </Box>
      </Box>
      {edgeRail}
    </Box>
  )
}
