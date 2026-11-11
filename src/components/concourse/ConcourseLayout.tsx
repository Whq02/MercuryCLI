import React from 'react'
import { Box, Text, paletteCollapsed } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { GLYPH, padStartTo, branchChip } from '../mercury-ui/glyphs.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { caretLens } from './lineDraft.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { fitGroupedWindow, paneWindow, scrolledWindow, shedToFit } from '../mercury-ui/geometry.js'
import { controlNoteOf, type ConcourseRowV1, type ConcourseSnapshotV1, type ControlNoteState } from './contracts.js'
import { boardSelectionClassOf, browseKeysFor, CONCOURSE_HELP_KEY, helpKeyFiresFor, legendPriorityOf, managerPaneKeysFor, newSessionTabLabel, regionKeysFor, withoutManagerPaneKeys, withSplitViewTruth } from './controlManifest.js'
import { effortLevelToSymbol } from '../EffortIndicator.js'
import { EFFORT_HIGH } from '../../constants/figures.js'
import { isEffortLevel } from '../../utils/effort.js'
import { chatPresent, subscribeSurfaceRoute, surfaceRouteVersion } from '../../context/surfaceRoute.js'
import { landingInFlight } from '../../services/engine-connector/focusedConnector.js'
import { PARK_REFUSED_NOW_LEAD } from '../../services/concourse/concourseSnapshot.js'
import { listColumns } from './rowLine.js'
import { useSyncExternalStore } from 'react'
import { LiveNowCell } from './LiveNowCell.js'
import { useLiveTilesDegraded } from './liveTiles.js'
import { NeedsYouRail, RAIL_MAX_ROWS } from './NeedsYouRail.js'
import { ConcourseStatusRail } from './ConcourseStrips.js'


type ConcourseProfile = 'stacked' | 'wide'

export const ROW_PEEK_DESIRED_ROWS = 8

export const NEW_SESSION_ROW_ID = 'new-session'
export const NEW_SESSION_DOOR_WORDS = 'n starts a blank session in this project'

export function newSessionDoorWords(opts: { region: string; filtering: boolean }): string {
  return opts.region === 'list' && !opts.filtering ? NEW_SESSION_DOOR_WORDS : `tab to the list, then ${NEW_SESSION_DOOR_WORDS}`
}

export function newSessionDoorTail(door: { modelLabel: string; effortLevel: string }): string {
  return ` · ${door.modelLabel} · ${isEffortLevel(door.effortLevel) ? effortLevelToSymbol(door.effortLevel) : EFFORT_HIGH} ${door.effortLevel}`
}

export function newSessionLineShown(facts: { newSession: boolean; sessionRows: number; filterText: string }): boolean {
  return facts.newSession && facts.sessionRows > 0 && facts.filterText.trim().length === 0
}

export function rowNeedsOperator(row: { state: string; nowLabel?: string | null }, ask?: string): boolean {
  const now = row.nowLabel ?? ''
  return (ask !== undefined && ask.length > 0) || (row.state === 'needs-you' && now.length > 0) || now.startsWith(PARK_REFUSED_NOW_LEAD)
}

export const CONCOURSE_TWO_PANE_MIN_COLS = 100
export const MANAGER_MIN_COLS = 43
const MANAGER_SHARE_PCT = 36
export const COORDINATOR_REST_ROWS = 4
export const REDUCED_NOTICE_ROWS = 5
const MANAGER_FLOOR_ROWS = 8
const LIVE_FLOOR_ROWS = 6
const MIRROR_FLOOR_ROWS = 2
const MANAGER_CHROME_ROWS = 6
const MORE_BEYOND_ROW = '⋮'

export function resolveConcourseProfile(cols: number, _rows?: number): ConcourseProfile {
  return cols >= CONCOURSE_TWO_PANE_MIN_COLS ? 'wide' : 'stacked'
}

export type ConcourseRegion = 'rail' | 'list' | 'live' | 'coordinator' | 'chat'

interface SwitchboardGeometry {
  constrained?: boolean
  profile: ConcourseProfile
  interior: number
  railRows: number
  railWindowRows: number
  mainBand: [number, number]
  mainRows: number
  liveComposerRows: number
  liveComposerBand: [number, number]
  statusTop: number
  helpTop: number
  liveCols: [number, number]
  coordCols: [number, number]
  rightCols: [number, number]
  listBand: [number, number]
  mirrorBand: [number, number]
  coordBand: [number, number]
  listContentRows: number
  peekRows: number
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
  tallOwner: 'mirror' | 'coordinator',
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
      liveCols: span, coordCols: span, rightCols: span,
      listBand: focusedRegion === 'list' || focusedRegion === 'chat' ? all : empty,
      listContentRows: focusedRegion === 'list' || focusedRegion === 'chat' ? mainRows : 0,
      coordBand: focusedRegion === 'coordinator' && thirdPaneRows > 0 ? all : empty,
      mirrorBand: focusedRegion === 'live' && mainRows > liveComposerRows ? [1, mainRows - liveComposerRows] : empty,
      peekRows: 0,
    }
  }
  const interior = cols - 4
  const mainRows = rows - 4
  const mainTop = 1
  const mainEnd = mainTop + mainRows - 1
  const mainBand: [number, number] = [mainTop, mainEnd]
  const statusTop = mainTop + mainRows
  const helpTop = statusTop + 3
  const coordTall = thirdPaneRows > 0 && tallOwner === 'coordinator'
  if (profile === 'wide') {
    const managerW = Math.max(MANAGER_MIN_COLS, Math.round((interior * MANAGER_SHARE_PCT) / 100))
    const liveW = interior - managerW - 1
    const liveCols: [number, number] = [3, 2 + liveW]
    const rightCols: [number, number] = [3 + liveW + 1, 2 + interior]
    const coordRows = coordTall
      ? Math.max(thirdPaneRows, Math.min(mainRows - MANAGER_FLOOR_ROWS, Math.round(mainRows * 0.6)))
      : thirdPaneRows
    const managerRows = mainRows - coordRows
    const split = managerSplitOf(managerRows, needsYouCount, expandedRows)
    const composerRows = liveComposerRowsOf(mainRows - 2, liveDraftRows)
    return {
      profile, interior,
      railRows: 1 + split.railWindowRows, railWindowRows: split.railWindowRows,
      mainBand, mainRows,
      liveComposerRows: composerRows,
      liveComposerBand: composerRows > 0 ? [mainEnd - composerRows, mainEnd - 1] : empty,
      statusTop, helpTop, liveCols, coordCols: rightCols, rightCols,
      listBand: [mainTop, mainTop + managerRows - 1],
      mirrorBand: mainBand,
      coordBand: coordRows > 0 ? [mainTop + managerRows, mainEnd] : empty,
      listContentRows: split.listContentRows,
      peekRows: split.peekRows,
    }
  }
  const fullCols: [number, number] = [3, 2 + interior]
  const coordRows = coordTall
    ? Math.max(thirdPaneRows, Math.min(Math.floor(mainRows * 0.45), mainRows - MANAGER_FLOOR_ROWS - LIVE_FLOOR_ROWS))
    : thirdPaneRows
  const rest = mainRows - coordRows
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
    statusTop, helpTop, liveCols: fullCols, coordCols: fullCols, rightCols: fullCols,
    listBand: [liveEnd + 1, liveEnd + managerRows],
    mirrorBand: [mainTop, liveEnd],
    coordBand: coordRows > 0 ? [liveEnd + managerRows + 1, mainEnd] : empty,
    listContentRows: split.listContentRows,
    peekRows: split.peekRows,
  }
}

export const STATE_GLYPH: Record<string, { glyph: string; color: 'success' | 'warning' | 'failure' | 'info' | 'textMuted' | 'infoText' }> = {
  'ready-to-review': { glyph: GLYPH.ok, color: 'success' },
  working: { glyph: GLYPH.pending, color: 'info' },
  'needs-you': { glyph: GLYPH.mission, color: 'warning' },
  attached: { glyph: '▣', color: 'infoText' },
  stalled: { glyph: GLYPH.uptri, color: 'warning' },
  failed: { glyph: GLYPH.fail, color: 'failure' },
  queued: { glyph: GLYPH.squareOpen, color: 'textMuted' },
  starting: { glyph: '◐', color: 'textMuted' },
  paused: { glyph: '◌', color: 'textMuted' },
  stopped: { glyph: '◇', color: 'textMuted' },
  completed: { glyph: GLYPH.ok, color: 'textMuted' },
  cancelled: { glyph: GLYPH.circledSlash, color: 'textMuted' },
  draft: { glyph: GLYPH.typing, color: 'textMuted' },
  parked: { glyph: GLYPH.sparkFaint, color: 'textMuted' },
  elsewhere: { glyph: GLYPH.handoff, color: 'info' },
}

export const STATE_WORD: Record<string, string> = {
  'ready-to-review': 'ready',
  working: 'working',
  'needs-you': 'NEEDS YOU',
  attached: 'with you',
  stalled: 'stalled',
  failed: 'failed',
  queued: 'queued',
  starting: 'starting',
  paused: 'paused',
  stopped: 'stopped',
  completed: 'done',
  cancelled: 'cancelled',
  draft: 'draft',
  parked: 'parked',
  elsewhere: 'a door',
}

export const STATE_WORD_RESERVE = Math.max(
  ...Object.values(STATE_WORD).map(word => word.length),
)

export function stateWordCell(word: string | null): string {
  return ` ${(word ?? '').slice(0, STATE_WORD_RESERVE).padEnd(STATE_WORD_RESERVE)}`
}

interface ConcourseLayoutWiring {
  selectSession: (sessionId: string) => void
  enterSession: (sessionId: string) => void
  selectObligation: (index: number) => void
  answerObligation: (obligationId: string) => void
  openObligation: (obligationId: string) => void
  focusComposer: () => void
  focusList?: () => void
  retrySnapshot?: () => void
  withdrawObligation?: (obligationId: string) => void
  openGroundPicker?: () => void
  newSession?: () => void
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
  focusTall,
  liveDraftRows,
  liveDraftEmpty = true,
  coordinatorDraftEmpty = true,
  coordinatorOn = false,
  thirdPaneRows = 0,
  groundPickerOpen = false,
  rowPeekOpen = false,
  rowPeekNode,
  rowChipRows = 0,
  olderRows = 0,
  armedSelected = false,
  closeChordStaged = false,
  markedIds,
  coordinatorNode,
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
  focusTall: 'mirror' | 'coordinator'
  liveDraftRows: number
  liveDraftEmpty?: boolean
  coordinatorDraftEmpty?: boolean
  coordinatorOn?: boolean
  thirdPaneRows?: number
  groundPickerOpen?: boolean
  rowPeekOpen?: boolean
  rowPeekNode?: (rows: number, width: number) => React.ReactNode
  rowChipRows?: number
  olderRows?: number
  armedSelected?: boolean
  closeChordStaged?: boolean
  markedIds?: ReadonlySet<string>
  coordinatorNode: (rows: number, width: number) => React.ReactNode
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
    focusTall,
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
  const coordRows = geo.coordBand[1] - geo.coordBand[0] + 1
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

  const listPane = (
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
        </Box>
      ) : <>
      <Box flexShrink={0} paddingX={1} flexDirection="row" overflow="hidden">
        {}
        <Box flexShrink={0} overflow="hidden">
          <InteractiveRow id="concourse:board:focus" directActivate hoverStyle="chrome-ink" onActivate={() => wiring.focusList?.()}>
            {hover => (
              <Text color={region === 'list' || hover ? t.infoText : t.textMuted} bold>
                SESSIONS
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
      {(() => {
        const columnHeaderRow = (
          <Box key="columns" paddingX={1} flexShrink={0} height={1}>
            <Box flexGrow={1}>
              <Text color={t.textInstruction}>STATUS & TITLE</Text>
            </Box>
            <Box width={colProject} flexShrink={0} paddingRight={1}>
              <Text color={t.textInstruction}>PROJECT</Text>
            </Box>
            {nowWidth > 0 ? (
              <Box width={nowWidth} flexShrink={0} paddingRight={1}>
                <Text color={t.textInstruction}>NOW</Text>
              </Box>
            ) : null}
            <Box width={colAge} justifyContent="flex-end" flexShrink={0}>
              <Text color={t.textInstruction}>LAST USED</Text>
            </Box>
          </Box>
        )
        if (sessionRows.length === 0 && filterText.trim().length === 0) {
          return (
            <>
              <Box flexShrink={0} height={1} />
              <Box flexShrink={0} paddingX={1}>
                <Text wrap="truncate-end">
                  <Text color={t.textSecondary} bold>
                    no sessions yet
                  </Text>
                  <Text color={t.textMuted}> — this board fills as you start them</Text>
                </Text>
              </Box>
              {coordinatorOn ? (
                <Box flexShrink={0} paddingX={1}>
                  <InteractiveRow id="concourse:board:empty-start" directActivate hoverStyle="row-fill" onActivate={() => wiring.focusComposer()}>
                    {hover => (
                      <Text wrap="truncate-end">
                        <Text color={hover ? t.textPrimary : t.info}>{GLYPH.prompt} </Text>
                        <Text color={hover ? t.textPrimary : t.info}>describe a task in the coordinator panel — ↵ starts a session</Text>
                      </Text>
                    )}
                  </InteractiveRow>
                </Box>
              ) : null}
              {wiring.newSession !== undefined ? (
                <Box flexShrink={0} paddingX={1}>
                  <InteractiveRow id="concourse:board:empty-new" directActivate hoverStyle="row-fill" onActivate={() => wiring.newSession?.()}>
                    {hover => (
                      <Text wrap="truncate-end">
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
            </>
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
                    {GLYPH.ownHybrid} {g.label}
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
        return out
      })()}
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

  const mirrorInner = Math.max(1, mirrorRows - 2 - geo.liveComposerRows)
  const livePane = geo.constrained ? (
    <>
      <Box flexDirection="column" height={mirrorRows} overflow="hidden" flexShrink={0}>
        {mirrorNode(mirrorRows, Math.max(0, interior))}
      </Box>
      {geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
        <Box flexDirection="column" height={geo.liveComposerRows} overflow="hidden" flexShrink={0}>
          {liveComposerNode(geo.liveComposerRows, interior)}
        </Box>
      ) : null}
    </>
  ) : (
    <Box
      flexDirection="column"
      width={wide ? liveWidth : undefined}
      height={mirrorRows}
      overflow="hidden"
      borderStyle={paletteCollapsed() && region === 'live' ? 'bold' : 'round'}
      borderColor={region === 'live' ? t.info : t.borderSubtle}
      paddingX={1}
      flexShrink={0}
    >
      <Box flexDirection="column" height={mirrorInner} overflow="hidden" flexShrink={0}>
        {mirrorNode(mirrorInner, Math.max(0, liveWidth - 4))}
      </Box>
      {geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
        <Box flexDirection="column" height={geo.liveComposerRows} overflow="hidden" flexShrink={0}>
          {liveComposerNode(Math.max(1, geo.liveComposerRows - 3), Math.max(0, liveWidth - 4))}
        </Box>
      ) : null}
    </Box>
  )

  const coordinatorPane =
    thirdPaneRows > 0 && coordRows > 0 ? (
      <Box
        flexDirection="column"
        width={wide ? rightWidth : undefined}
        height={coordRows}
        overflow="hidden"
        flexShrink={0}
      >
        {coordinatorNode(coordRows, wide ? rightWidth : interior)}
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
            {coordinatorPane}
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
              {coordinatorPane}
            </Box>
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column">
            {livePane}
            {listPane}
            {coordinatorPane}
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0} height={geo.constrained ? 0 : 3} overflow="hidden">
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
                : (() => {
                    const prio = (keys: string): number => legendPriorityOf(keys, { splitOn })
                    const olderBrowse = olderRows > 0
                    const selectionClass = boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSelectedId))
                    const composerEnter =
                      region === 'live' && !olderBrowse
                        ? !liveDraftEmpty
                          ? [{ keys: '↵', label: 'send' }]
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
                        newSession: wiring.newSession !== undefined,
                        olderBrowse,
                        ...(region === 'list'
                          ? { selection: boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSelectedId)), armed: armedSelected, liveDraftHeld: !liveDraftEmpty, chordStaged: closeChordStaged, modelDefault: door !== undefined }
                          : {}),
                        ...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),
                        }),
                        { splitOn },
                      ),
                    ]
                    const paneTwinsDropped = region === 'list' && !olderBrowse
                    const browseKeySet = new Set(browseKeys.map(k => k.keys))
                    const parts = [
                      ...(paneTwinsDropped ? withoutManagerPaneKeys(regionParts) : regionParts),
                      ...(helpKeyFiresFor(region, region === 'coordinator' ? coordinatorDraftEmpty : liveDraftEmpty) ? [CONCOURSE_HELP_KEY] : []),
                      browseKeys.find(k => k.keys === 'esc')!,
                    ]
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
                  })()}
            </Text>
          )}
        </Box>
      </Box>
      {edgeRail}
    </Box>
  )
}
