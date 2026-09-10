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
import { boardSelectionClassOf, browseKeysFor, CONCOURSE_HELP_KEY, helpKeyFiresFor, legendPriorityOf, newSessionTabLabel, regionKeysFor, withSplitViewTruth } from './controlManifest.js'
import { chatPresent, subscribeSurfaceRoute, surfaceRouteVersion } from '../../context/surfaceRoute.js'
import { landingInFlight } from '../../services/engine-connector/focusedConnector.js'
import { useSyncExternalStore } from 'react'
import { ConcourseHeader } from './ConcourseHeader.js'
import { LiveNowCell } from './LiveNowCell.js'
import { useLiveTilesDegraded } from './liveTiles.js'
import { NeedsYouRail, RAIL_MAX_ROWS } from './NeedsYouRail.js'
import { ConcourseStatusRail } from './ConcourseStrips.js'


export type ConcourseProfile = 'stacked' | 'wide'

export const ROW_PEEK_DESIRED_ROWS = 8

export function resolveConcourseProfile(cols: number, rows: number): ConcourseProfile {
  if (cols >= 120 && rows >= 24) return 'wide'
  return 'stacked'
}

export type ConcourseRegion = 'rail' | 'list' | 'live' | 'coordinator' | 'chat'

export interface SwitchboardGeometry {
  constrained?: boolean
  profile: ConcourseProfile
  interior: number
  headerRows: number
  railRows: number
  railWindowRows: number
  railRuleRows: 0 | 1
  mainBand: [number, number]
  mainRows: number
  liveComposerRows: number
  liveComposerBand: [number, number]
  statusTop: number
  helpTop: number
  coordCols: [number, number]
  rightCols: [number, number]
  listBand: [number, number]
  mirrorBand: [number, number]
  coordBand: [number, number]
  listContentRows: number
  peekRows: number
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
): SwitchboardGeometry {
  const profile = resolveConcourseProfile(cols, rows)
  if (cols < 80 || rows < 22) {
    const width = Math.max(0, Math.floor(cols))
    const total = Math.max(0, Math.floor(rows))
    const helpRows = total > 1 ? 1 : 0
    const mainRows = total - helpRows
    const empty: [number, number] = [0, -1]
    const all: [number, number] = mainRows > 0 ? [1, mainRows] : empty
    const liveComposerRows = focusedRegion === 'live' && liveDraftRows > 0 ? Math.min(mainRows, Math.max(1, Math.min(3, liveDraftRows))) : 0
    const liveComposerBand: [number, number] = liveComposerRows > 0 ? [mainRows - liveComposerRows + 1, mainRows] : empty
    return {
      constrained: true, profile: 'stacked', interior: width,
      headerRows: 0, railRows: focusedRegion === 'rail' ? mainRows : 0,
      railWindowRows: focusedRegion === 'rail' ? Math.min(mainRows, needsYouCount) : 0,
      railRuleRows: 0, mainBand: all, mainRows, liveComposerRows, liveComposerBand,
      statusTop: total + 1, helpTop: helpRows > 0 ? total : total + 1,
      coordCols: width > 0 ? [1, width] : empty, rightCols: width > 0 ? [1, width] : empty,
      listBand: focusedRegion === 'list' || focusedRegion === 'chat' ? all : empty,
      listContentRows: focusedRegion === 'list' || focusedRegion === 'chat' ? mainRows : 0,
      coordBand: focusedRegion === 'coordinator' ? all : empty,
      mirrorBand: focusedRegion === 'live' && mainRows > liveComposerRows ? [1, mainRows - liveComposerRows] : empty,
      peekRows: 0,
    }
  }
  const interior = cols - 4
  const headerRows = 3
  const statusRows = 3
  const helpRows = 1
  let railWindowRows = needsYouCount > 0 ? Math.min(needsYouCount, RAIL_MAX_ROWS) : 0
  let railRuleRows: 0 | 1 = needsYouCount > 0 ? 1 : 0
  const railRowsOf = (): number => (needsYouCount > 0 ? 3 + railRuleRows + railWindowRows : 0)
  let mainFloor = 8
  const fixedRows = (): number => headerRows + railRowsOf() + statusRows + helpRows
  const ladder: Array<() => boolean> = [
    () => (railWindowRows > 1 ? ((railWindowRows -= 1), true) : false),
    () => (railRuleRows > 0 ? ((railRuleRows = 0), true) : false),
    () => (mainFloor > 6 ? ((mainFloor -= 1), true) : false),
  ]
  for (const shed of ladder) {
    while (fixedRows() + mainFloor > rows && shed()) {
    }
  }
  const mainRows = Math.max(mainFloor, rows - fixedRows())
  const railRows = railRowsOf()
  const mainTop = headerRows + railRows + 1
  const mainBand: [number, number] = [mainTop, mainTop + mainRows - 1]
  const mainEnd = mainTop + mainRows - 1
  const statusTop = mainTop + mainRows
  const helpTop = statusTop + statusRows
  const liveAsk = Math.max(0, Math.min(3, liveDraftRows))

  const coordW = Math.max(28, Math.round((interior * 40) / 100))
  const coordCols: [number, number] = [3, 2 + coordW]
  const rightCols: [number, number] = [3 + coordW + 1, 2 + interior]
  const LIST_CHROME = 4
  const maxListContent = Math.max(4, Math.ceil(mainRows / 2) - 1 - LIST_CHROME)
  const listContentWide = Math.max(
    sessionRowCount === 0 ? 3 : Math.min(4, Math.max(1, sessionRowCount)),
    Math.min(sessionRowCount + Math.max(1, groupCount), maxListContent),
  )
  if (profile === 'wide') {
    let composerRows = liveAsk > 0 ? 2 + liveAsk + 1 : 0
    while (composerRows > 4 && LIST_CHROME + 1 + composerRows + 5 > mainRows) composerRows -= 1
    if (composerRows > 0 && LIST_CHROME + 1 + composerRows + 4 > mainRows) composerRows = 0
    const listRowsBase = Math.min(
      listContentWide + LIST_CHROME,
      Math.max(LIST_CHROME + 1, mainRows - 5 - composerRows),
    )
    const peekRows = Math.max(0, Math.min(expandedRows, mainRows - 5 - composerRows - listRowsBase))
    const listRows = listRowsBase + peekRows
    const listBand: [number, number] = [mainTop, mainTop + listRows - 1]
    const mirrorBand: [number, number] = [mainTop + listRows, mainEnd - composerRows]
    const liveComposerBand: [number, number] = composerRows > 0 ? [mainEnd - composerRows + 1, mainEnd] : [0, -1]
    return {
      profile, interior, headerRows, railRows, railWindowRows, railRuleRows,
      mainBand, mainRows, liveComposerRows: composerRows, liveComposerBand, statusTop, helpTop,
      coordCols, rightCols, listBand, mirrorBand,
      coordBand: mainBand,
      listContentRows: Math.max(1, listRowsBase - LIST_CHROME),
      peekRows,
    }
  }
  const fullCols: [number, number] = [3, 2 + interior]
  const TAIL_ROWS = 2
  const listRowsBase = Math.min(
    Math.max(LIST_CHROME + 2, Math.floor(mainRows * 0.4)),
    listContentWide + LIST_CHROME,
  )
  let composerRows = liveAsk > 0 && tallOwner === 'mirror' ? 2 + 1 + 1 : 0
  let tailRows = TAIL_ROWS
  let tallRows = mainRows - listRowsBase - tailRows - composerRows
  if (tallRows < 4) {
    const fromTail = Math.min(4 - tallRows, tailRows)
    tailRows -= fromTail
    tallRows += fromTail
  }
  if (tallRows < 4 && composerRows > 0) {
    tallRows += composerRows
    composerRows = 0
  }
  let peekRows = Math.max(0, Math.min(expandedRows, tallRows - 4))
  tallRows -= peekRows
  if (peekRows < expandedRows && tailRows > 0) {
    const fromTail = Math.min(expandedRows - peekRows, tailRows)
    tailRows -= fromTail
    peekRows += fromTail
  }
  if (expandedRows > 0 && peekRows < 4 && composerRows > 0) {
    const fromComposer = Math.min(expandedRows - peekRows, composerRows)
    composerRows -= fromComposer
    peekRows += fromComposer
    if (composerRows < 4) {
      tallRows += composerRows
      composerRows = 0
    }
  }
  const listRowsStacked = listRowsBase + peekRows
  const listBand: [number, number] = [mainTop, mainTop + listRowsStacked - 1]
  const tallBand: [number, number] = [mainTop + listRowsStacked, mainTop + listRowsStacked + tallRows - 1]
  const liveComposerBand: [number, number] = composerRows > 0 ? [tallBand[1] + 1, tallBand[1] + composerRows] : [0, -1]
  const tailTop = composerRows > 0 ? liveComposerBand[1] + 1 : tallBand[1] + 1
  const tailBand: [number, number] = [tailTop, tailTop + tailRows - 1]
  return {
    profile, interior, headerRows, railRows, railWindowRows, railRuleRows,
    mainBand, mainRows, liveComposerRows: composerRows, liveComposerBand, statusTop, helpTop,
    coordCols: fullCols, rightCols: fullCols,
    listBand,
    mirrorBand: tallOwner === 'mirror' ? tallBand : tailBand,
    coordBand: tallOwner === 'coordinator' ? tallBand : tailBand,
    listContentRows: Math.max(1, listRowsBase - LIST_CHROME),
    peekRows,
  }
}

const STATE_GLYPH: Record<string, { glyph: string; color: 'success' | 'warning' | 'failure' | 'info' | 'textMuted' | 'infoText' }> = {
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

const STATE_WORD: Record<string, string> = {
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

export interface ConcourseLayoutWiring {
  selectSession: (sessionId: string) => void
  enterSession: (sessionId: string) => void
  selectObligation: (index: number) => void
  answerObligation: (obligationId: string) => void
  openObligation: (obligationId: string) => void
  openBootSettings: () => void
  exitToRepl: () => void
  focusComposer: () => void
  focusList?: () => void
  openCoordinatorModel?: () => void
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
  modelPickerOpen = false,
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
  modelPickerOpen?: boolean
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
  const geo = switchboardGeometry(
    cols,
    termRows,
    snapshot.needsYou.length,
    sessionRows.length,
    boardGroups.filter(g => g.rows.length > 0).length,
    liveDraftRows,
    focusTall,
    rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : rowChipRows,
    region,
  )
  const tilesDegraded = useLiveTilesDegraded()
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const chat = chatPresent()
  const browseKeys = browseKeysFor({ chatPresent: chat, region })


  const interior = geo.interior
  const wide = geo.profile === 'wide'
  const coordWidth = wide ? geo.coordCols[1] - geo.coordCols[0] + 1 : interior
  const rightWidth = wide ? geo.rightCols[1] - geo.rightCols[0] + 1 : interior
  const listRows = geo.listBand[1] - geo.listBand[0] + 1
  const mirrorRows = geo.mirrorBand[1] - geo.mirrorBand[0] + 1
  const coordRows = wide ? geo.mainRows : geo.coordBand[1] - geo.coordBand[0] + 1

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
  let win = fitGroupedWindow(
    sessionRows.length,
    geo.listContentRows,
    windowFor,
    i => groupOfRow.get(sessionRows[i]!.sessionId) ?? '',
  )
  let showHeadings = true
  {
    const groupsInWin = new Set<string>()
    for (let i = win.start; i < win.end; i++) groupsInWin.add(groupOfRow.get(sessionRows[i]!.sessionId) ?? '')
    const moreRow = win.above > 0 || win.below > 0 ? 1 : 0
    const groupedRows = win.end - win.start
    const overflow = groupedRows + groupsInWin.size + moreRow > geo.listContentRows
    const headinglessSpan =
      sessionRows.length <= geo.listContentRows
        ? sessionRows.length
        : Math.max(1, geo.listContentRows - 1)
    if (overflow || (groupedRows < 2 && sessionRows.length > 1 && headinglessSpan > groupedRows)) {
      showHeadings = false
      win = windowFor(headinglessSpan)
    }
  }

  const colProject = rightWidth >= 70 ? 12 : 10
  const colAge = 7
  const nowWidth = Math.max(12, Math.floor(rightWidth * 0.3))

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
      borderStyle={geo.constrained ? undefined : paletteCollapsed() && region === 'list' ? 'bold' : 'round'}
      borderColor={region === 'list' ? t.info : t.borderSubtle}
      flexShrink={0}
    >
      {geo.constrained ? (
        <Box flexDirection="column">
          {filtering ? <Text wrap="truncate-end">{(() => { const lens = caretLens({ text: filterText, caret: filterCaret }, interior); return `${lens.before}${lens.at || ' '}${lens.after}` })()}</Text> : null}
          {sessionRows.length === 0 ? <Text wrap="truncate-end">no sessions · n starts one</Text> : sessionRows.slice(win.start, win.end).map(r => (
            <Box key={r.sessionId} height={1} onClick={() => wiring.selectSession(r.sessionId)}><Text bold={r.sessionId === boardSelectedId} color={r.sessionId === boardSelectedId ? t.info : t.textSecondary} wrap="truncate-end">{r.title}</Text></Box>
          ))}
        </Box>
      ) : <>
      <Box flexShrink={0} paddingX={1} flexDirection="row" overflow="hidden">
        {
}
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
          <Box paddingX={1} flexShrink={0} height={1}>
            <Box flexGrow={1}>
              <Text color={t.textInstruction}>STATUS & TITLE</Text>
            </Box>
            <Box width={colProject} flexShrink={0} paddingRight={1}>
              <Text color={t.textInstruction}>PROJECT</Text>
            </Box>
            <Box width={nowWidth} flexShrink={0} paddingRight={1}>
              <Text color={t.textInstruction}>NOW</Text>
            </Box>
            <Box width={colAge} justifyContent="flex-end" paddingRight={1} flexShrink={0}>
              <Text color={t.textInstruction}>AGE</Text>
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
              {wiring.newSession !== undefined ? (
                <Box flexShrink={0} paddingX={1}>
                  <InteractiveRow id="concourse:board:empty-new" directActivate hoverStyle="row-fill" onActivate={() => wiring.newSession?.()}>
                    {hover => (
                      <Text wrap="truncate-end">
                        <Text color={hover ? t.textPrimary : t.info}>{'▸ '}</Text>
                        <Text color={hover ? t.textPrimary : t.info}>n starts a blank session in this project</Text>
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
                {
}
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
            const sg = r.state === 'working' && isSel ? { glyph: GLYPH.ok, color: 'info' as const } : base
            const ageBlock = padStartTo(r.state === 'queued' ? 'waits' : (r.ageLabel ?? '—'), 5)
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
                  <Box flexGrow={1} overflow="hidden">
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
                      {
}
                      <Text color={t[sg.color]}>
                        {stateWordCell(
                          isSel && !r.sessionId.startsWith('older:')
                            ? (STATE_WORD[r.state] ?? r.state)
                            : null,
                        )}
                      </Text>
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
                  <Box width={colProject} flexShrink={0} paddingRight={1}>
                    {
}
                    <Text wrap="truncate-end">
                      {r.worktreeBranch !== undefined ? <Text color={t.info}>{branchChip('')}</Text> : null}
                      <Text color={t.textSecondary}>{r.projectLabel}</Text>
                    </Text>
                  </Box>
                  <Box width={nowWidth} flexShrink={0} paddingRight={1}>
                    {
}
                    <LiveNowCell row={r} ask={askBySession.get(r.sessionId)} />
                  </Box>
                  <Box width={colAge} justifyContent="flex-end" paddingRight={1} flexShrink={0}>
                    <Text color={t.textInstruction}>{ageBlock}</Text>
                  </Box>
                </InteractiveRow>
              </Box>,
            )
            if (isSel && geo.peekRows > 0 && rowPeekNode !== undefined) {
              const paneW = wide ? rightWidth : interior
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
              <Text color={t.textMuted}>
                {win.above > 0 ? `↑ ${win.above} more` : ''}
                {win.above > 0 && win.below > 0 ? ' · ' : ''}
                {win.below > 0 ? `↓ ${win.below} more` : ''}
              </Text>
            </Box>,
          )
        }
        return out
      })()}
      </>}
    </Box>
  )

  const mirrorPane = (
    <Box
      flexDirection="column"
      width={wide ? rightWidth : undefined}
      height={mirrorRows}
      overflow="hidden"
      borderStyle={geo.constrained ? undefined : paletteCollapsed() && region === 'live' ? 'bold' : 'round'}
      borderColor={region === 'live' ? t.info : t.borderSubtle}
      paddingX={geo.constrained ? 0 : 1}
      flexShrink={0}
    >
      {mirrorNode(geo.constrained ? mirrorRows : Math.max(1, mirrorRows - 2), Math.max(0, (wide ? rightWidth : interior) - (geo.constrained ? 0 : 4)))}
    </Box>
  )

  const coordinatorPane = (
    <Box
      flexDirection="column"
      width={wide ? coordWidth : undefined}
      height={coordRows}
      overflow="hidden"
      flexShrink={0}
    >
      {coordinatorNode(coordRows, wide ? coordWidth : interior)}
    </Box>
  )

  const liveComposerPane =
    geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
      <Box
        flexDirection="column"
        width={wide ? rightWidth : undefined}
        height={geo.liveComposerRows}
        overflow="hidden"
        flexShrink={0}
      >
        {liveComposerNode(geo.constrained ? geo.liveComposerRows : Math.max(1, geo.liveComposerRows - 3), wide ? rightWidth : interior)}
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
        <Box flexDirection="column" flexShrink={0} height={geo.headerRows} overflow="hidden">
          <ConcourseHeader
            snapshot={snapshot}
            onBoot={() => wiring.openBootSettings()}
            onMainRepl={() => wiring.exitToRepl()}
            columns={cols}
          />
        </Box>
        <Box flexDirection="column" flexShrink={0} height={geo.railRows} overflow="hidden">
          {geo.constrained && region === 'rail' ? <Text color={t.warning} wrap="truncate-end">{snapshot.needsYou[railIndex]?.question ?? 'nothing needs you'}</Text> : snapshot.needsYou.length > 0 ? (
            <NeedsYouRail
              snapshot={snapshot}
              focused={region === 'rail'}
              selectedIndex={railIndex}
              width={interior}
              maxRows={geo.railWindowRows}
              showRule={geo.railRuleRows > 0}
              onSelectRow={i => wiring.selectObligation(i)}
              onAnswer={id => wiring.answerObligation(id)}
              onOpen={id => wiring.openObligation(id)}
              {...(wiring.withdrawObligation !== undefined
                ? { onDismiss: (id: string) => wiring.withdrawObligation?.(id) }
                : {})}
            />
          ) : null
}
        </Box>
        {wide ? (
          <Box flexGrow={1} flexDirection="row">
            {coordinatorPane}
            <Box width={1} flexShrink={0} flexDirection="column">
              {Array.from({ length: geo.mainRows }, (_, i) => (
                <Box key={i} height={1} flexShrink={0} />
              ))}
            </Box>
            <Box flexDirection="column" flexShrink={0} width={rightWidth}>
              {listPane}
              {mirrorPane}
              {liveComposerPane}
            </Box>
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column">
            {listPane}
            {focusTall === 'mirror' ? (
              <>
                {mirrorPane}
                {liveComposerPane}
                {coordinatorPane}
              </>
            ) : (
              <>
                {coordinatorPane}
                {mirrorPane}
              </>
            )}
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0} height={geo.constrained ? 0 : 3} overflow="hidden">
          <ConcourseStatusRail
            snapshot={snapshot}
            width={interior}
            {...(wiring.openCoordinatorModel !== undefined ? { onOpenModel: wiring.openCoordinatorModel } : {})}
            modelPickerOpen={modelPickerOpen}
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
                      region === 'live' && liveDraftEmpty && !olderBrowse
                        ? armedSelected
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
                    const parts = [
                      ...browseKeys.filter(k => k.keys !== 'esc'),
                      ...composerEnter,
                      ...withSplitViewTruth(
                        regionKeysFor(region, {
                        newSession: wiring.newSession !== undefined,
                        olderBrowse,
                        ...(region === 'list'
                          ? { selection: boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSelectedId)), armed: armedSelected, liveDraftHeld: !liveDraftEmpty, chordStaged: closeChordStaged }
                          : {}),
                        ...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),
                        }),
                        { splitOn },
                      ),
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
                      .map(k => ({ text: `${keyHintLabel(k.keys)} ${k.label}`, priority: prio(k.keys) }))
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
