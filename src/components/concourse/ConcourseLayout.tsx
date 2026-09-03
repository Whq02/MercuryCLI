import React from 'react'
import { Box, Text, paletteCollapsed } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { GLYPH, padStartTo } from '../mercury-ui/glyphs.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS } from '../../ink/viewportFloor.js'
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

// ============================================================================
//  ConcourseLayout — the three-region switchboard compositor
//  (supersedes the two-pane board/peek shell).
//
//    header · needs-you · [ COORDINATOR 40% | 1-cell gutter |
//                           SESSIONS list (content-sized) over MIRROR
//                           over the LIVE COMPOSER ] ·
//    status rail · help rail
//
//  Structural laws:
//   · ONE geometry owner — the screen's wheel router and this paint read the
//     same numbers (switchboardGeometry below);
//   · TWO COMPOSERS (L17 item 1): the coordinator pane hosts its own
//     composer inside its band; the live pane's foot carries the small
//     composer to the SELECTED row — the full-width strip retired whole;
//   · the MIRROR is the largest region on screen — live session text
//     outranks chrome;
//   · stacked (<120 cols) keeps one fixed order (rail · list · tall band ·
//     [live composer] · collapsed tail · status · help) and exactly ONE of
//     {mirror, coordinator} holds the tall band;
//   · selection is the estate selectionBand — colors only, zero reflow
//     (the 3-row outline retired as a named deletion);
//   · row click enters on the second click / ↵ (IP-1; retired as a
//     named deletion);
//   · every fact paints once — counts live on the status rail
//     alone.
//
//  The SCREEN stays the one semantic input owner; this file owns paint and
//  hit-region identity only.
// ============================================================================

export type ConcourseProfile = 'too-small' | 'stacked' | 'wide'

/** Line 5: the row peek's DESIRED height — "a taller preview of that
 *  session's last ~8 lines"; geometry grants what the bands can give. */
export const ROW_PEEK_DESIRED_ROWS = 8

/** The switchboard responsive ladder: wide ≥120 cols. The too-small floor IS
 *  the viewport floor (one owner): below it the alternate-screen host paints
 *  the resize line, so a fitting window never meets a too-small pane. */
export function resolveConcourseProfile(cols: number, rows: number): ConcourseProfile {
  if (cols < VIEWPORT_FLOOR_COLS || rows < VIEWPORT_FLOOR_ROWS) return 'too-small'
  if (cols >= 120 && rows >= 24) return 'wide'
  return 'stacked'
}

// 'chat' is the split view's chat pane — the LAST stop of the extended Tab
// ring, present exactly while the split frame composes; every board pane
// paints unfocused while it holds the keys (the at-a-glance law).
export type ConcourseRegion = 'rail' | 'list' | 'live' | 'coordinator' | 'chat'

export interface SwitchboardGeometry {
  profile: ConcourseProfile
  interior: number
  headerRows: number
  railRows: number
  railWindowRows: number
  railRuleRows: 0 | 1
  /** 1-based inclusive row span of the main band (panes). */
  mainBand: [number, number]
  mainRows: number
  /** THE LIVE COMPOSER BAND (the two-composers law, L17 item 1): the small
   *  composer at the live pane's foot — words to the SELECTED row. 0 rows
   *  when absent (a zero ask — the reduced stage; a coordinator-owned
   *  stacked tall band; a crushed terminal; the open peek at stacked
   *  pressure, which outranks it and hands the rows back on collapse).
   *  Otherwise 2 border + the granted band + 1 meta row. */
  liveComposerRows: number
  liveComposerBand: [number, number]
  statusTop: number
  helpTop: number
  /** Wide: 1-based inclusive column spans. */
  coordCols: [number, number]
  rightCols: [number, number]
  /** Rows (1-based, inclusive, absolute) of the list band inside main. */
  listBand: [number, number]
  /** Rows of the mirror band inside main (wide: below the list, above the
   *  live composer; stacked: the tall band or the collapsed tail — see
   *  tallOwner). */
  mirrorBand: [number, number]
  /** Stacked only: rows of the coordinator band. */
  coordBand: [number, number]
  /** How many session rows the list window paints (content rows). */
  listContentRows: number
  /** Line 5 (expand in place): the GRANTED peek rows inside the list band
   *  (0 = collapsed/no room). The list band grows by exactly this many rows
   *  — the mirror keeps ≥5 (wide) and the stacked tall band keeps ≥4. */
  peekRows: number
}

/** THE one geometry owner: paint and the wheel router read the
 *  same numbers. The full-width composer strip RETIRED with the
 *  two-composers law (its rows returned to the main band): the coordinator
 *  pane hosts its own composer inside its band, and the LIVE composer is a
 *  budgeted band at the live pane's foot — `liveDraftRows` is ITS draft
 *  ask (0 = no live composer at all; 1..3 through the one draftWindow
 *  owner). `tallOwner` names which chat band holds the stacked tall band. */
export function switchboardGeometry(
  cols: number,
  rows: number,
  needsYouCount: number,
  sessionRowCount: number,
  groupCount: number,
  liveDraftRows: number,
  tallOwner: 'mirror' | 'coordinator',
  /** Line 5: the expanded row-peek's DESIRED rows (0 = collapsed). */
  expandedRows = 0,
): SwitchboardGeometry {
  const profile = resolveConcourseProfile(cols, rows)
  const interior = cols - 4
  const headerRows = 3
  const statusRows = 3
  const helpRows = 1
  let railWindowRows = needsYouCount > 0 ? Math.min(needsYouCount, RAIL_MAX_ROWS) : 0
  let railRuleRows: 0 | 1 = needsYouCount > 0 ? 1 : 0
  // Zero obligations paint NOTHING — the budget must say the same:
  // the old `: 1` reserve left one phantom blank row for yoga to strand
  // inside the main band.
  const railRowsOf = (): number => (needsYouCount > 0 ? 3 + railRuleRows + railWindowRows : 0)
  let mainFloor = 8
  const fixedRows = (): number => headerRows + railRowsOf() + statusRows + helpRows
  // Shed ladder under row pressure: rail window → rail rule → main floor.
  const ladder: Array<() => boolean> = [
    () => (railWindowRows > 1 ? ((railWindowRows -= 1), true) : false),
    () => (railRuleRows > 0 ? ((railRuleRows = 0), true) : false),
    () => (mainFloor > 6 ? ((mainFloor -= 1), true) : false),
  ]
  for (const shed of ladder) {
    while (fixedRows() + mainFloor > rows && shed()) {
      /* one returned row per step */
    }
  }
  const mainRows = Math.max(mainFloor, rows - fixedRows())
  const railRows = railRowsOf()
  const mainTop = headerRows + railRows + 1
  const mainBand: [number, number] = [mainTop, mainTop + mainRows - 1]
  const mainEnd = mainTop + mainRows - 1
  const statusTop = mainTop + mainRows
  const helpTop = statusTop + statusRows
  // The live composer's ask, clamped: wide may grow the band to 3 rows
  // under a multiline steering draft; stacked keeps the smallest true box.
  const liveAsk = Math.max(0, Math.min(3, liveDraftRows))

  // ── wide: coordinator 40% | gutter | right column (list over mirror) ──────
  const coordW = Math.max(28, Math.round((interior * 40) / 100))
  const coordCols: [number, number] = [3, 2 + coordW]
  const rightCols: [number, number] = [3 + coordW + 1, 2 + interior]
  // The list band is content-sized: chrome 4 (border 2 + title 1 + column
  // header 1) + rows, clamped so the MIRROR stays the strictly larger band
  // with ≥4 content rows guaranteed (fewer sessions shrink the list
  // further — the mirror takes every freed row). The desired content counts
  // the REAL group headings (the flat `+2` allowance under-budgeted a
  // 3-group board, and the old 45% share hid rows behind a `↓ N more`
  // while the mirror sat empty on tall terminals).
  const LIST_CHROME = 4
  const maxListContent = Math.max(4, Math.ceil(mainRows / 2) - 1 - LIST_CHROME)
  const listContentWide = Math.max(
    sessionRowCount === 0 ? 3 : Math.min(4, Math.max(1, sessionRowCount)),
    Math.min(sessionRowCount + Math.max(1, groupCount), maxListContent),
  )
  if (profile === 'wide') {
    // The live composer: 2 border + band (1..3) + 1 meta. Under pressure
    // the band sheds toward 1, then the whole box yields — the list keeps
    // its floor (chrome + 1) and the mirror keeps ≥4 content rows before
    // the composer may stand.
    let composerRows = liveAsk > 0 ? 2 + liveAsk + 1 : 0
    while (composerRows > 4 && LIST_CHROME + 1 + composerRows + 5 > mainRows) composerRows -= 1
    if (composerRows > 0 && LIST_CHROME + 1 + composerRows + 4 > mainRows) composerRows = 0
    // The mirror keeps ≥5 rows while the list has them to give; at a
    // squeezed main band the LIST floor (chrome + 1 content row) wins —
    // `mainRows - 5` alone left a 2-row border husk with no title and no
    // rows at 24 terminal rows under a tall draft band.
    const listRowsBase = Math.min(
      listContentWide + LIST_CHROME,
      Math.max(LIST_CHROME + 1, mainRows - 5 - composerRows),
    )
    // Line 5 (expand in place): the peek grows the LIST band out of the
    // mirror's slack — the mirror keeps its ≥5-row floor, the row window
    // keeps its own budget (listContentRows excludes the grant).
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
  // ── stacked: list · tall band · [live composer] · collapsed 2-row tail ────
  // The bands TILE mainRows exactly — the tall band never invents
  // rows (the old max(4,…) floor overflowed the main band at 24/25 rows and
  // the tail painted through the composer). Pressure sheds the collapsed
  // tail first (2 → 0), then holds the list at its 2-content-row floor; the
  // tall band takes whatever remains (mainFloor keeps it ≥ 1). The live
  // composer stands only under a MIRROR-owned tall band (the coordinator's
  // composer lives inside its own pane), smallest true box (4 rows).
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
    // Crushed: the small composer yields before the tall band lies.
    tallRows += composerRows
    composerRows = 0
  }
  // Line 5 (expand in place): the peek takes the tall band's slack above
  // its 4-row floor, then the collapsed tail band, and at stacked pressure
  // the live composer yields too (the peek outranks it; the box returns on
  // collapse) — the bands still TILE mainRows exactly.
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

/** The colorless-legible state spine — no two states share
 *  glyph+ink; 'waits' rides the queued row's AGE cell; settled sessions
 *  leave the board upstream. '◐'/'◌'/'▣' are kit STATE_STYLE vocabulary. */
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
  // x-gesture: stopped is shape-distinct (hollow diamond, muted) — the
  // colorless board still separates it from needs-you's filled ◆.
  stopped: { glyph: '◇', color: 'textMuted' },
  completed: { glyph: GLYPH.ok, color: 'textMuted' },
  cancelled: { glyph: GLYPH.circledSlash, color: 'textMuted' },
  draft: { glyph: GLYPH.typing, color: 'textMuted' },
  // The concourse as the control plane: a parked row is a dormant chat of
  // the current project — the faint spark (the estate's outline ember),
  // muted; shape-distinct from every live state and from stopped's hollow
  // diamond.
  parked: { glyph: GLYPH.sparkFaint, color: 'textMuted' },
  // A door row (another project's running count, law 4): the kit's handoff
  // arrows in info ink — a switch of view, shape-distinct from every
  // session state.
  elsewhere: { glyph: GLYPH.handoff, color: 'info' },
}

/** The SELECTED row's glance word (item 4): the state spelled beside its
 *  glyph on the selected row alone — parked/running/NEEDS YOU legible at a
 *  glance without decoding the glyph spine. One vocabulary owner; the ink
 *  is the state's own. */
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

/** CB-05, OPERATOR-RULED (the reserve column): every board row reserves the
 *  state-word column — sized from the TABLE ITSELF (never a retyped list) —
 *  so the selected row's word (item 4's law, PRESERVED: the word stays
 *  beside the glyph, its own ink) fills a column every other row already
 *  holds as spaces. Titles NEVER move under arrows. The resting indent is
 *  the operator's DELIBERATE choice, picked knowing the cost — it is not a
 *  wiggle to polish back. */
export const STATE_WORD_RESERVE = Math.max(
  ...Object.values(STATE_WORD).map(word => word.length),
)

/** The reserve cell's text for one row: a leading space plus the word (the
 *  selected row) or spaces (every other row), always exactly
 *  1 + STATE_WORD_RESERVE cells — the byte-stable title column's whole
 *  mechanism. State words are ASCII by construction (the table above), so
 *  padEnd is cell-true here. */
export function stateWordCell(word: string | null): string {
  // Sliced THEN padded: an unknown raw state id longer than the table's
  // longest word must not move the one row it decorates — the cell is
  // width-stable for every input by construction.
  return ` ${(word ?? '').slice(0, STATE_WORD_RESERVE).padEnd(STATE_WORD_RESERVE)}`
}

export interface ConcourseLayoutWiring {
  /** First click selects (mirror follows); second click / ↵ ENTERS (IP-1). */
  selectSession: (sessionId: string) => void
  enterSession: (sessionId: string) => void
  selectObligation: (index: number) => void
  answerObligation: (obligationId: string) => void
  openObligation: (obligationId: string) => void
  openBootSettings: () => void
  exitToRepl: () => void
  /** the empty board's ONE door — focus the coordinator's composer. */
  focusComposer: () => void
  /** FOCUS IS LEGIBLE (item 4): the panel titles are mouse parity for the
   *  Tab ring — clicking SESSIONS focuses the list panel. */
  focusList?: () => void
  /** The rail's coordinator segment IS the model selector (dedup ruling). */
  openCoordinatorModel?: () => void
  retrySnapshot?: () => void
  /** Finding 3: '✕ dismiss' on a rail row — the same withdraw
   *  settlement 'w' rides. */
  withdrawObligation?: (obligationId: string) => void
  /** Drive 6b: the rail's PROJECT segment opens the repo selector. */
  openGroundPicker?: () => void
  /** THE NEW SESSION TAB (Law 9, rule 4): present exactly when the stage
   *  carries the door — the full concourse; the reduced stage wires none and
   *  the tab (and its n) never paint. */
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
  /** Stacked: which chat band holds the tall band. */
  focusTall: 'mirror' | 'coordinator'
  /** The LIVE composer's draft-band ask (0 = no live composer at all — the
   *  reduced stage; 1..3 through the one draftWindow owner). */
  liveDraftRows: number
  /** The live composer's ↵ legend truth: an empty draft's ↵ is the browse
   *  verb on the selected row; with text, its own meta row carries '↵ send'
   *  and the legend stays quiet about ↵. */
  liveDraftEmpty?: boolean
  /** The coordinator composer's draft truth for the '? keys' row (the atlas
   *  key fires from a composer only while its draft is empty). */
  coordinatorDraftEmpty?: boolean
  /** The rail selector's open state (paints the focused pill). */
  modelPickerOpen?: boolean
  /** Drive 6b: the repo selector's open state (same pill grammar). */
  groundPickerOpen?: boolean
  /** Line 5 (expand in place): the row peek's open state — geometry grows
   *  the list band by the granted rows and the peek paints under the
   *  SELECTED row, still live; ↵ still enters. */
  rowPeekOpen?: boolean
  rowPeekNode?: (rows: number, width: number) => React.ReactNode
  /** The work chip: with the peek COLLAPSED, the
   *  selected row's running work earns ONE row under it — the same slot,
   *  the same geometry owner (the wheel router reads the same numbers). */
  rowChipRows?: number
  /** ITEM 7 (L20): the older-chats drop-down's GRANT ASK (0 = folded) —
   *  rides the peek's granted-rows channel; while >0 the legend swaps to
   *  the browse grammar (↑↓ choose · ↵ brings it back · esc folds). */
  olderRows?: number
  /** ARM-THEN-ENTER (L17 item 2): the selected row is ARMED as the live
   *  composer's target — the legend's ↵ says the next press enters. */
  armedSelected?: boolean
  /** THE BROADCAST MARKS: the marked rows wear
   *  the visible check — screen state handed down for paint only (the marks'
   *  home is the screen, never this compositor and never the capsule). */
  markedIds?: ReadonlySet<string>
  /** The three slots — the screen owns their contents; this shell owns
   *  their geometry. The chat panes receive (contentRows, contentWidth);
   *  the live composer receives (bandRows, width) — its granted draft band
   *  inside the budgeted box (rows − border 2 − meta 1). */
  coordinatorNode: (rows: number, width: number) => React.ReactNode
  mirrorNode: (rows: number, width: number) => React.ReactNode
  liveComposerNode?: (bandRows: number, width: number) => React.ReactNode
  wiring: ConcourseLayoutWiring
  /** The tab's own receipt (the route's 'board:new-session' note): pending
   *  while the birth runs, the daemon's refusal in place, applied as the
   *  route flips. */
  newSessionNote?: ControlNoteState
  /** THE SPLIT FRAME's width seam: the board pane's columns while the split
   *  composes (the screen and this compositor must read the SAME frame —
   *  both read the terminal without it). Absent = the whole terminal. */
  frameCols?: number
  /** The split frame stands — the legend's `s` row tells the way back (the
   *  one withSplitViewTruth resolver). */
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
  )
  // Line 7: the live-tile store's honest posture — the footer says it once.
  const tilesDegraded = useLiveTilesDegraded()
  // The strip's chat presence (the control-plane model): esc lands the
  // focused chat while one exists, the boot face otherwise — the legend
  // says which, re-read when the chat stop appears or vanishes.
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const chat = chatPresent()
  const browseKeys = browseKeysFor({ chatPresent: chat, region })

  if (geo.profile === 'too-small') {
    return (
      <Box flexDirection="column" width="100%" height={termRows} paddingX={1} justifyContent="center">
        <Text color={t.warning} bold>
          terminal too small for the Session Concourse
        </Text>
        {/* termCols, never the split pane's frameCols: with the split on and
            the window dragged SHORT, cols is the board pane's clamped 80 —
            "this window is 80×20" on a 130-column window sent the operator
            widening a window already 50 columns past the stated minimum
            (TASK-017 S2, concourse-too-small-names-pane-width). */}
        <Text color={t.textSecondary}>needs at least 80×24 · this window is {termCols}×{termRows}</Text>
        <Text color={t.textMuted}>{chat ? 'esc returns to the focused chat' : 'esc returns to the boot face'}</Text>
      </Box>
    )
  }

  const interior = geo.interior
  const wide = geo.profile === 'wide'
  const coordWidth = wide ? geo.coordCols[1] - geo.coordCols[0] + 1 : interior
  const rightWidth = wide ? geo.rightCols[1] - geo.rightCols[0] + 1 : interior
  const listRows = geo.listBand[1] - geo.listBand[0] + 1
  const mirrorRows = geo.mirrorBand[1] - geo.mirrorBand[0] + 1
  const coordRows = wide ? geo.mainRows : geo.coordBand[1] - geo.coordBand[0] + 1

  // ── the board window (selection-follow or explicit wheel window) ──────────
  // Chrome-aware fit (fitGroupedWindow — the ONE owner): the window's rows
  // PLUS their group headings PLUS the more-line tile the band exactly (the
  // header vanishing under yoga shrink and the clipped QUEUED tail were both
  // this class); content rows outrank ornament, and the more-line always
  // survives to tell the truth about what shed.
  const selectedIdx = Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelectedId))
  // Line 6 (needs-you first): the oldest open question per session — the
  // tile shows the ask above whatever the session streams.
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
  // Min-geometry truth ladder: fitGroupedWindow floors at a 1-row span, so
  // at a 1–2 row content budget the heading + more-line still overflowed and
  // yoga CLIPPED the more-line — 5 of 6 sessions hidden with no `↓ N more`.
  // Headings are ornament, the more-line is truth, and content rows outrank
  // both (this pane's own law): when the floored fit overflows OR the
  // grouped grammar leaves fewer than 2 visible rows while a plain window
  // shows more, shed the headings and re-window so rows + the more-line
  // tile the budget exactly (the state glyphs keep every row legible).
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
      // FOCUS IS LEGIBLE (L17 item 4): the focused panel's border takes the
      // accent, siblings stay subtle — the estate's existing tokens; the
      // collapsed-palette bold SHAPE fork survives (a11y-p2-04).
      borderStyle={paletteCollapsed() && region === 'list' ? 'bold' : 'round'}
      borderColor={region === 'list' ? t.info : t.borderSubtle}
      flexShrink={0}
    >
      <Box flexShrink={0} paddingX={1} flexDirection="row" overflow="hidden">
        {/* The panel title dims with its panel (item 4) — and clicking it
            focuses the panel (mouse parity for the Tab stop). */}
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
          // THE NEW SESSION TAB (Law 9, rule 4): the small affordance at the
          // right end of the SESSIONS title — click here, n from the list —
          // births a blank session in the current ground through the one
          // birth door and focuses the chat. Its receipt paints in place.
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
          // flexShrink=0: the ONLY shrinkable row in an over-full column is
          // the first thing yoga collapses — the header vanished while every
          // pinned row beneath it painted (the first-capture catch).
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
          // THE EMPTY STATE, designed (item 4): no column header over
          // nothing — the fact in one calm line, then the REAL doors,
          // each clickable (the same doors the keys reach).
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
                {/* C9 (CB-07): the operator's raw filter is honest but
                    BOUNDED — a pasted monster wrapped the pane and pushed
                    the exit hint out of the clipped rows. */}
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
            // queued rows carry 'waits' in the AGE cell. padStartTo
            // (C9 — CB-06): the value fills from the LEFT so it sits under
            // its right-aligned AGE header at every width.
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
                        // THE BROADCAST MARK (item 1): the marked row wears
                        // the visible check — the kit's approval tick in the
                        // interactive accent, leading the state glyph (the
                        // selected row's state-word shift is the precedent
                        // for a per-row lead that moves the title).
                        <Text color={t.info}>{GLYPH.check} </Text>
                      ) : null}
                      {r.state === 'working' ? (
                        // ONE synchronized heartbeat — every
                        // working row samples the same absolute clock bucket
                        // (frame-0 static under MERCURY_LIVE_GLYPHS=0).
                        <WorkingGlyph color={t.info} active />
                      ) : (
                        <Text color={t[sg.color]}>{sg.glyph}</Text>
                      )}
                      {/* Item 4 PRESERVED + CB-05 operator-ruled: the
                          SELECTED row spells its state beside the glyph in
                          its own ink — inside a column EVERY row reserves
                          (stateWordCell), so arrows change ink and word,
                          never the titles' x. The resting indent is the
                          operator's deliberate cost — not a wiggle to
                          polish back. */}
                      <Text color={t[sg.color]}>
                        {stateWordCell(
                          isSel && !r.sessionId.startsWith('older:')
                            ? (STATE_WORD[r.state] ?? r.state)
                            : null,
                        )}
                      </Text>
                      <Text> </Text>
                      {r.foreignProject !== undefined ? (
                        // THE ★ CARRY-OVER (cross-project awareness, law 2):
                        // the focused chat of another project rides this
                        // board with the star and its home named beside the
                        // title — the one row the project filter never
                        // hides. The GLYPH LEADS the title so a long title
                        // in a narrow cell can never truncate the star away
                        // (the cell cuts from the end); the from-name rides
                        // behind the title best-effort, and the project cell
                        // names the home at every width.
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
                    {/* forked rows lead with the branch glyph (info
                        ink, outside the STATE_GLYPH spine — CA-09 safe);
                        main-checkout rows are pixel-unchanged. */}
                    <Text wrap="truncate-end">
                      {r.worktreeBranch !== undefined ? <Text color={t.info}>{GLYPH.branch} </Text> : null}
                      <Text color={t.textSecondary}>{r.projectLabel}</Text>
                    </Text>
                  </Box>
                  <Box width={nowWidth} flexShrink={0} paddingRight={1}>
                    {/* the NOW cell ALIVE (sheet lines 1–3, 6) — muted so it
                        never competes with state; CA-16: the workflows-allowed
                        tag leads it in secondary ink. The cell owns its live
                        subscription; the row around it never re-renders for a
                        tile update (the CALM law). */}
                    <LiveNowCell row={r} ask={askBySession.get(r.sessionId)} />
                  </Box>
                  <Box width={colAge} justifyContent="flex-end" paddingRight={1} flexShrink={0}>
                    <Text color={t.textInstruction}>{ageBlock}</Text>
                  </Box>
                </InteractiveRow>
              </Box>,
            )
            if (isSel && geo.peekRows > 0 && rowPeekNode !== undefined) {
              // Line 5: the expanded live peek IN PLACE — under its row,
              // inside the list band's granted rows; ↵ on the row still
              // enters, `→`/esc collapse.
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
    </Box>
  )

  // FOCUS IS LEGIBLE (item 4): the LIVE panel (mirror + its composer) wears
  // a real frame whose border takes the accent while the panel holds focus
  // — the three panels now speak one focus grammar. The band's rows are
  // unchanged (the frame lives inside them); the content gets rows − 2.
  const mirrorPane = (
    <Box
      flexDirection="column"
      width={wide ? rightWidth : undefined}
      height={mirrorRows}
      overflow="hidden"
      borderStyle={paletteCollapsed() && region === 'live' ? 'bold' : 'round'}
      borderColor={region === 'live' ? t.info : t.borderSubtle}
      paddingX={1}
      flexShrink={0}
    >
      {mirrorNode(Math.max(1, mirrorRows - 2), (wide ? rightWidth : interior) - 4)}
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

  // THE LIVE COMPOSER (the two-composers law): the small box at the live
  // pane's foot — geometry budgets it; the screen owns its contents.
  const liveComposerPane =
    geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
      <Box
        flexDirection="column"
        width={wide ? rightWidth : undefined}
        height={geo.liveComposerRows}
        overflow="hidden"
        flexShrink={0}
      >
        {liveComposerNode(Math.max(1, geo.liveComposerRows - 3), wide ? rightWidth : interior)}
      </Box>
    ) : null

  const edgeRail = (
    <Box width={2} flexShrink={0} flexDirection="column">
      {Array.from({ length: termRows }, (_, i) => (
        <Box key={i} height={1} flexShrink={0} />
      ))}
    </Box>
  )

  return (
    <Box flexDirection="row" width="100%" height={termRows}>
      {edgeRail}
      <Box flexDirection="column" flexGrow={1} height={termRows}>
        <Box flexDirection="column" flexShrink={0}>
          <ConcourseHeader
            snapshot={snapshot}
            onBoot={() => wiring.openBootSettings()}
            onMainRepl={() => wiring.exitToRepl()}
            columns={cols}
          />
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {snapshot.needsYou.length > 0 ? (
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
          ) : null /* CA-03: no placeholder row — zero obligations paint
            NOTHING here (the rail region leaves the tab ring with them) */}
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
          // Fixed stack order — list · tall band · [live composer] · tail.
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
        <Box flexDirection="column" flexShrink={0}>
          <ConcourseStatusRail
            snapshot={snapshot}
            width={interior}
            {...(wiring.openCoordinatorModel !== undefined ? { onOpenModel: wiring.openCoordinatorModel } : {})}
            modelPickerOpen={modelPickerOpen}
            groundPickerOpen={groundPickerOpen}
            {...(wiring.openGroundPicker !== undefined ? { onOpenGround: wiring.openGroundPicker } : {})}
          />
        </Box>
        <Box height={1} flexShrink={0}>
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
                    // Width-aware legend (audited): the old single joined
                    // line truncated at the RIGHT end, so 80 columns cut the
                    // region verbs, '? keys' and even 'esc focused chat' — the
                    // most contextual keys died first. Shed by declared
                    // priority instead — the manifest's ONE resolver
                    // (legendPriorityOf; the split state threads through so
                    // the way back outlives the narrow pane it creates).
                    const prio = (keys: string): number => legendPriorityOf(keys, { splitOn })
                    // ITEM 7: while the older drop-down stands, the browse
                    // keys mean the LIST — ↑↓ choose, ↵ brings it back,
                    // esc folds (the present-moves law; the same resolver).
                    const olderBrowse = olderRows > 0
                    const composerEnter =
                      region === 'live' && liveDraftEmpty && !olderBrowse
                        ? armedSelected
                          ? [
                              // ARM-THEN-ENTER (item 2): while armed the
                              // second press enters — the legend says so.
                              { keys: '↵', label: 'enters (armed)' },
                              { keys: '→', label: 'enter' },
                            ]
                          : [
                              { keys: '↵↵', label: 'enter session' },
                              { keys: '→', label: rowPeekOpen ? 'close peek' : 'peek' },
                            ]
                        : []
                    const parts = [
                      ...browseKeys.filter(k => k.keys !== 'esc'),
                      ...composerEnter,
                      // The region's verbs resolved for the stage AND the
                      // selection (BOARD CONTROLS, the present-moves law):
                      // n prints exactly when the New Session door is
                      // wired; the list's row verbs say only the moves the
                      // selected row has here and now — i/p/m on a live
                      // one, the dim parked reason on a parked one. The
                      // split truth rides the one resolver: `s` reads the
                      // way back while the split frame stands, and the chat
                      // pane's ↵ follows the focused slot.
                      ...withSplitViewTruth(
                        regionKeysFor(region, {
                        newSession: wiring.newSession !== undefined,
                        olderBrowse,
                        ...(region === 'list'
                          ? { selection: boardSelectionClassOf(sessionRows.find(r => r.sessionId === boardSelectedId)), armed: armedSelected, liveDraftHeld: !liveDraftEmpty }
                          : {}),
                        ...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),
                        }),
                        { splitOn },
                      ),
                      // THE ATLAS KEY prints exactly where it fires (the one
                      // resolver the screen's handler decides with): from a
                      // composer only while its draft is empty.
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
                      // THE PLATFORM SEAM (class 5): the chip's authored
                      // spelling drives the logic above (prio weights, the
                      // manifest filters); the HOST's spelling is what
                      // paints — identity on macOS, words elsewhere.
                      .map(k => ({ text: `${keyHintLabel(k.keys)} ${k.label}`, priority: prio(k.keys) }))
                    // Line 7's ONE footer sentence — outranks every key so
                    // the degrade is never shed into silence.
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
