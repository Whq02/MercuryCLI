import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from '../../ink.js';
import { chatPresent, concourseWayBack, plainWorldWhy, stripKeyMapHint, subscribeSurfaceRoute, surfaceRouteVersion } from '../../context/surfaceRoute.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { boardSelectionClassOf, browseKeysFor, CONCOURSE_HELP_KEY, helpKeyFiresFor, regionKeysFor } from './controlManifest.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js';
import { boardModalOwner, gitOfferOwnsTheKeys, mayArmBoardModal, type BoardModalFactsV1 } from './boardModalOwner.js';
import { claimConcourseCloseChord } from '../../services/concourse/closeChordSlot.js';
import { getPendingChordMirror, subscribePendingChordMirror } from '../../keybindings/pendingChordMirror.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { AnimatedCritterArt } from '../mercury-ui/AnimatedCritterArt.js';
import { critterDefForKey } from '../../utils/cockpit/critterData.js';
import { useSessionAccent } from '../mercury-ui/sessionAccent.js';
import type { ConcourseCallbacks, ConcourseRowV1, ConcourseSnapshotV1 } from './contracts.js';
import { controlNoteOf, stableSelectionFallback, concourseWaitCopy } from './contracts.js';
import {
  backspaceAt,
  caretVerticalOp,
  clampCaret,
  deleteAt,
  draftWindow,
  editorMotionOp,
  editorText,
  insertAt,
  newDraftUndo,
  recordDraftEdit,
  singleLine,
  undoDraft,
  type LineDraft,
} from './lineDraft.js';
import {
  ageLabelOf,
  OLDER_CHATS_ROW_PREFIX,
  olderChatsCensus,
  readCoordinatorComposerDraft,
  subscribeCoordinatorDraftChanges,
  writeCoordinatorComposerDraft,
  type OlderChatFact,
} from '../../services/concourse/concourseSnapshot.js';
import { PARKED_CAP } from '../../utils/bootCardFacts.js';
import { paneWindow } from '../mercury-ui/geometry.js';
import { CoordinatorPane } from './CoordinatorPane.js';
import { deriveGitOffer, GitOfferCard, gitOfferDescription, gitOfferFolderHeld, type GitOfferV1 } from './GitOfferCard.js';
import { needsSeatOverloadAsk, SeatOverloadCard } from './SeatOverloadCard.js';
import { ManagerAskCard, ManagerPlanCard, ManagerSeatAskCard } from './ManagerCards.js';
import { ContractOfferCard } from './ContractOfferCard.js';
import { CoordinatorModelPicker } from './CoordinatorModelPicker.js';
import { RowPickModal } from './RowPickModal.js';
import { SessionMirror } from './SessionMirror.js'
import { askTileCopy, useLiveTile, useWorkChip } from './liveTiles.js';
import { GLYPH, displayWidth } from '../mercury-ui/glyphs.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { ConcourseComposer } from './ConcourseStrips.js';
import {
  ConcourseLayout,
  resolveConcourseProfile,
  ROW_PEEK_DESIRED_ROWS,
  switchboardGeometry,
  type ConcourseRegion,
} from './ConcourseLayout.js';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { effectiveSeatCeiling } from '../../daemon/concourseSupervisor.js';
import { credentialWallLineForModel } from '../../services/providers/credentialWall.js';
import {
  collapseSplitForFrame,
  nudgeSplitRatio,
  splitAvailableAt,
  splitGeometryAt,
  splitViewOn,
  splitViewRatio,
  splitViewVersion,
  subscribeSplitView,
  toggleSplitView,
} from './splitView.js';
import { SplitChatPane } from './SplitChatPane.js';
import { hasFocusedSession, landingInFlight } from '../../services/engine-connector/focusedConnector.js';
import { isPathTrusted, setPathTrusted } from '../../utils/config.js';
import { clearPendingActivation, readPendingActivation } from '../../services/concourse/pendingActivation.js';
import { getCwd } from '../../utils/cwd.js';
import { EFFORT_LEVELS } from '../../utils/effort.js';
import { basename } from 'node:path';
import { GroundPicker } from './GroundPicker.js';

// ============================================================================
//  ConcourseScreen — the ONE semantic input owner over the
//  three-region switchboard compositor.
//
//  Input model:
//   · the COMPOSER is the default printable owner — typing anywhere types
//     into it (the focused-chat law); single-letter hotkeys fire only while
//     their region holds focus, and every firing key is advertised;
//   · Tab cycles composer → list → mirror → coordinator → rail;
//   · wheel scrolls the region under the pointer through the ONE geometry
//     owner — the list consumes here; the chat panes gate their own wheel
//     by bounds (IP-2); chrome scrolls nothing;
//   · ↵ on a list row ENTERS the session (IP-1 — retired); the
//     composer's ↵ sends (coordinator on) or launches (off);
//   · esc closes one layer (permission/answer context → filter) then exits
//     to the exact root REPL.
// ============================================================================

type ComposeContext =
  | { kind: 'chat' }
  | { kind: 'answer'; obligationId: string; title: string }
  /** THE BOARD'S RENAME (session-aware naming, L16): r on a session row —
   *  the composer collects the new title; ↵ stores it through the daemon's
   *  set-title door (source 'operator'). */
  | { kind: 'rename'; sessionId: string; title: string }
// THE L25 CUT: the retired 'contract-compose' context — the offer's Yes leg
// once routed the words to THIS composer, beneath whichever session's live
// view the board had selected, with nothing on screen saying the box had
// become the contract. The offer card owns its own field now (ledger L25:
// "it should then have a field saying, what is the contract?"); the live
// composer is never the door for a birth-time contract.
// THE L17 CUT: the retired 'permission'
// context — a session's parked ask was once answered y/n from the board.
// NO ANSWERING FROM THE BOARD: a needs-you row's ↵ ROUTES into the chat,
// where the consent card answers it (the one place); the board never
// carries an answer key. The folder-scoped git-init offer keeps its card
// (item 5 — no chat exists behind a folder ask).

interface ConcourseCapsuleV2 {
  region: ConcourseRegion
  filtering: boolean
  filter: LineDraft
  boardSel: string | null
  railSel: string | null
  boardScroll: number | null
  /** MANAGER MODE (ledger T7+T8): the coordinator composer's shift+tab
   *  mode survives a re-mount within the process; a fresh boot starts in
   *  chat mode (the main chat's own mode posture). */
  managerMode?: boolean
}
let presentationCapsule: ConcourseCapsuleV2 | null = null
export function _resetConcourseCapsuleForTesting(): void {
  presentationCapsule = null
}

/** THE LIVE COMPOSER'S GATE (the two-composers law; PURE — the pool pin
 *  drives every class): what the small box does for the SELECTED row — an
 *  accepting target (the placeholder names it; ↵ delivers through
 *  session.redirect — delivered instantly, read at that session's next
 *  readable moment, the delivery law) or a typed refusal line (the box
 *  accepts no text — nothing delivers where no session runs).
 *
 *  THE LOCK (item 6, the L17 scope cut): while the selected row has an
 *  OPEN ask the box reads "needs you · ↵↵ to answer" and accepts no text
 *  — ↵↵ enters the chat, the one place asks are answered (unchanged);
 *  when the ask settles the next snapshot beat unlocks it (this gate is
 *  derived, never stored). The rail's typed-answer context is the ask's
 *  own settle path and rides ABOVE this gate at the send — an answer is
 *  never "queued behind" the ask it settles.
 *
 *  THE CREDENTIAL WALL's row receipt (ledger L25, L23's inline arm): a
 *  row whose family the estate has observed walled — a dead sign-in, a
 *  reached key cap — refuses the send with the SAME line the transcript
 *  paints (credentialWall's one owner; the caller derives it per row, this
 *  gate only speaks it). It reads AFTER the row's own states: a parked or
 *  needs-you row keeps its own line. */
export function liveComposerGateOf(
  sel: ConcourseRowV1 | undefined,
  openAsk: boolean,
  region?: ConcourseRegion,
  credentialWall?: string,
): { ok: true; placeholder: string } | { ok: false; line: string } {
  if (sel === undefined) return { ok: false, line: 'no session selected — the coordinator panel starts one' }
  if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
    // THE PRESENT-MOVES NOTE (TASK-017 V3's region nuance): ↵ unfolds the
    // older list only where the key reaches the board — the list's own ↵
    // and the live box's empty-draft browse verb. The coordinator's ↵ is
    // owned by its zero-state example walk and its → by caret travel, so
    // the KEY cannot be generalized; the NOTE follows the region instead.
    // No region declared (delivery-time refusals) keeps the landed line.
    return {
      ok: false,
      line:
        region === undefined || region === 'list' || region === 'live'
          ? 'older chats — ↵ unfolds the list'
          : 'older chats — tab to the list, ↵ unfolds it',
    }
  }
  if (sel.door !== undefined) return { ok: false, line: 'a door — ↵ opens it; nothing to message' }
  // A queued reservation is the TYPED state, not only the live builder's
  // `dispatch:` id spelling — a fixture's plain-id queued row took words a
  // live queued row refuses (the gate-vs-fixture divergence).
  if (sel.sessionId.startsWith('dispatch:') || sel.state === 'queued') return { ok: false, line: 'queued — m stacks a message for its start' }
  if (sel.state === 'parked') return { ok: false, line: 'parked — ↵↵ brings it back; a sleeping chat takes no queue' }
  if (sel.state === 'attached') return { ok: false, line: 'with you — type in its own chat' }
  if (sel.state === 'stopped') return { ok: false, line: `stopped — nothing listens; ${keyHintLabel('⌃x ⌃x')} archives it` }
  if (sel.state === 'needs-you' || openAsk) return { ok: false, line: 'needs you · ↵↵ to answer' }
  if (credentialWall !== undefined) return { ok: false, line: credentialWall }
  return { ok: true, placeholder: `message ${sel.title} · queued for its next turn` }
}

/** THE BROADCAST FACE: with ≥2 MARKED rows on
 *  the board the live composer speaks to the marked set, not the selection —
 *  the placeholder names the count and the ↵↵ grammar (the first ↵ arms
 *  naming the count, the second sends), and the per-row gate moves to the
 *  delivery fan (item 3 — honest partial delivery decides row by row at the
 *  send). Fewer than 2 marks ⇒ null: the landed single-target gate stands
 *  whole. PURE — the pin drives both sides. */
export function broadcastFaceOf(markedOnBoard: number): { placeholder: string } | null {
  if (markedOnBoard < 2) return null
  return { placeholder: `message ${markedOnBoard} sessions · ↵↵ sends to all marked` }
}

/** The broadcast summary's one spelling (item 3): the honest arithmetic over
 *  the fan — K delivered of the N marked, the skips counted, never hidden
 *  (every marked row is exactly one of the two). PURE — the pin drives it. */
export function broadcastSummaryOf(sent: number, marked: number): string {
  return `sent to ${sent} of ${marked} · ${marked - sent} skipped`
}

/** THE SINGLE-PAINT LAW (AGENTDIALS C5, ruled at the parked sighting): a
 *  refusing gate's line paints ONCE — the BOTTOM hint (the composer's meta
 *  row) carries it as the STANDING fallback and the composer placeholder
 *  EMPTIES. Before this, the placeholder advertised the refusal AND a
 *  refused send left the same words in the note — the parked line twice,
 *  one above the other (the operator's screenshot). An explicit note (a
 *  send receipt, the broadcast summary) outranks the standing line; an OK
 *  gate is unchanged (the placeholder advertises the target, the note
 *  passes through). Every refusing class inherits — parked, door, queued,
 *  stopped, needs-you, the credential wall: one mechanism, one paint.
 *  PURE — the pin drives it. */
export function liveComposerPaintOf(
  gate: { ok: true; placeholder: string } | { ok: false; line: string },
  note: { tone: 'muted' | 'warning'; text: string } | null,
): { restHint: string; note: { tone: 'muted' | 'warning'; text: string } | null } {
  if (gate.ok) return { restHint: gate.placeholder, note }
  return { restHint: '', note: note ?? { tone: 'muted', text: gate.line } }
}

/** The panel-ring migration (the two-composers law): a capsule written by
 *  the strip-era screen may carry the retired region names — 'composer'
 *  was the strip (the coordinator's input), 'mirror' the bare live view. */
function migrateCapsuleRegion(region: string | undefined): ConcourseRegion | undefined {
  if (region === 'composer') return 'coordinator'
  if (region === 'mirror') return 'live'
  if (region === 'rail' || region === 'list' || region === 'live' || region === 'coordinator' || region === 'chat') return region
  return undefined
}

const NL = String.fromCharCode(10)

/** THE CLOSE CHORD's stage window, measured from the STOP dispatch (the
 *  operator's ruling: generous for the full ⌃x ⌃x repeat, not the old
 *  single-keypress 2 s): a second completed chord inside it reads REMOVE
 *  even while the snapshot still paints the pre-stop state — the bridge
 *  over the daemon round-trip. Past it, the row's own settled class
 *  carries the stage (a 'stopped' row's next completed chord removes). */
export const CLOSE_CHORD_STAGE_WINDOW_MS = 5000

export function ConcourseScreen({
  snapshot,
  callbacks,
  degraded = false,
  controlNotes,
  reducedStage = false,
}: {
  snapshot: ConcourseSnapshotV1
  callbacks: ConcourseCallbacks
  degraded?: boolean
  controlNotes?: Readonly<Record<string, import('./contracts.js').ControlNoteState>>
  /** THE REDUCED STAGE (Law 9, rule 5 — the concourse switched off): the
   *  plain live view of the sessions. The rows and the mirror keep their
   *  keys; the coordinator pane and its composer stand down — no draft, no
   *  dispatch, no region for them; the rail's answer verb opens the
   *  session (the consent card lives in the chat). */
  reducedStage?: boolean
}): React.ReactNode {
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const coordinatorOn = snapshot.coordinator.mode === 'agent-assisted'
  // THE STRIP'S KEY-MAP ROW on the reduced stage (STRIP's ruling B: the live
  // view is not a strip stop; only the moves that exist print) — the
  // router's own derivation, re-read when a stop appears or vanishes.
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const keyMapHint = stripKeyMapHint()
  // ── THE SPLIT FRAME (the split-view sheet): one view state of this stop —
  // the board keeps its lawful minimum on the left, the focused chat takes
  // the rest on the right. COMPOSITION IS DERIVED per frame (switch on ∧
  // full stage ∧ the FRAME affords — width AND rows, the rows
  // leg: a 130×23 frame must never paint the board pane's too-small refusal
  // inside a live split), so a narrow or short beat can never tear a
  // half-split before the collapse effect commits the store; every board
  // consumer below reads the EFFECTIVE frame (`cols` = the board pane), and
  // the board sits at the terminal's left edge, so the wheel router's and
  // the overlays' x-math hold unchanged. ─────────────────────────────────
  useSyncExternalStore(subscribeSplitView, splitViewVersion, splitViewVersion)
  const splitActive = !reducedStage && splitViewOn() && splitAvailableAt(termCols, termRows)
  const splitGeo = splitActive ? splitGeometryAt(termCols, splitViewRatio()) : null
  const cols = splitGeo !== null ? splitGeo.boardCols : termCols

  // ── filter (list lens) ─────────────────────────────────────────────────────
  const [filtering, setFiltering] = useState(presentationCapsule?.filtering ?? false)
  const [filter, setFilter] = useState<LineDraft>(presentationCapsule?.filter ?? { text: '', caret: 0 })
  // The esc ladder reads the ref (the batch law: a burst of escs in one
  // frame peels one layer each, reading its own truth).
  const filterRef = useRef(filter)
  filterRef.current = filter
  const editFilter = (op: (d: LineDraft) => LineDraft): void => setFilter(prev => op(prev))
  const boardGroups = useMemo(() => {
    const q = filter.text.trim().toLowerCase()
    if (q.length === 0) return snapshot.groups
    return snapshot.groups
      .map(g => ({
        ...g,
        rows: g.rows.filter(
          r => r.title.toLowerCase().includes(q) || r.projectLabel.toLowerCase().includes(q),
        ),
      }))
      .filter(g => g.rows.length > 0)
  }, [snapshot.groups, filter.text])
  const sessionRows: ConcourseRowV1[] = useMemo(() => boardGroups.flatMap(g => g.rows), [boardGroups])

  // ── regions (PANELS — L17 item 4; the coordinator composer is the
  //    arrival's printable owner, the live composer everywhere row-side) ─────
  const [region, setRegion] = useState<ConcourseRegion>(() =>
    reducedStage ? 'list' : (migrateCapsuleRegion(presentationCapsule?.region) ?? 'coordinator'),
  )
  // ── MANAGER MODE (coordinator-tooling ledger T7+T8; L22): the coordinator
  //    composer's shift+tab station — the main chat's mode-cycling gesture,
  //    scoped to the coordinator's REPL alone. The EFFECTIVE mode derives
  //    from the composer's EXISTENCE alone (the full stage): the reduced
  //    stage has no composer and never wears it, but the coordinator's own
  //    mode is not a gate — in the self-managed world the mode still runs
  //    (its turn on the composed coordinator model; the honest line names
  //    the pick when none is chosen). The old coordinatorOn gate left the
  //    operator's shift+tab falling to the ring's backward step. ──────────
  const [managerArmed, setManagerArmed] = useState<boolean>(() => presentationCapsule?.managerMode ?? false)
  const managerOn = managerArmed && !reducedStage
  const managerOnRef = useRef(managerOn)
  managerOnRef.current = managerOn
  const [helpOpen, setHelpOpen] = useState(false)
  const helpOpenRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  // The picker LIVED only inside the coordinator pane, and the stacked
  // profile's collapsed tail returns before its picker branch — so opening
  // from the rail chip below 120 columns latched settingsOpen with NO
  // picker anywhere while the screen swallowed every key (the audited
  // latch; law 3 — no state strands). Below 120 columns the picker now
  // mounts as a screen-level overlay (the GroundPicker grammar, sized to
  // the terminal instead of a 2–6 row band); the nested pane mount stays
  // the wide profile's face.
  //
  // THE WIDE TWIN of that latch (TASK-017 supplement, S1): the REDUCED
  // stage renders no coordinator pane, so at the wide profile neither
  // mount exists — ⌃s (or the rail chip) armed settingsOpen with no
  // picker anywhere and the modal-owner gate deadened every key, esc
  // included. The owner never arms on the reduced stage (closing is
  // always allowed), and the effect below disarms a strand that reaches
  // the state sideways (a resize mid-open, a stage flip).
  const openCoordinatorSettings = (): void => {
    setSettingsOpen(v => (v ? false : !reducedStage))
  }
  const closeCoordinatorSettings = (): void => {
    setSettingsOpen(false)
  }
  useEffect(() => {
    if (reducedStage && settingsOpen) setSettingsOpen(false)
  }, [reducedStage, settingsOpen])
  // Drive 6b (the ground law): the rail's PROJECT segment opens this — the
  // repo selector; picking re-grounds the whole harness live.
  const [groundPickerOpen, setGroundPickerOpen] = useState(false)
  const groundPickerOpenRef = useRef(false)
  groundPickerOpenRef.current = groundPickerOpen

  // ── rail selection ─────────────────────────────────────────────────────────
  const [railSel, setRailSel] = useState<string | null>(() => {
    // a needs-you toast
    // deep-links; entering the concourse preseeds the rail on the EXACT
    // obligation the operator tapped. Consume-on-use; unknown/stale targets
    // fall through to the ordinary seed.
    const pending = readPendingActivation()
    if (
      pending?.obligationId !== undefined &&
      snapshot.needsYou.some(o => o.obligationId === pending.obligationId)
    ) {
      clearPendingActivation()
      return pending.obligationId
    }
    return presentationCapsule?.railSel ?? snapshot.needsYou[0]?.obligationId ?? null
  })
  const railSelRef = useRef<string | null>(railSel)
  railSelRef.current = railSel
  const railLastIdxRef = useRef(0)
  useEffect(() => {
    const fb = stableSelectionFallback(
      snapshot.needsYou.map(o => o.obligationId),
      railSel,
      railLastIdxRef.current,
    )
    railLastIdxRef.current = fb.index
    if (fb.sessionId !== railSel) setRailSel(fb.sessionId)
  }, [snapshot.needsYou, railSel])
  const railIndex = Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSel))

  // ── board selection (stable id) + wheel window ────────────────────────────
  const [boardSel, setBoardSel] = useState<string | null>(
    () => presentationCapsule?.boardSel ?? sessionRows[0]?.sessionId ?? null,
  )
  const boardSelRef = useRef<string | null>(boardSel)
  boardSelRef.current = boardSel
  const lastIdxRef = useRef(0)
  useEffect(() => {
    const fb = stableSelectionFallback(sessionRows.map(r => r.sessionId), boardSel, lastIdxRef.current)
    lastIdxRef.current = fb.index
    if (fb.sessionId !== boardSel) setBoardSel(fb.sessionId)
  }, [sessionRows, boardSel])
  const [boardScroll, setBoardScroll] = useState<number | null>(presentationCapsule?.boardScroll ?? null)
  // Line 5 (expand in place): the row peek — `→` on the selected row opens
  // a taller live view IN the list band; the same key or esc collapses; ↵
  // still enters. A peek follows the selection (one open at a time) and is
  // a VIEW, never a hop — no focus change, no slot re-point. Fresh mounts
  // start collapsed (deliberately not capsule state).
  const [rowPeekOpen, setRowPeekOpen] = useState(false)
  const rowPeekOpenRef = useRef(false)
  rowPeekOpenRef.current = rowPeekOpen
  // ITEM 7 (L20): the older-chats DROP-DOWN — ↵ on the census line unfolds
  // the enumerable older chats IN PLACE (the board keeps the frame): ↑↓
  // choose inside it, ↵ reactivates the pick through the ONE resume door,
  // esc (or a selection move off the line) folds it back to the line. The
  // entries are read ONCE at the unfold — an event, never a render read —
  // and the census owner guarantees the line's N is this very list.
  const [olderList, setOlderList] = useState<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  const olderListRef = useRef<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  olderListRef.current = olderList
  const unfoldOlderList = (row: ConcourseRowV1): void => {
    const projectDir = row.sessionId.slice(OLDER_CHATS_ROW_PREFIX.length)
    // The exclusion set is the board's own: every REAL session the board
    // paints (records and painted parked rows) — doors, held launches and
    // the line itself are not files.
    const excluded = new Set(
      snapshot.groups
        .flatMap(g => g.rows)
        .filter(r => r.door === undefined && !r.sessionId.startsWith('dispatch:') && !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
        .map(r => r.sessionId),
    )
    // The week-tier's own budget bounds the LIST (the tail stays honest);
    // the count is the census's, unbounded.
    const census = olderChatsCensus(projectDir, excluded, Date.now(), { entryCap: PARKED_CAP })
    // THE ZERO-ROW ARM REFUSED AT THE DOOR: at the
    // wide profile's own minimum height the granted-rows channel can answer
    // 0 — the drop-down would arm INVISIBLY while olderNavConsumed eats ↑↓
    // (browse grammar on screen, nothing painted, arrows dead). Probe the
    // WOULD-BE geometry (the same pure call the geo memo makes, with the
    // would-be ask) and refuse with the honest line instead of arming.
    const wouldAsk = Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, census.entries.length + 1))
    const wouldGrant = switchboardGeometry(
      cols,
      termRows,
      snapshot.needsYou.length,
      sessionRows.length,
      boardGroupCount,
      liveDraftDesired,
      focusTall,
      wouldAsk,
    ).peekRows
    if (wouldGrant < 2) {
      setNote({ tone: 'muted', text: `no room to unfold the older chats — this height gives the list ${wouldGrant} row${wouldGrant === 1 ? '' : 's'}, it needs 2` })
      return
    }
    setRowPeekOpen(false)
    setOlderList({ entries: census.entries, total: census.total, at: 0 })
  }
  // The list is a VIEW on the selected line: the selection moving off it
  // folds it (a click on another row included — mouse parity).
  useEffect(() => {
    if (olderList !== null && (boardSel === null || !boardSel.startsWith(OLDER_CHATS_ROW_PREFIX))) setOlderList(null)
  }, [boardSel, olderList])
  // ARM-THEN-ENTER (L17 item 2): a session row's FIRST ↵ arms it as the
  // live composer's target — the row shows the arm, typing messages it —
  // and a second ↵ (or →) enters; esc disarms. The arm belongs to its row:
  // a selection move disarms (the live composer always speaks to the
  // SELECTED chat — the operator's own words), so armed ⇒ armed === the
  // selection, always. Pointer clicks keep the landed select-then-enter
  // (the first click's selection already shows the target).
  const [boardArmed, setBoardArmed] = useState<string | null>(null)
  const boardArmedRef = useRef<string | null>(null)
  boardArmedRef.current = boardArmed
  useEffect(() => {
    if (boardArmed !== null && boardSel !== boardArmed) setBoardArmed(null)
  }, [boardSel, boardArmed])
  // THE BROADCAST MARKS: space on the selected
  // row toggles its mark — SCREEN state beside the arm, never the capsule
  // and never a record fact (the marks die with the view); esc clears them
  // all as its own layer, and a project switch clears them too (item 5 —
  // the view changed under them). The set holds sessionIds; every count
  // that speaks is the INTERSECTION with the rows on the board, so an id
  // whose row left the board is inert, never a phantom target.
  const [markedIds, setMarkedIds] = useState<ReadonlySet<string>>(() => new Set())
  const markedIdsRef = useRef<ReadonlySet<string>>(markedIds)
  markedIdsRef.current = markedIds
  const markedRows = useMemo(() => sessionRows.filter(r => markedIds.has(r.sessionId)), [sessionRows, markedIds])
  const markedRowsOf = (): ConcourseRowV1[] => sessionRows.filter(r => markedIdsRef.current.has(r.sessionId))
  const toggleMark = (sessionId: string): void => {
    setMarkedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }
  // Item 5: marks clear on project switch — the snapshot's own project word
  // is the signal (the board rebuilt under a new ground; every switch door
  // — the picker, a switch-project row, a foreign ping — lands here).
  const markProjectRef = useRef(snapshot.context.projectLabel)
  useEffect(() => {
    if (markProjectRef.current === snapshot.context.projectLabel) return
    markProjectRef.current = snapshot.context.projectLabel
    setMarkedIds(new Set())
  }, [snapshot.context.projectLabel])
  // BOARD CONTROLS item 1 (`m` / `e` on a live row): the row pick modal —
  // the session-arm MODEL picker and the shared-ladder EFFORT picker share
  // one declared modal grammar; while open it owns the keys (the
  // ground-picker grammar). Holds the target so a selection move mid-pick
  // never re-aims the switch.
  const [rowPick, setRowPick] = useState<{ kind: 'model' | 'effort'; sessionId: string; title: string } | null>(null)
  const rowPickRef = useRef<{ kind: 'model' | 'effort'; sessionId: string; title: string } | null>(null)
  rowPickRef.current = rowPick
  const selectSession = (sessionId: string): void => {
    if (sessionId === boardSelRef.current) return
    boardSelRef.current = sessionId
    setBoardSel(sessionId)
    setBoardScroll(null)
    callbacks.peekSession(sessionId)
  }

  // ── the composer (multiline lineDraft + undo + durable coordinator draft) ─
  const [draft, setDraft] = useState<LineDraft>({ text: '', caret: 0 })
  const draftRef = useRef<LineDraft>(draft)
  draftRef.current = draft
  const draftEditedRef = useRef(false)
  const undoRef = useRef(newDraftUndo())
  const editDraft = (op: (d: LineDraft) => LineDraft): void => {
    draftEditedRef.current = true
    draftRef.current = op(draftRef.current)
    setDraft(draftRef.current)
  }
  useEffect(() => {
    let cancelled = false
    void readCoordinatorComposerDraft().then(d => {
      if (!cancelled && !draftEditedRef.current && d.text.length > 0) {
        draftRef.current = { text: d.text, caret: d.caret }
        setDraft(draftRef.current)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  // The wipe fence (SPEED-composer-draft-wiped-mid-type): the
  // composer's own persistence must never echo back as a clear. Two guards:
  // pendingOwnWritesRef counts THIS component's in-flight writes (a foreign
  // emission observed before the first write commits carries an empty slot
  // that is not a consume), and the store's cause channel separates this
  // runtime's commits ('local-commit') from a real foreign consume.
  const pendingOwnWritesRef = useRef(0)
  const persistDraft = (text: string, caret: number): void => {
    pendingOwnWritesRef.current += 1
    void writeCoordinatorComposerDraft(text, caret).finally(() => {
      pendingOwnWritesRef.current = Math.max(0, pendingOwnWritesRef.current - 1)
    })
  }
  useEffect(() => {
    if (!draftEditedRef.current) return
    persistDraft(draft.text, draft.caret)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.text, draft.caret])
  useEffect(() => {
    // D2: an
    // EXTERNAL store clear beats the local echo. A foreign process that
    // consumed this draft (the same dispatch settled elsewhere) empties the
    // durable slot; the composer must yield to that truth instead of
    // re-offering a submitted draft. Foreign NON-empty text never wins —
    // while typing, the local echo is the truth. The emission carries value
    // + cause, so no re-read can race a co-tenant field's commit into a
    // false empty (the audited mid-type wipe).
    const unsub = subscribeCoordinatorDraftChanges(change => {
      if (change.cause === 'local-commit') return
      if (pendingOwnWritesRef.current > 0) return
      if (change.text === '' && draftRef.current.text !== '') {
        draftRef.current = { text: '', caret: 0 }
        setDraft(draftRef.current)
        undoRef.current = newDraftUndo()
      }
    })
    return unsub
  }, [])

  // ── THE LIVE COMPOSER's draft (the two-composers law): words to the
  //    SELECTED row — ephemeral by design (steering text, not a task brief;
  //    the durable slot belongs to the coordinator/launcher draft above). ───
  const [liveDraft, setLiveDraft] = useState<LineDraft>({ text: '', caret: 0 })
  const liveDraftRef = useRef<LineDraft>(liveDraft)
  liveDraftRef.current = liveDraft
  const liveUndoRef = useRef(newDraftUndo())
  const editLiveDraft = (op: (d: LineDraft) => LineDraft): void => {
    liveDraftRef.current = op(liveDraftRef.current)
    setLiveDraft(liveDraftRef.current)
  }
  const clearLiveDraft = (): void => {
    liveDraftRef.current = { text: '', caret: 0 }
    setLiveDraft(liveDraftRef.current)
    liveUndoRef.current = newDraftUndo()
  }
  // THE BROADCAST ARM (the ↵↵ send): the first ↵
  // on a composed draft arms the fan — the derived context line names the
  // count — and the second sends. A transient confirm, honest by
  // derivation: editing the words or the marked set disarms it (what was
  // named must be what sends); esc cancels it as its own layer.
  const [broadcastArmed, setBroadcastArmed] = useState(false)
  const broadcastArmedRef = useRef(false)
  broadcastArmedRef.current = broadcastArmed
  useEffect(() => {
    if (broadcastArmedRef.current) setBroadcastArmed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDraft.text, markedIds])

  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<{ tone: 'muted' | 'warning'; text: string } | null>(null)
  const [liveNote, setLiveNote] = useState<{ tone: 'muted' | 'warning'; text: string } | null>(null)
  const [composeContext, setComposeContext] = useState<ComposeContext>({ kind: 'chat' })
  const composeContextRef = useRef<ComposeContext>(composeContext)
  composeContextRef.current = composeContext
  const sendIdRef = useRef<{ text: string; id: string } | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const clearDraft = (): void => {
    sendIdRef.current = null
    draftRef.current = { text: '', caret: 0 }
    setDraft(draftRef.current)
    undoRef.current = newDraftUndo()
    persistDraft('', 0)
  }

  // THE CREDENTIAL WALL's row receipt (ledger L25, L23's inline arm): per
  // snapshot beat, the wall line for every row whose family the estate has
  // observed walled — derived from observed facts (never a probe), never
  // stored; the gate below speaks it, the broadcast fan skips with it.
  const wallLineBySession = useMemo(() => {
    const lines = new Map<string, string>()
    for (const row of sessionRows) {
      const line = credentialWallLineForModel(row.modelId)
      if (line !== undefined) lines.set(row.sessionId, line)
    }
    return lines
  }, [sessionRows])
  const liveComposerGate = (
    sel: ConcourseRowV1 | undefined,
    noteRegion?: ConcourseRegion,
  ): { ok: true; placeholder: string } | { ok: false; line: string } =>
    liveComposerGateOf(
      sel,
      sel !== undefined && snapshot.needsYou.some(o => o.sessionId === sel.sessionId),
      noteRegion,
      sel !== undefined ? wallLineBySession.get(sel.sessionId) : undefined,
    )

  // THE LIVE SEND: the answer/rename contexts are their own delivery
  // (the ask's settle path — never a queue behind it); plain words ride
  // the steering door to the gated target.
  const sendLive = (): void => {
    if (reducedStage) return
    const ctx = composeContextRef.current
    const text = liveDraftRef.current.text.trim()
    if (text.length === 0) return
    if (ctx.kind === 'answer') {
      callbacks.answerObligation(ctx.obligationId, text)
      clearLiveDraft()
      setComposeContext({ kind: 'chat' })
      return
    }
    if (ctx.kind === 'rename') {
      callbacks.renameSession?.(ctx.sessionId, text)
      clearLiveDraft()
      setComposeContext({ kind: 'chat' })
      return
    }
    // THE BROADCAST SEND: with ≥2 marked
    // rows the composer speaks to the MARKED SET — the first ↵ arms naming
    // the count (the derived context line), the second fans ONE message
    // through the SAME steering door the single send uses, row by row in
    // board order. NO new daemon verb: N deliveries of session.redirect.
    // The ONE gate decides each row AT the send (item 3 — honest partial
    // delivery): a refusing class is SKIPPED with the gate's own typed line
    // on its row receipt — the needs-you lock always wins (item 4; asks are
    // answered in the chat, never by broadcast — the answer context above
    // is the ask's own settle path and never reaches this fan), a parked
    // chat is never force-woken — and a delivered row paints its receipt.
    // The summary line is the honest arithmetic.
    const marked = markedRowsOf()
    if (marked.length >= 2) {
      if (!broadcastArmedRef.current) {
        broadcastArmedRef.current = true
        setBroadcastArmed(true)
        return
      }
      broadcastArmedRef.current = false
      setBroadcastArmed(false)
      let sent = 0
      for (const row of marked) {
        const rowGate = liveComposerGate(row)
        if (rowGate.ok) {
          callbacks.redirectSession(row.sessionId, text)
          callbacks.noteControl?.(`board:row-control:${row.sessionId}`, {
            state: 'applied',
            reason: 'broadcast sent — queued for its next turn',
          })
          sent += 1
        } else {
          callbacks.noteControl?.(`board:row-control:${row.sessionId}`, {
            state: 'refused',
            reason: `skipped — ${rowGate.line}`,
          })
        }
      }
      setLiveNote({ tone: sent > 0 ? 'muted' : 'warning', text: broadcastSummaryOf(sent, marked.length) })
      clearLiveDraft()
      return
    }
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    const gate = liveComposerGate(sel)
    if (!gate.ok) {
      setLiveNote({ tone: 'muted', text: gate.line })
      return
    }
    callbacks.redirectSession(sel!.sessionId, text)
    clearLiveDraft()
  }

  const sendCoordinator = (): void => {
    if (reducedStage) return
    const text = draftRef.current.text.trim()
    if (text.length === 0 || pending) return
    // Operator live-drive finding 3: /clear and /compact are REAL commands
    // — handled client-side, never sent to the model (which once answered
    // "Cleared" without clearing: a fabricated state change).
    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0]!.toLowerCase()
      if (cmd === '/clear') {
        clearDraft()
        void import('../../services/concourse/coordinatorConversation.js')
          .then(m => m.clearCoordinatorConversation())
          .then(() => setNote({ tone: 'muted', text: 'cleared — fresh slate' }))
          .catch(() => setNote({ tone: 'warning', text: 'clear failed — the conversation store was unreadable' }))
        return
      }
      if (cmd === '/compact') {
        clearDraft()
        // Summarize-in-place (chat-relief): the fold writes a REAL summary
        // through the composed coordinator model — a model call, so the
        // note names the work while it runs and the outcome when it lands.
        setNote({ tone: 'muted', text: 'compacting — summarizing the older turns…' })
        void import('../../services/concourse/coordinatorCompact.js')
          .then(m => m.summarizeCoordinatorConversation())
          .then(r =>
            setNote(
              r.refused !== undefined
                ? { tone: 'warning', text: r.refused.slice(0, 160) }
                : {
                    tone: 'muted',
                    text:
                      r.compacted > 0
                        ? `compacted ${r.compacted} earlier turn${r.compacted === 1 ? '' : 's'} into a summary`
                        : 'nothing to compact yet',
                  },
            ),
          )
          .catch(e => setNote({ tone: 'warning', text: `compact failed — ${String(e).slice(0, 120)}` }))
        return
      }
      setNote({ tone: 'muted', text: 'plain words here — /clear and /compact are the only composer commands' })
      return
    }
    if (!coordinatorOn && !managerOnRef.current) {
      // THE SEAT-OVERLOAD ASK (item 4, operator-ruled): dispatching past
      // the machine reading is a consent card EVERY TIME — never a silent
      // queue, never remembered-away (the gate is pure and stores
      // nothing). Declining dispatches NOTHING: no op fires, the draft
      // stays exactly where it is.
      if (needsSeatOverloadAsk(snapshot.counts.live, effectiveSeatCeiling())) {
        setSeatAsk({ text, live: snapshot.counts.live, ceiling: effectiveSeatCeiling() })
        return
      }
      // Q1 (operator-answered): coordinator off ⇒ the composer launches a
      // session directly — the text is its task and its title. The lane
      // door still records the operator entry + the ONE-TIME hint in
      // the chat (its off-branch returns 'self-managed-launch' without a
      // model turn); the dispatch itself rides the route's submit.
      void callbacks.sendCoordinatorMessage?.(text).catch(() => {})
      callbacks.submitSessionDraft(text)
      clearDraft()
      return
    }
    const door = callbacks.sendCoordinatorMessage
    if (door === undefined) {
      setNote({ tone: 'warning', text: 'send unavailable — the coordinator lane has no delivery door here' })
      return
    }
    const sendThroughDoor = (): void => {
      setPending(true)
      setNote(null)
      // AT-07: the minted identity is reused ONLY while its send is unsettled
      // (a retry after a failed send replays the same durable entry). A send
      // that settled retires it — the same words typed again are a FRESH ask,
      // never a replay (the lane dedupes by id; a kept id swallowed a repeated
      // "status?" as 'already coordinated' with no reply at all).
      const minted = sendIdRef.current
      const clientMessageId =
        minted !== null && minted.text === text
          ? minted.id
          : `coord-ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      sendIdRef.current = { text, id: clientMessageId }
      let accepted = false
      const acceptedClear = (): void => {
        if (!aliveRef.current) return
        accepted = true
        clearDraft()
      }
      void door(text, clientMessageId, acceptedClear, managerOnRef.current ? { manager: true } : undefined)
        .then(() => {
          if (sendIdRef.current?.id === clientMessageId) sendIdRef.current = null
          // Belt-and-braces for a door that never signalled acceptance; an
          // accepted send already cleared, and whatever the operator typed
          // while the turn ran is their NEXT ask — never wiped here.
          if (aliveRef.current && !accepted) acceptedClear()
        })
        .catch((e: unknown) => {
          if (!aliveRef.current) return
          if (accepted) {
            sendIdRef.current = { text, id: clientMessageId }
            draftRef.current = { text, caret: text.length }
            setDraft(draftRef.current)
            persistDraft(text, text.length)
          }
          const raw = String(e)
          const reason =
            raw.includes('ENOENT') || raw.includes('ECONNREFUSED')
              ? 'the daemon that hosts background sessions is not running'
              : raw.slice(0, 70)
          setNote({ tone: 'warning', text: `send failed — ${reason}; your draft is kept · ↵ retries` })
        })
        .finally(() => {
          if (aliveRef.current) setPending(false)
        })
    }
    if (!coordinatorOn) {
      // MANAGER MODE in the self-managed world (L22): the words are the
      // manager's GOAL, never a direct launch; its turn needs a model, so
      // the pick is read before the send — none chosen ⇒ the note names
      // the pick and the draft stays exactly where it is (never a silent
      // no-op, never a session launched in the mode's name). The lane
      // door re-reads the same pick behind this (its own honest row).
      void import('../../services/concourse/managerMode.js')
        .then(m => m.resolveManagerModel())
        .then(model => {
          if (!aliveRef.current) return
          if (!model.ok) {
            setNote({ tone: 'warning', text: model.line })
            return
          }
          sendThroughDoor()
        })
        .catch(() => {
          if (aliveRef.current) {
            setNote({ tone: 'warning', text: 'send failed — the coordinator model registry was unreadable; your draft is kept · ↵ retries' })
          }
        })
      return
    }
    sendThroughDoor()
  }

  // THE HONEST FIRST LINE (L22): arming manager mode where the coordinator is
  // not agent-assisted reads the manager's model at once — with none chosen
  // the composer's note names the pick before a goal is even typed; with
  // one chosen it names the model the manager runs on (the rail says
  // "coordinator off", so nothing else on the board would). Disarming
  // clears the line.
  const noteManagerModel = (arming: boolean): void => {
    if (!arming) {
      setNote(null)
      return
    }
    void import('../../services/concourse/managerMode.js')
      .then(m => m.resolveManagerModel())
      .then(model => {
        if (!aliveRef.current) return
        setNote(model.ok ? { tone: 'muted', text: `manager mode runs on ${model.label}` } : { tone: 'warning', text: model.line })
      })
      .catch(() => {
        /* the send re-reads the pick and speaks for itself */
      })
  }

  // The chord declines wherever the plain board does not own the keys: a
  // standing consent surface (the one modal owner — read at INVOKE time
  // from the same refs the key handler consults), the daemon offer, the
  // help atlas, the too-small stage, or the filter editor mid-edit. The
  // refs are declared below this point; the closure binds them at call
  // time, and the slot dispatches only after the body has run whole.
  const closeChordBlocked = (): boolean =>
    callbacks.daemonOfferArmed?.() === true ||
    helpOpenRef.current ||
    filtering ||
    resolveConcourseProfile(cols, termRows) === 'too-small' ||
    boardModalOwner({
      capacityAsk: capacityAskRef.current,
      trustAsk: trustAskRef.current !== null,
      settingsOpen: settingsOpenRef.current,
      groundPickerOpen: groundPickerOpenRef.current,
      rowPick: rowPickRef.current !== null,
      seatAsk: seatAskRef.current !== null,
      gitOffer: gitOfferRef.current !== undefined,
      contractAsk: contractAskRef.current,
      managerSeatAsk: managerSeatAskRef.current !== null,
      managerCardArmed: managerCardArmedRef.current,
      coordinatorFocused: region === 'coordinator',
    }) !== null

  // FN-017 R1: the owner FACTS for the pointer doors, read at click time
  // from the same refs the key handler and the close chord consult (the
  // refs are declared below; the closure binds them at call time).
  const modalFactsNow = (): BoardModalFactsV1 => ({
    capacityAsk: capacityAskRef.current,
    trustAsk: trustAskRef.current !== null,
    settingsOpen: settingsOpenRef.current,
    groundPickerOpen: groundPickerOpenRef.current,
    rowPick: rowPickRef.current !== null,
    seatAsk: seatAskRef.current !== null,
    gitOffer: gitOfferRef.current !== undefined,
    contractAsk: contractAskRef.current,
    managerSeatAsk: managerSeatAskRef.current !== null,
    managerCardArmed: managerCardArmedRef.current,
    coordinatorFocused: region === 'coordinator',
    helpOpen: helpOpenRef.current,
  })

  // THE CLOSE CHORD (the operator's word): the board's close verb is
  // ⌃x ⌃x — a completion of the app-wide chord leader, dispatched from the
  // REPL world's interceptor through the one-slot seam (listener order: the
  // parked REPL's chord machinery consumes every ctrl+x even while this
  // board covers it, so no handler here could see the raw key). Plain x is
  // TYPING everywhere on the board — a bare printable can never be a board
  // control while any composer is live; the operator's own close-press
  // landed in a live chat.
  //
  // STAGED exactly as the retired x estate (the operator's overrule: the
  // old behavior was good — only the input mapping changes): on a running
  // row the first completed chord STOPS — the row stays, wearing 'stopped'
  // and the advertised next step; the SAME gesture again REMOVES. A queued
  // row withdraws on one completed chord; a parked row says nothing runs,
  // then clears; doors and the older line refuse in their own words. The
  // stage window (from the stop dispatch, generous for the full repeat
  // gesture) bridges the daemon round-trip — a rapid second chord must
  // read REMOVE before the snapshot repaints 'stopped'; past the window
  // the row's own settled class carries the stage.
  const lastStopRef = useRef<{ sessionId: string; at: number } | null>(null)
  const closeChordGesture = (): void => {
    if (closeChordBlocked()) return
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    if (!sel) return
    if (sel.sessionId.startsWith('dispatch:')) {
      // A QUEUED row is a held reservation — one completed chord withdraws
      // it outright (resending recreates it).
      callbacks.removeSession?.(sel.sessionId)
      return
    }
    if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      // The older line is a door, not a chat: nothing to stop, nothing to
      // clear as a pile — the chats behind it clear one at a time.
      setNote({ tone: 'muted', text: 'the older chats stay — ↵ opens them; clear one at a time from there' })
      return
    }
    if (sel.door !== undefined) {
      // A door row runs nothing: the chord has nothing to close; ↵ is its verb.
      setNote({
        tone: 'muted',
        text:
          sel.door.kind === 'switch-project'
            ? `a door — ↵ switches the board to ${sel.projectLabel}; nothing to close here`
            : 'a door — ↵ opens the repo picker; nothing to close here',
      })
      return
    }
    const prior = lastStopRef.current
    const staged = prior !== null && prior.sessionId === sel.sessionId && Date.now() - prior.at < CLOSE_CHORD_STAGE_WINDOW_MS
    if (sel.state === 'parked') {
      // THE DELETE RUNG (the ladder's third): a parked row IS the archive —
      // the record stands, the chat survives (↵ brings it back). A chord
      // inside the stage window (the archive's own, or a first chord's
      // receipt on a long-parked row) DELETES it: the record ends; the
      // transcript survives on disk. A first chord on a long-parked row
      // says so and arms.
      if (staged) {
        lastStopRef.current = null
        callbacks.removeSession?.(sel.sessionId)
        return
      }
      lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }
      setNote({ tone: 'muted', text: `archived — the chat stands parked · ${keyHintLabel('⌃x ⌃x')} again deletes it (the record ends; the transcript survives on disk)` })
      return
    }
    if (sel.state === 'stopped') {
      // THE ARCHIVE RUNG (the ladder's second): a row settled 'stopped' —
      // its runner is gone (the record reads stopped on the runner's
      // acknowledgement, never on the kill's dispatch) — PARKS: the record
      // stands on the board (↵ brings it back; ⇧→ may still enter it) until
      // the third chord deletes it. The stage window opens here so the next
      // completed chord is that delete.
      lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }
      callbacks.archiveSession?.(sel.sessionId)
      return
    }
    if (staged) {
      // A standing stop receipt over a row that does not read stopped yet:
      // the runner is still going down (or the kill never reached it). The
      // chord never removes a running session — it says where the stop
      // stands, and re-sends it (the verb re-kills; the request's stamp
      // stands). The removal offer arrives with the row's own stopped state.
      setNote({ tone: 'muted', text: `stop is on its way — the row reads stopped once its runner is gone; ${keyHintLabel('⌃x ⌃x')} then archives it` })
      callbacks.stopSession?.(sel.sessionId)
      return
    }
    // THE STOP STAGE: the runner stops, the record settles, the ROW STAYS —
    // wearing 'stopped' and the advertised next step (the route's receipt:
    // 'stopped — ⌃x ⌃x archives it').
    lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }
    callbacks.stopSession?.(sel.sessionId)
  }
  // The slot claim: one stable dispatcher for the screen's lifetime, the
  // fresh closure behind a ref (the useKeybinding handlerRef discipline);
  // React's own unmount cleanup releases the claim, so a dead board can
  // never leave a live close verb behind.
  const closeChordRoutineRef = useRef(closeChordGesture)
  closeChordRoutineRef.current = closeChordGesture
  useEffect(() => claimConcourseCloseChord(() => closeChordRoutineRef.current()), [])

  // BOARD CONTROLS item 1: the row controls (i · p · m) act on the selected
  // LIVE-runner row only — every other selection answers its honest reason
  // in the row's receipt slot, never a silent dead key. ONE classifier with
  // the legend (boardSelectionClassOf — the present-moves law's own fold).
  const rowControlSel = (): { row?: ConcourseRowV1; reason?: string } => {
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    switch (boardSelectionClassOf(sel)) {
      case 'live':
      case 'paused':
        return { row: sel as ConcourseRowV1 }
      case 'parked':
        return { reason: 'parked · ↵ brings it back' }
      case 'queued':
        return { reason: `queued — not running yet · m queues a message · ${keyHintLabel('⌃x ⌃x')} withdraws` }
      case 'attached':
        return { reason: 'with you — its own chat carries the controls' }
      case 'stopped':
        return { reason: `stopped — ${keyHintLabel('⌃x ⌃x')} archives it` }
      case 'door':
        return { reason: 'a door — ↵ is its move' }
      case 'none':
        return { reason: 'no session selected' }
    }
  }
  const rowControlRefused = (reason: string): void => {
    // The receipt is keyed BY ROW (board:row-control:<sid>) so a moved
    // selection never wears another row's receipt — it paints under its own
    // row exactly while that row is selected.
    callbacks.noteControl?.(`board:row-control:${boardSelRef.current ?? 'none'}`, { state: 'refused', reason })
  }

  // ── enter (the one-terminal full swap) ────────────────────────────────────
  const enterSession = (sessionId: string, opts: { pointer?: boolean } = {}): void => {
    // ITEM 7 (L20): the older line's ↵ UNFOLDS the census in place; with
    // the list open the same key reactivates the chosen chat through the
    // one resume door. Never a route change from the line itself.
    if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      const open = olderListRef.current
      if (open === null) {
        const row = sessionRows.find(r => r.sessionId === sessionId)
        if (row !== undefined) unfoldOlderList(row)
        return
      }
      const pick = open.entries[Math.max(0, Math.min(open.entries.length - 1, open.at))]
      if (pick === undefined) {
        setOlderList(null)
        return
      }
      if (callbacks.resumeOlderChat === undefined) {
        setNote({ tone: 'muted', text: 'no resume door on this stage — /resume from the boot face lists everything' })
        return
      }
      setOlderList(null)
      callbacks.resumeOlderChat(pick.sessionId, pick.transcriptPath, pick.title)
      return
    }
    // Item 5 (the queued-void ruling): ↵ on a QUEUED row opens NO screen —
    // the board says it IN PLACE, one line, a disclaimer in the estate's
    // voice. The deliver-on-start room stays reachable EXPLICITLY ('m' on
    // the row · the rail's 'open session'), never as the default ↵.
    if (sessionId.startsWith('dispatch:')) {
      const row = sessionRows.find(r => r.sessionId === sessionId)
      const line =
        row?.waitReason === undefined || row.waitReason === 'seat'
          ? `queued — waits for a seat · ${snapshot.counts.live}/${effectiveSeatCeiling()} seats busy`
          : `queued — ${concourseWaitCopy(row.waitReason, row.waitDetail)}`
      setNote({ tone: 'muted', text: `${line} · m queues a message` })
      return
    }
    // THE RUNNING-COUNT LINE IS A DOOR (cross-project awareness, law 4): ↵
    // on an OTHER PROJECTS row switches the VIEW to that project through
    // the SAME path the REPO picker rides (pickGround — the trust gate
    // included; never a second switcher), and its sessions appear as the
    // live rows they always were. The "+N more" row opens the picker itself.
    const door = sessionRows.find(r => r.sessionId === sessionId)?.door
    if (door !== undefined) {
      if (door.kind === 'switch-project') pickGround(door.dir)
      else setGroundPickerOpen(true)
      return
    }
    // ARM-THEN-ENTER (L17 item 2): a SESSION row's first keyboard ↵ ARMS
    // it as the live composer's target (the row says so; tab reaches the
    // composer); the second ↵ enters. Doors, the older line and held launches keep
    // their one-press grammar above; a pointer activate and the reduced
    // stage (no composer to target) enter directly.
    if (!reducedStage && opts.pointer !== true && boardArmedRef.current !== sessionId) {
      boardArmedRef.current = sessionId
      setBoardArmed(sessionId)
      return
    }
    boardArmedRef.current = null
    setBoardArmed(null)
    // The session started at boot enters like any other row: the route
    // re-points the focused slot at its engine and shows the chat.
    callbacks.enterSession(sessionId)
  }

  // ── the git offer (items 1–3): the coordinator's own ask paints as the
  // STANDARD consent card INSIDE the coordinator pane, at the bottom — the
  // mini-REPL. Derived from the oldest open git-init permission obligation;
  // the card unmounts when the obligation settles (the store bump repaints
  // within a beat). The rail keeps its row as a MENTION.
  // The ruled No-leg's split fact rides the offer (board controls item 5):
  // the board's own claim fold says whether the folder is held at paint —
  // the card's No leg tells that state's truth.
  const gitOffer = useMemo<GitOfferV1 | undefined>(() => {
    const derived = deriveGitOffer(snapshot.needsYou)
    return derived !== undefined ? { ...derived, folderHeld: gitOfferFolderHeld(snapshot, derived.folder) } : undefined
  }, [snapshot])
  const gitOfferRef = useRef<GitOfferV1 | undefined>(gitOffer)
  gitOfferRef.current = gitOffer

  // ── THE CROSS-PROJECT PING IS A DOOR (cross-project awareness, law 5) ──
  // A need raised by a session of ANOTHER project: ↵ (and o) on its rail
  // row switches the view to that project through the picker's own apply
  // AND opens the session — the hop the route already owns; a finished-
  // elsewhere need settles there (once per need). The trust ledger stays
  // the gate: an untrusted folder is never chdir'd silently — the chat
  // still opens (a daemon session carries its own ground), the note says
  // where the view stayed and how to trust the folder.
  const takeObligationDoor = (o: ConcourseSnapshotV1['needsYou'][number]): void => {
    const home = o.foreignProject
    if (home !== undefined) {
      if (isPathTrusted(home.dir)) applyGround(home.dir)
      else
        setNote({
          tone: 'muted',
          text: `kept on ${basename(getCwd()) || getCwd()} — ${home.name} stays untrusted ${keyHintLabel('(⌃g trusts it)')} · opening the chat anyway`,
        })
    }
    callbacks.openObligation(o.obligationId)
  }
  const openObligationOrDoor = (obligationId: string): void => {
    const o = snapshot.needsYou.find(x => x.obligationId === obligationId)
    if (o !== undefined && o.foreignProject !== undefined) takeObligationDoor(o)
    else callbacks.openObligation(obligationId)
  }

  // ── obligations: answer & resume / permission y-n (Q2) ────────────────────
  const beginAnswer = (obligationId: string): void => {
    const o = snapshot.needsYou.find(x => x.obligationId === obligationId)
    if (!o) return
    if (o.foreignProject !== undefined) {
      // The door: switch + open — the answer, when there is one, is typed
      // in the chat it opens.
      takeObligationDoor(o)
      return
    }
    if (reducedStage) {
      // No composer to answer through: the session's own chat carries the
      // ask (its consent card) — enter it.
      callbacks.openObligation(obligationId)
      return
    }
    const ref = o.ref ?? ''
    if (ref.startsWith('kernel:capacity:')) {
      // Operator fix 3: a refused-launch row re-arms the KEPT
      // draft — the answer flow made no sense for a dead reservation (it
      // delivered the text into the focused chat).
      setRegion('coordinator')
      setNote({
        tone: 'muted',
        text: `the draft is kept — edit it and ↵ resends · ${keyHintLabel('⌃x ⌃x')} on the queued row withdraws it`,
      })
      return
    }
    if (ref.startsWith('permission:git-init:')) {
      // Items 1–3: the git offer's answering surface IS the standard card
      // in the coordinator pane — 'answer & resume' focuses it (the strip's
      // y/n context retired for this ask; the card owns the keys).
      setRegion('coordinator')
      return
    }
    if (ref.startsWith('permission:')) {
      // THE L17 CUT: a session's permission ask is never answered from the
      // board — ↵ ROUTES into the chat, where the same polished consent
      // card answers it (the one place; the settlement clears the rail).
      openObligationOrDoor(obligationId)
      return
    }
    setComposeContext({ kind: 'answer', obligationId, title: o.question })
    setRegion('live')
  }

  // ── THE SEAT-OVERLOAD ASK (item 4) — armed per dispatch gesture past the
  // machine reading; the card owns the keys while it stands (the consent
  // card's own Select grammar), and nothing persists an answer: the next
  // over-dispatch asks again, every time.
  const [seatAsk, setSeatAsk] = useState<{ text: string; live: number; ceiling: number } | null>(null)
  const seatAskRef = useRef<{ text: string; live: number; ceiling: number } | null>(null)
  seatAskRef.current = seatAsk
  const answerSeatAsk = (allowed: boolean): void => {
    const ask = seatAskRef.current
    setSeatAsk(null)
    if (ask === null) return
    if (!allowed) {
      // Declining dispatches NOTHING — no op, no reservation; the words
      // stay in the composer for the operator's next move.
      setNote({ tone: 'muted', text: 'kept — nothing dispatched; your draft stays' })
      return
    }
    // The consented dispatch proceeds through the SAME pair the ungated
    // submit rides — admission stays the machine's own (it queues; the
    // pump starts it when a seat frees).
    void callbacks.sendCoordinatorMessage?.(ask.text).catch(() => {})
    callbacks.submitSessionDraft(ask.text)
    clearDraft()
  }

  // ── THE CONTRACT OFFER (coordinator-tooling ledger T2) — armed per
  // concourse New Session gesture (the n key and the tab; boot-menu births
  // never come through here: "from the boot face, it starts with no
  // contract"). Memoryless ASK-EACH-TIME, deliberately: the ask stores
  // nothing to remember itself away with; T2 flags the every-birth cadence
  // STRIKE-ABLE at the operator's look (one key declines). The card paints
  // in the LIVE-VIEW pane (mirrorSlot — in the live session view, never
  // over the focused chat), never centered over the coordinator.
  const [contractAsk, setContractAsk] = useState(false)
  const contractAskRef = useRef(contractAsk)
  contractAskRef.current = contractAsk
  const armContractAsk = (): void => {
    // One consent Select at a time (the seat card's own law): under a
    // standing seat ask the n gesture stays dead rather than arming a
    // second listener.
    if (seatAskRef.current !== null) return
    setContractAsk(true)
  }
  const answerContractAsk = (contractText: string | null): void => {
    setContractAsk(false)
    if (contractText === null) {
      // The No leg (esc lands here too, from either face of the card):
      // the session births plain through the one birth door — exactly
      // what n meant before the ask existed.
      callbacks.newSession?.()
      return
    }
    // The Yes leg (ledger L25): the words were written IN THE CARD's own
    // field — never the live composer, never beneath another session's
    // live view — and they ARE the contract; the birth rides the SAME
    // one-door newSession the No leg takes, contract in hand, set through
    // the daemon's one verb after the admit (the route owns that
    // sequencing).
    callbacks.newSession?.({ contractText })
  }

  // ── MANAGER MODE's cards (ledger T7+T8) — the screen owns state + the
  // answer wires (the GitOffer ownership grammar); the pane only paints.
  // The conversation's LAST entry is the one derivation source: an ask or a
  // proposed plan arms its card exactly while it stays the newest word and
  // the mode is on; the operator's next message (or a No) disarms it. ──────
  const [convTail, setConvTail] = useState<import('../../services/concourse/coordinatorConversation.js').CoordinatorConversationEntryV1 | null>(null)
  useEffect(() => {
    if (reducedStage) return
    let alive = true
    const load = (): void => {
      void import('../../services/concourse/coordinatorConversation.js').then(async m => {
        const rows = await m.readCoordinatorConversation()
        if (!alive) return
        const last = rows.length > 0 ? rows[rows.length - 1]! : null
        setConvTail(prev =>
          prev !== null && last !== null && prev.id === last.id && JSON.stringify(prev) === JSON.stringify(last) ? prev : last,
        )
      })
    }
    load()
    let unsub: (() => void) | null = null
    void import('../../services/concourse/coordinatorConversation.js').then(m => {
      if (!alive) return
      unsub = m.subscribeCoordinatorConversation(load)
    })
    return () => {
      alive = false
      unsub?.()
    }
  }, [reducedStage])
  const [dismissedAskBump, setDismissedAskBump] = useState(0)
  const dismissedAsksRef = useRef<Set<string>>(new Set())
  const [managerPlanBusy, setManagerPlanBusy] = useState(false)
  const [managerSeatAsk, setManagerSeatAsk] = useState<{ entryId: string; plan: import('../../services/concourse/managerMode.js').ManagerPlanV1; live: number; ceiling: number } | null>(null)
  const managerSeatAskRef = useRef<typeof managerSeatAsk>(null)
  managerSeatAskRef.current = managerSeatAsk
  void dismissedAskBump
  const managerAskArmed =
    managerOn && !pending && convTail !== null && convTail.role === 'coordinator' && convTail.ask !== undefined && !dismissedAsksRef.current.has(convTail.id)
      ? { entryId: convTail.id, ask: convTail.ask }
      : null
  const managerPlanArmed =
    managerOn && !pending && !managerPlanBusy && managerSeatAsk === null && convTail !== null && convTail.plan !== undefined && convTail.plan.state === 'proposed'
      ? { entryId: convTail.id, plan: convTail.plan }
      : null
  const managerCardArmedRef = useRef(false)
  managerCardArmedRef.current = managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy
  // The answer rides the ONE send door as the operator's next message (the
  // example-row grammar: seed the draft, send).
  const sendManagerAnswer = (text: string): void => {
    draftEditedRef.current = true
    draftRef.current = { text, caret: text.length }
    setDraft(draftRef.current)
    sendCoordinator()
  }
  // THE ONE YES (T8): contracts set through the landed verb + lanes
  // dispatched through the landed door — with the seat-overload ask still
  // riding past the reading (never bypassed), and No dispatching nothing.
  const runManagerDispatch = (
    entryId: string,
    plan: import('../../services/concourse/managerMode.js').ManagerPlanV1,
    /** How many lanes the machine's reading affords right now (the seat
     *  ask's consented arithmetic); the rest wait in the plan and start
     *  under their contracts as seats free. */
    fits: number,
  ): void => {
    setManagerPlanBusy(true)
    void (async () => {
      try {
        const [mgr, snap] = await Promise.all([
          import('../../services/concourse/managerMode.js'),
          import('../../services/concourse/concourseSnapshot.js'),
        ])
        const ground = await snap.resolveHarnessGround().catch(() => getOriginalCwd())
        // CONTRACT BEFORE THE FIRST TURN: every lane births blank, takes its
        // contract on the record, then receives its first turn (the three
        // landed doors in the offer card's order) — never the admit-and-
        // deliver form, never a queued first frame.
        const done = await mgr.executeManagerPlan(plan, { workspaceRoot: ground, fits })
        const dispatched = {
          ...plan,
          state: 'dispatched' as const,
          laneSessionIds: done.laneSessionIds,
          ...(done.laneWaiting.length > 0 ? { laneWaiting: done.laneWaiting } : {}),
          workspaceRoot: ground,
        }
        await mgr.markManagerPlanState(entryId, {
          state: 'dispatched',
          laneSessionIds: done.laneSessionIds,
          laneWaiting: done.laneWaiting,
          workspaceRoot: ground,
        })
        mgr.registerDispatchedManagerPlan(dispatched, { entryId, workspaceRoot: ground })
        const conv = await import('../../services/concourse/coordinatorConversation.js')
        const started = done.laneSessionIds.filter(id => id !== null).length
        await conv.appendCoordinatorConversation({
          id: `mgr:dispatch:${entryId}`,
          role: 'coordinator',
          text: `plan dispatched — ${started} of ${plan.lanes.length} lane${plan.lanes.length === 1 ? '' : 's'} started under contract${done.laneWaiting.length > 0 ? `, ${done.laneWaiting.length} waiting for a seat` : ''}${dispatched.supervision === 'supervising' ? ' · supervising' : ' · launch-only'}`,
          ts: Date.now(),
          harness: true,
          receipts: done.receipts.map(r => ({
            verb: r.verb,
            outcome: r.outcome,
            label: `${r.verb} ${r.outcome}${r.detail !== undefined ? ` — ${r.detail}` : ''}`.slice(0, 220),
          })),
        })
        callbacks.retrySnapshot?.()
      } catch (e) {
        setNote({ tone: 'warning', text: `the plan did not dispatch — ${String(e).slice(0, 80)}; the draft stays · Yes retries` })
      } finally {
        if (aliveRef.current) setManagerPlanBusy(false)
      }
    })()
  }
  const answerManagerPlan = (entryId: string, plan: import('../../services/concourse/managerMode.js').ManagerPlanV1, yes: boolean, supervision: 'supervising' | 'launch-only'): void => {
    if (!yes) {
      // No/esc: the draft plan STAYS in the conversation for editing —
      // nothing dispatches; the next manager message revises it.
      void import('../../services/concourse/managerMode.js').then(m => m.markManagerPlanState(entryId, { state: 'declined' }))
      setNote({ tone: 'muted', text: 'kept as a draft — nothing dispatched; say what to change' })
      return
    }
    const withSupervision = { ...plan, supervision }
    // The seat-overload ask rides when the PLAN's demand runs past the
    // reading — the same consent class as the single dispatch, with the
    // plan's honest math; declining dispatches nothing.
    if (snapshot.counts.live + plan.lanes.length > effectiveSeatCeiling()) {
      setManagerSeatAsk({ entryId, plan: withSupervision, live: snapshot.counts.live, ceiling: effectiveSeatCeiling() })
      return
    }
    runManagerDispatch(entryId, withSupervision, plan.lanes.length)
  }
  const answerManagerSeatAsk = (allowed: boolean): void => {
    const ask = managerSeatAskRef.current
    setManagerSeatAsk(null)
    if (ask === null) return
    if (!allowed) {
      setNote({ tone: 'muted', text: 'kept — nothing dispatched; the plan card stays' })
      return
    }
    // The consented arithmetic: what fits starts now, the rest wait in the
    // plan and start under their contracts as seats free.
    runManagerDispatch(ask.entryId, ask.plan, Math.max(0, ask.ceiling - ask.live))
  }
  // SUPERVISING-LIGHT (T8 lead default b): the pane's EXISTING snapshot
  // beat drives the idempotent land/needs-you rows for the dispatched
  // plan's lanes — no watcher machinery of its own; launch-only appends
  // nothing; the walker self-guards when no plan is registered.
  useEffect(() => {
    if (reducedStage) return
    const rows = sessionRows.map(r => ({ sessionId: r.sessionId, state: r.state }))
    const counts = { live: snapshot.counts.live, ceiling: effectiveSeatCeiling() }
    void import('../../services/concourse/managerMode.js')
      .then(async m => {
        await m.appendManagerSupervisionRows(rows)
        // The start half: a waiting lane starts under its contract the
        // beat a seat frees (one per beat; the register guards re-entry).
        const startedLane = await m.startWaitingManagerLane(counts)
        if (startedLane !== null) callbacks.retrySnapshot?.()
      })
      .catch(() => {})
  }, [snapshot.revision, snapshot.counts.live, reducedStage, sessionRows, callbacks])

  // ── the ONE-TIME capacity ask (sheet; never recurring) ─────────────────
  const [capacityAsk, setCapacityAsk] = useState(false)
  const capacityAskRef = useRef(false)
  useEffect(() => {
    let alive = true
    void import('../../services/switchboard/capacityCheck.js')
      .then(m => {
        if (alive && m.needsCapacityAsk()) {
          capacityAskRef.current = true
          setCapacityAsk(true)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  // ── the folder-switch TRUST gate (hardening law 3): re-grounding onto a
  // folder the trust ledger does not cover ASKS first — never a silent
  // inheritance of the boot folder's session latch (utils/config/trust.ts
  // latches true for the whole process once the BOOT cwd is trusted, so a
  // bare chdir would run the new folder's code trusted unasked). y records
  // the grant through the ONE ledger (setPathTrusted) and applies the
  // switch; n/esc keeps the current ground, said plainly. ─────────────────
  const [trustAsk, setTrustAsk] = useState<{ dir: string } | null>(null)
  const trustAskRef = useRef<{ dir: string } | null>(null)
  trustAskRef.current = trustAsk
  const applyGround = (dir: string | null): void => {
    callbacks.setDraftSeed({ projectDir: dir })
    setNote({
      tone: 'muted',
      text:
        dir === null
          ? 'repo → the boot folder — new sessions launch there'
          : `repo → ${basename(dir)} — new sessions launch there`,
    })
  }
  const pickGround = (dir: string | null): void => {
    setGroundPickerOpen(false)
    if (dir !== null && !isPathTrusted(dir)) {
      setTrustAsk({ dir })
      return
    }
    applyGround(dir)
  }
  const answerTrustAsk = (trusted: boolean): void => {
    const ask = trustAskRef.current
    setTrustAsk(null)
    if (ask === null) return
    if (!trusted) {
      setNote({
        tone: 'muted',
        text: `kept on ${basename(getCwd()) || getCwd()} — ${basename(ask.dir)} stays untrusted`,
      })
      return
    }
    setPathTrusted(ask.dir)
    applyGround(ask.dir)
  }
  const answerCapacityAsk = (allowed: boolean): void => {
    capacityAskRef.current = false
    setCapacityAsk(false)
    void import('../../services/switchboard/capacityCheck.js')
      .then(m => m.recordCapacityDecision(allowed))
      .then(async r => {
        const { capacityDecisionReceipt } = await import('../../services/switchboard/capacityCheck.js')
        setNote({
          tone: 'muted',
          // FC-135: the receipt composer keeps the number in the tail the
          // slot's middle-truncation preserves.
          text: capacityDecisionReceipt(allowed, r.recommendedSeats),
        })
      })
      .catch(() => {})
  }

  const pastGate = useOpenEventGate()
  // Line 5: the open peek's streaming line — one subscription, only while
  // the peek is open on a live row (collapsed peeks cost nothing).
  const peekSelRow = sessionRows.find(r => r.sessionId === boardSel)
  const peekRowLive =
    rowPeekOpen &&
    peekSelRow !== undefined &&
    (peekSelRow.state === 'working' || peekSelRow.state === 'needs-you' || peekSelRow.state === 'starting')
  const peekLive = useLiveTile(peekSelRow?.sessionId ?? '', peekSelRow?.workspaceDir, peekRowLive)
  // The WORK CHIP: the selected row's running
  // work in one small amber line under it — one subscription, the selected
  // real session only, content-keyed (the tiles' calm laws). A parked row
  // runs nothing and subscribes to nothing.
  const chipLine = useWorkChip(
    peekSelRow?.sessionId ?? '',
    peekSelRow !== undefined && peekSelRow.workspaceDir !== undefined && peekSelRow.state !== 'parked',
  )
  // BOARD CONTROLS item 1: the row-control receipt paints ON the selected
  // row — the same granted line the work chip rides; while a receipt
  // stands it outranks the chip (a control's settle is the row's now-line
  // for its beat), then the chip returns as the note clears. Keyed BY ROW:
  // the receipt belongs to its session and never follows the cursor.
  const rowControlNote = controlNotes?.[`board:row-control:${peekSelRow?.sessionId ?? 'none'}`]
  // THE CLOSE-CHORD CONFIRM HINT (the operator's word): while the chord
  // leader is PENDING — read from the process mirror, because the machinery
  // lives in whichever provider consumed the press, usually the parked REPL
  // beneath this board — and the cursor stands on a closable row with the
  // plain board owning the keys, the granted line says what the completion
  // fires: the ruled visible confirm between the two presses, stage-true
  // (stop on a running row · remove while a stop receipt or a settled
  // 'stopped' class stands · the parked/queued voices). The chord timeout
  // un-paints it; the machinery's one-shot grace stays the uniform law.
  const pendingChordNow = useSyncExternalStore(subscribePendingChordMirror, getPendingChordMirror, getPendingChordMirror)
  const closeChordHint = ((): string | null => {
    const stroke = pendingChordNow?.length === 1 ? pendingChordNow[0] : undefined
    const leaderPending =
      stroke !== undefined && stroke.key === 'x' && stroke.ctrl && !stroke.shift && !stroke.super && !(stroke.alt || stroke.meta)
    if (!leaderPending || peekSelRow === undefined) return null
    const boardOwned =
      callbacks.daemonOfferArmed?.() !== true &&
      !helpOpen &&
      !filtering &&
      boardModalOwner({
        capacityAsk,
        trustAsk: trustAsk !== null,
        settingsOpen,
        groundPickerOpen,
        rowPick: rowPick !== null,
        seatAsk: seatAsk !== null,
        gitOffer: gitOffer !== undefined,
        contractAsk,
        managerSeatAsk: managerSeatAsk !== null,
        managerCardArmed: managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy,
        coordinatorFocused: region === 'coordinator',
      }) === null
    if (!boardOwned) return null
    const prior = lastStopRef.current
    const staged =
      prior !== null && prior.sessionId === peekSelRow.sessionId && Date.now() - prior.at < CLOSE_CHORD_STAGE_WINDOW_MS
    switch (boardSelectionClassOf(peekSelRow)) {
      case 'door':
      case 'none':
        return null
      case 'queued':
        return `${keyHintLabel('⌃x')} again withdraws the queued request`
      case 'parked':
        return staged
          ? `${keyHintLabel('⌃x')} again deletes it (the record ends)`
          : `${keyHintLabel('⌃x')} again — archived, nothing to stop`
      case 'stopped':
        return `${keyHintLabel('⌃x')} again archives it (the chat stands parked)`
      case 'live':
      case 'paused':
      case 'attached':
        return staged
          ? `${keyHintLabel('⌃x')} again re-sends the stop (the row reads stopped once its runner is gone)`
          : `${keyHintLabel('⌃x')} again stops — esc keeps it`
    }
  })()
  const chipRows =
    !rowPeekOpen && (chipLine !== null || rowControlNote !== undefined || boardArmed === peekSelRow?.sessionId || closeChordHint !== null) ? 1 : 0
  // ITEM 7: the open drop-down rides the SAME granted-rows channel the row
  // peek owns (one geometry owner) — entries + the honest tail line.
  const olderRows = olderList !== null ? Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, olderList.entries.length + 1)) : 0
  const focusTall: 'mirror' | 'coordinator' = region === 'coordinator' ? 'coordinator' : 'mirror'
  // The two composers' DESIRED draft bands through the one draftWindow
  // owner: the coordinator's lives INSIDE its pane (the pane's own flex —
  // capped so a tall draft never swallows the transcript); the LIVE box's
  // ask rides the geometry owner (0 = the reduced stage has none).
  const coordBandDesired = draftWindow(draft, 5).bandRows
  const liveDraftDesired = reducedStage ? 0 : draftWindow(liveDraft, 3).bandRows
  const boardGroupCount = useMemo(() => boardGroups.filter(g => g.rows.length > 0).length, [boardGroups])
  const geo = useMemo(
    () =>
      switchboardGeometry(
        cols,
        termRows,
        snapshot.needsYou.length,
        sessionRows.length,
        boardGroupCount,
        liveDraftDesired,
        focusTall,
        rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : chipRows,
      ),
    [cols, termRows, snapshot.needsYou.length, sessionRows.length, boardGroupCount, liveDraftDesired, focusTall, rowPeekOpen, olderRows, chipRows],
  )

  const regionsInOrder = useMemo<ConcourseRegion[]>(() => {
    // PANELS (L17 item 4): coordinator · list · live — the mirror and its
    // composer are ONE stop; the reduced stage has no coordinator panel.
    const ring: ConcourseRegion[] = reducedStage ? ['list', 'live'] : ['coordinator', 'list', 'live']
    if (snapshot.needsYou.length > 0) ring.push('rail')
    // THE EXTENDED TAB GRAMMAR: the chat pane joins
    // the existing region walk as its LAST stop — Tab keeps cycling exactly
    // as landed, one stop longer while the split frame composes.
    if (splitActive) ring.push('chat')
    return ring
  }, [snapshot.needsYou.length, reducedStage, splitActive])
  useEffect(() => {
    if (region === 'rail' && snapshot.needsYou.length === 0) setRegion(reducedStage ? 'list' : 'coordinator')
  }, [region, snapshot.needsYou.length, reducedStage])
  useEffect(() => {
    // The reduced stage has no coordinator panel: a capsule or a stray
    // jump landing there settles on the rows.
    if (reducedStage && region === 'coordinator') setRegion('list')
  }, [region, reducedStage])
  useEffect(() => {
    // The chat pane region exists only while the split frame composes — a
    // collapse, a toggle-off or a capsule from a split mount settles the
    // keys on the board (never a keyless focus).
    if (!splitActive && region === 'chat') setRegion(reducedStage ? 'list' : 'live')
  }, [region, splitActive, reducedStage])
  useEffect(() => {
    // THE RESIZE LAW (the rows leg): a
    // frame that stopped affording the split — width OR rows — collapses
    // split back to the full board: the store turns off (re-growing does
    // not auto-re-split) and the one honest line paints. Paint never tears
    // meanwhile: composition derives from the same availability check
    // every frame.
    if (reducedStage) return
    const c = collapseSplitForFrame(termCols, termRows)
    if (c.collapsed) setNote({ tone: 'warning', text: c.line })
    // The collapse notice expires WITH its truth — a
    // frame that affords again clears the standing "split collapsed" line
    // (it kept saying the window was too small after the operator widened
    // it). Only the collapse note is cleared; any other note stands.
    else if (splitAvailableAt(termCols, termRows)) {
      setNote(prev => (prev !== null && prev.text.startsWith('split collapsed') ? null : prev))
    }
  }, [termCols, termRows, reducedStage])
  useEffect(() => {
    // THE SHRINK DISARM: an ARMED
    // older-chats drop-down whose live grant falls under its 2-row floor
    // (a resize, a draft band growing) folds back to the line with the
    // honest note — an invisible armed list must never keep eating ↑↓.
    if (olderList !== null && geo.peekRows < 2) {
      setOlderList(null)
      setNote({ tone: 'muted', text: 'older chats folded — no room at this height' })
    }
  }, [olderList, geo.peekRows])

  // ── capsule ────────────────────────────────────────────────────────────────
  const capsuleRef = useRef<ConcourseCapsuleV2 | null>(null)
  capsuleRef.current = { region, filtering, filter, boardSel, railSel, boardScroll, managerMode: managerArmed }
  useEffect(() => {
    presentationCapsule = null
    return () => {
      presentationCapsule = capsuleRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ITEM 7: while the drop-down stands, the board-browse arrows walk IT —
  // every site that browses the board consults this first (one grammar).
  const olderNavConsumed = (
    key: { upArrow: boolean; downArrow: boolean },
    event: { stopImmediatePropagation: () => void },
  ): boolean => {
    const open = olderListRef.current
    if (open === null || !(key.upArrow || key.downArrow)) return false
    event.stopImmediatePropagation()
    const at = Math.min(open.entries.length - 1, Math.max(0, open.at + (key.downArrow ? 1 : -1)))
    if (at !== open.at) setOlderList({ ...open, at })
    return true
  }

  useInput((input, key, event) => {
    // THE ONE MODAL OWNER (the one-Select modal class, wired post-fold as
    // ruled): nine consent surfaces used to guard this handler pairwise —
    // boardModalOwner DECLARES the single owner of the key stream and the
    // handler branches on the one answer, in the SCREEN'S PAINT ORDER
    // (the esc-one-owner ruling: the topmost painted surface owns the key;
    // a buried prompt survives an overlay close untouched — the arrival
    // ladder let a capacity ask pending BEHIND the repo selector eat the
    // esc meant to close the selector). The capacity and trust asks keep
    // their own y/n/esc grammar; every other screen-wide owner yields the
    // handler whole (no consumption — the card's own Select grammar
    // settles the answer: the seat-overload card, the git offer, and the
    // contract offer, whose yield is ledger T2's — without it esc beneath
    // the card CANCELLED the birth its own row promises, the driven
    // find).
    // THE L17 CUT stands: no y/n permission grammar lives on the board —
    // a session ask's keys are its chat's consent card's; the only card
    // the board itself carries is the folder-scoped git offer. The manager
    // arms yield BELOW the tab block, exactly as before: tab still moves
    // focus under them, so the interview never imprisons the screen.
    const modalOwner = boardModalOwner({
      capacityAsk: capacityAskRef.current,
      trustAsk: trustAskRef.current !== null,
      settingsOpen: settingsOpenRef.current,
      groundPickerOpen: groundPickerOpenRef.current,
      rowPick: rowPickRef.current !== null,
      seatAsk: seatAskRef.current !== null,
      gitOffer: gitOfferRef.current !== undefined,
      contractAsk: contractAskRef.current,
      managerSeatAsk: managerSeatAskRef.current !== null,
      managerCardArmed: managerCardArmedRef.current,
      coordinatorFocused: region === 'coordinator',
      helpOpen: helpOpenRef.current,
    })
    // Daemon-start offer: exactly y/n/esc while armed — and ONLY while no
    // painted modal stands above the route banner (the esc-one-owner law:
    // an offer nobody can see under an open overlay must not eat its keys).
    if (modalOwner === null && callbacks.daemonOfferArmed?.() === true && callbacks.answerDaemonOffer !== undefined) {
      if (input === 'y' || input === 'Y') {
        event.stopImmediatePropagation()
        callbacks.answerDaemonOffer(true)
        return
      }
      if (input === 'n' || input === 'N' || key.escape) {
        event.stopImmediatePropagation()
        callbacks.answerDaemonOffer(false)
        return
      }
    }
    if (modalOwner === 'help') {
      // The key atlas is the LOWEST absolute overlay: it owns every key
      // only while nothing paints above it (the owner said so).
      event.stopImmediatePropagation()
      if (key.escape || input === '?' || key.return) {
        helpOpenRef.current = false
        setHelpOpen(false)
      }
      return
    }
    if (resolveConcourseProfile(cols, termRows) === 'too-small') {
      if (key.escape) {
        event.stopImmediatePropagation()
        callbacks.exitToRepl()
      }
      return
    }
    if (modalOwner === 'capacity-ask') {
      // The one-time capacity ask owns EVERY key — y runs the probe, n/esc
      // keep the default (recorded, so it never asks again); nothing types
      // through into the composer beneath.
      event.stopImmediatePropagation()
      if (input === 'y' || input === 'Y') answerCapacityAsk(true)
      else if (input === 'n' || input === 'N' || key.escape) answerCapacityAsk(false)
      return
    }
    if (modalOwner === 'trust-ask') {
      // The trust ask rides the capacity-ask grammar: y trusts & switches,
      // n/esc keeps the current ground.
      event.stopImmediatePropagation()
      if (input === 'y' || input === 'Y') answerTrustAsk(true)
      else if (input === 'n' || input === 'N' || key.escape) answerTrustAsk(false)
      return
    }
    if (modalOwner !== null && modalOwner !== 'manager-seat-ask' && modalOwner !== 'manager-card') return
    const ctx = composeContextRef.current
    if (key.tab && !filtering) {
      event.stopImmediatePropagation()
      // MANAGER MODE (ledger T7+T8; L22, the operator's ruled gesture):
      // shift+tab ON the coordinator composer cycles its mode — the main
      // chat's mode-cycling gesture, one grammar everywhere — whenever the
      // composer EXISTS (the full stage, the coordinator panel focused),
      // whatever the coordinator's own mode. Every other region (and the
      // reduced stage, which has no composer) keeps the ring's backward
      // step. The ref flips synchronously so a burst of presses reads its
      // own truth (the batch law).
      if (key.shift && region === 'coordinator' && !reducedStage) {
        const arming = !managerOnRef.current
        managerOnRef.current = arming
        setManagerArmed(arming)
        if (!coordinatorOn) noteManagerModel(arming)
        return
      }
      const dir = key.shift ? -1 : 1
      setRegion(prev => {
        const at = regionsInOrder.indexOf(prev)
        return regionsInOrder[(at + dir + regionsInOrder.length) % regionsInOrder.length]!
      })
      return
    }
    // MANAGER MODE's arms — the seat consent modal, and the standing card
    // while the coordinator panel holds focus (its Select/prompt grammar +
    // the card-level ruled digits; the focus scoping is the owner's own
    // law) — yield here, AFTER tab moved focus above, so the rest of the
    // board stays reachable: the interview never imprisons the screen.
    if (modalOwner === 'manager-seat-ask' || modalOwner === 'manager-card') return
    if (filtering) {
      if (key.escape) {
        event.stopImmediatePropagation()
        setFiltering(false)
        setFilter({ text: '', caret: 0 })
        return
      }
      if (key.return || key.tab) {
        event.stopImmediatePropagation()
        setFiltering(false)
        return
      }
      if (key.backspace) {
        event.stopImmediatePropagation()
        editFilter(backspaceAt)
        return
      }
      if (key.delete) {
        event.stopImmediatePropagation()
        editFilter(deleteAt)
        return
      }
      const filterMotion = editorMotionOp(key)
      if (filterMotion !== null) {
        event.stopImmediatePropagation()
        editFilter(filterMotion)
        return
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        editFilter(d => insertAt(d, singleLine(input)))
        return
      }
      return
    }
    // ── wheel: the ONE geometry owner routes; the list consumes here, the
    // chat panes gate their own (IP-2), chrome scrolls nothing. ────────────
    if (key.wheelUp || key.wheelDown) {
      const kp = event.keypress as { x?: number; y?: number }
      const overList =
        kp.x !== undefined && kp.y !== undefined
          ? kp.y >= geo.listBand[0] &&
            kp.y <= geo.listBand[1] &&
            kp.x >= (geo.profile === 'wide' ? geo.rightCols[0] : 3) &&
            kp.x <= (geo.profile === 'wide' ? geo.rightCols[1] : 2 + geo.interior)
          : region === 'list'
      if (!overList) return // mirror/coordinator consume within their own bounds
      event.stopImmediatePropagation()
      if (sessionRows.length === 0) return
      const dir = key.wheelDown ? 1 : -1
      setBoardScroll(v => {
        const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
        return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + dir * 3))
      })
      return
    }
    // ⌃a: turn the coordinator on (the pane banner's chord).
    if (key.ctrl && input === 'a' && !coordinatorOn) {
      event.stopImmediatePropagation()
      void callbacks.switchCoordinatorMode('agent-assisted')
      return
    }
    // ⌃s arms only where the picker can MOUNT — the reduced stage has no
    // coordinator, and an owner armed without a surface deadens the screen
    // at the modal-owner gate (the wide-twin latch above).
    if (key.ctrl && input === 's' && !reducedStage) {
      event.stopImmediatePropagation()
      openCoordinatorSettings()
      return
    }
    // UI-2 (close audit): the ground picker by KEYBOARD at every width —
    // below the rail's paint gate the project segment is invisible, and a
    // pointer-only door breaks the keyboard-reachability law.
    if (key.ctrl && input === 'g') {
      event.stopImmediatePropagation()
      setGroundPickerOpen(v => !v)
      return
    }
    if (key.escape) {
      event.stopImmediatePropagation()
      if (ctx.kind !== 'chat') {
        // The answer/rename contexts close one layer: the words stay in
        // the box, the context clears (a birth-time contract never lives
        // here — the offer card owns its own field and its own esc).
        setComposeContext({ kind: 'chat' })
        return
      }
      if (olderListRef.current !== null) {
        // ITEM 7: esc folds the drop-down back to the line — one layer.
        setOlderList(null)
        return
      }
      if (broadcastArmedRef.current) {
        // THE BROADCAST ARM (item 2): esc cancels the armed fan — nothing
        // sends, the words and the marks stay exactly where they are.
        broadcastArmedRef.current = false
        setBroadcastArmed(false)
        return
      }
      if (boardArmedRef.current !== null) {
        // ARM-THEN-ENTER (item 2): esc disarms — one layer.
        boardArmedRef.current = null
        setBoardArmed(null)
        return
      }
      if (rowPeekOpenRef.current) {
        // Line 5: esc closes the row peek first — one layer at a time.
        setRowPeekOpen(false)
        return
      }
      if (filterRef.current.text !== '') {
        // THE APPLIED FILTER (TASK-017 supplement, S1): the zero-match
        // board's own line promises "esc clears the filter" — the ladder
        // honors it one layer deep. The full list returns (marks staged on
        // filtered-out rows become visible again before the next esc
        // clears them), and the capsule carries only what the screen still
        // holds.
        filterRef.current = { text: '', caret: 0 }
        setFilter(filterRef.current)
        return
      }
      if (markedIdsRef.current.size > 0) {
        // THE BROADCAST MARKS (item 1): esc clears ALL marks — the deepest
        // layer before leaving (a deliberately staged set outlives the
        // transient views above; the next esc after this one exits).
        setMarkedIds(new Set())
        return
      }
      callbacks.exitToRepl()
      return
    }
    if (degraded && key.ctrl && input === 'r') {
      event.stopImmediatePropagation()
      callbacks.retrySnapshot?.()
      return
    }
    // ── region verbs (single letters fire only in their region) ────
    if (region === 'rail') {
      const liveRailIdx = (): number =>
        Math.max(0, snapshot.needsYou.findIndex(o => o.obligationId === railSelRef.current))
      if (key.upArrow || key.downArrow) {
        event.stopImmediatePropagation()
        const n = snapshot.needsYou.length
        if (n > 0) {
          const next = Math.min(n - 1, Math.max(0, liveRailIdx() + (key.downArrow ? 1 : -1)))
          railSelRef.current = snapshot.needsYou[next]?.obligationId ?? null
          setRailSel(railSelRef.current)
        }
        return
      }
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) beginAnswer(o.obligationId)
        return
      }
      if (input === 'o' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) openObligationOrDoor(o.obligationId)
        return
      }
      if (input === 'w' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        const o = snapshot.needsYou[liveRailIdx()]
        if (o) callbacks.withdrawObligation(o.obligationId)
        return
      }
    }
    if (region === 'list') {
      // THE ROWS OWN THEIR LETTERS: a printable on the list is a verb or
      // nothing — words reach a composer only from that composer's own
      // focus (tab or click, as its hint says), so no declared key ever
      // yields to typing, armed or not, draft held or not. The legend
      // prints the same verbs in every list state for exactly this reason.
      if (input === '/' && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        setFiltering(true)
        setFilter(f => ({ ...f, caret: f.text.length }))
        return
      }
      if (key.upArrow || key.downArrow) {
        if (olderNavConsumed(key, event)) return
        event.stopImmediatePropagation()
        if (sessionRows.length === 0) return
        const at = Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current))
        const next = Math.min(sessionRows.length - 1, Math.max(0, at + (key.downArrow ? 1 : -1)))
        const row = sessionRows[next]
        if (row && row.sessionId !== boardSelRef.current) selectSession(row.sessionId)
        return
      }
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        // THE DRAFT-AWARE ↵ (the armed-parked observation, ruled): a
        // NON-EMPTY live draft makes ↵ a SEND wherever it lands — the one
        // gate classifies it (a live target delivers; a PARKED target
        // refuses with the gate's own line and never reactivates — the
        // typed words used to ride into a silent reactivate and vanish
        // from the turn). The wordless ↵↵ stays the reactivate road, and
        // → remains the deliberate enter-with-a-draft-held gesture.
        if (!reducedStage && liveDraftRef.current.text.trim().length > 0) {
          sendLive()
          return
        }
        if (sessionRows.length === 0) {
          if (!reducedStage) setRegion('coordinator')
          return
        }
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel) enterSession(sel.sessionId)
        return
      }
      if (key.rightArrow && !key.ctrl && !key.meta) {
        // Line 5: `→` expands the selected row into a live peek in place;
        // the same key collapses it (esc does too). On the OLDER line the
        // same gesture unfolds/folds the census drop-down (item 7); on an
        // ARMED row it ENTERS (item 2 — "a second ↵ or → enters it").
        event.stopImmediatePropagation()
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel !== undefined && sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
          if (olderListRef.current !== null) setOlderList(null)
          else unfoldOlderList(sel)
          return
        }
        if (sel !== undefined && boardArmedRef.current === sel.sessionId) {
          enterSession(sel.sessionId)
          return
        }
        setRowPeekOpen(v => !v)
        return
      }
      // x CARRIES NO VERB (the close chord): the board's close verb moved
      // to ⌃x ⌃x (closeChordGesture, dispatched through the one-slot seam —
      // this handler never sees the raw chord). On the rows the plain
      // letter does nothing; in a focused composer it is a letter.
      if (input === 'm' && !key.ctrl && !key.meta && pastGate()) {
        // Item 5's explicit door: the deliver-on-start message stack lives
        // behind 'm' on a QUEUED row. On a LIVE row m is MODEL — the
        // session-arm picker (BOARD CONTROLS item 1); the key-map row says
        // which meaning per selection (the present-moves law).
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel?.sessionId.startsWith('dispatch:') === true) {
          event.stopImmediatePropagation()
          callbacks.openQueuedRoom?.(sel.sessionId)
          return
        }
        if (callbacks.setSessionModel !== undefined) {
          event.stopImmediatePropagation()
          const target = rowControlSel()
          if (target.row === undefined) {
            rowControlRefused(target.reason ?? 'no session to switch')
            return
          }
          if ((snapshot.newSession.modelOptions ?? []).length === 0) {
            rowControlRefused('no dispatchable models — /logins connects a family')
            return
          }
          setRowPick({ kind: 'model', sessionId: target.row.sessionId, title: target.row.title })
          return
        }
      }
      if (input === 'e' && !key.ctrl && !key.meta && callbacks.setSessionEffort !== undefined && pastGate()) {
        // BOARD CONTROLS item 1 (`e`) — the WARMRUN rider: the board
        // effort door, the same picker grammar as m over the shared
        // ladder; written through the set-effort verb.
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) setRowPick({ kind: 'effort', sessionId: target.row.sessionId, title: target.row.title })
        else rowControlRefused(target.reason ?? 'no session to set')
        return
      }
      if (input === 'i' && !key.ctrl && !key.meta && callbacks.interruptSession !== undefined && pastGate()) {
        // BOARD CONTROLS item 1 (`i`): interrupt the running turn — the
        // turn ends, the session stays; never a kill, never a park.
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) callbacks.interruptSession(target.row.sessionId)
        else rowControlRefused(target.reason ?? 'nothing to interrupt')
        return
      }
      if (input === 'p' && !key.ctrl && !key.meta && pastGate()) {
        // BOARD CONTROLS item 1 (`p`): the pause/resume toggle — pause
        // closes the delivery valve after the in-flight turn ("paused by
        // you"); on a paused row the same key resumes and clears it.
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) {
          if (target.row.state === 'paused') callbacks.resumeSession(target.row.sessionId)
          else callbacks.pauseAfterTurn(target.row.sessionId)
        } else rowControlRefused(target.reason ?? 'nothing to pause')
        return
      }
      if (input === 'r' && !key.ctrl && !key.meta && !reducedStage && callbacks.renameSession !== undefined && pastGate()) {
        // THE BOARD'S RENAME (L16): r on a session row arms the composer's
        // rename context — never on a door, a held launch or the older
        // line (they are not sessions to name); a record-less parked row
        // gets the op's own typed refusal instead of a silent nothing.
        event.stopImmediatePropagation()
        const sel = sessionRows.find(row => row.sessionId === boardSelRef.current)
        if (!sel || sel.sessionId.startsWith('dispatch:') || sel.door !== undefined || sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) return
        setComposeContext({ kind: 'rename', sessionId: sel.sessionId, title: sel.title })
        setRegion('live')
        return
      }
      if (input === 'n' && !key.ctrl && !key.meta && !reducedStage && callbacks.newSession !== undefined && pastGate()) {
        // THE NEW SESSION TAB's key (Law 9, rule 4): a blank session born in
        // the current ground through the one birth door, the chat focused.
        // A list-region verb like m and e; the reduced stage has no tab and
        // this key reaches nothing there (rule 5 — the boot face is the solo
        // road). The birth now rides the CONTRACT OFFER first (ledger T2):
        // the live-view card asks "start with a contract?"; No/esc births
        // exactly as this key always did.
        event.stopImmediatePropagation()
        armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        // THE SPLIT TOGGLE: a board letter-verb by
        // the landed m/e/i/p pattern — a focused composer keeps s a
        // letter. The decision measures the WHOLE terminal; a
        // frame under the two-minimum threshold answers the one honest
        // width line and nothing changes.
        event.stopImmediatePropagation()
        const out = toggleSplitView(termCols, termRows)
        if (!out.ok) setNote({ tone: 'muted', text: out.reason })
        else setNote(null)
        return
      }
      if ((input === '[' || input === ']') && !key.ctrl && !key.meta && splitActive && pastGate()) {
        // `[` / `]` nudge the divider between the named ratios while the
        // split frame stands; off-split the rows ignore them (a focused
        // composer keeps them as printables).
        event.stopImmediatePropagation()
        nudgeSplitRatio(input === '[' ? -1 : 1)
        return
      }
      if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        // THE BROADCAST MARK: space toggles the selected row's mark. On
        // the rows space is this verb and nothing else — the live composer
        // keeps space as a printable under its own focus, so a mid-sentence
        // space can never toggle a mark (typing never reaches the rows'
        // grammar). ANY row marks: the delivery fan types each skip at the
        // send (item 3), so the toggle itself never refuses. Full stage
        // only: the reduced stage has no live composer to broadcast from —
        // space stays dead and untaught there.
        event.stopImmediatePropagation()
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel !== undefined) toggleMark(sel.sessionId)
        return
      }
    }
    // ── the chat pane's own keys ──────────────────
    if (region === 'chat') {
      if (key.return && pastGate()) {
        // ↵ with a focused session = THE FULL CHAT (the same route move
        // shift+→ rides — the slot already points there, no hop); with
        // none = the board's own New Session birth, staying in split —
        // through the ONE birth door (the contract offer the board's n and
        // the New Session tab already ride). A LANDING IN FLIGHT is neither:
        // the chat is milliseconds from existing, the pane already withdrew
        // its pointer door for exactly that reason, and this key used to
        // birth a SECOND session on an impatient re-press (SP-1) — it now
        // waits, and the legend prints no ↵ row meanwhile.
        event.stopImmediatePropagation()
        if (hasFocusedSession()) callbacks.exitToRepl()
        else if (!landingInFlight()) armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && pastGate()) {
        // The way back — the SAME toggle control, from the chat side.
        event.stopImmediatePropagation()
        toggleSplitView(termCols, termRows)
        return
      }
      if ((input === '[' || input === ']') && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        nudgeSplitRatio(input === '[' ? -1 : 1)
        return
      }
    }
    // The base legend's '↑↓ browse' fires in every BOARD-side region (a
    // printed key must fire): the live panel browses the board too on a
    // single-line draft — a MULTILINE draft keeps caret travel (the editing
    // law) — and the split chat pane (no draft of its own) browses the same
    // board; its body follows the SLOT, not the selection, so browsing
    // never swaps it. THE ARROW-FOCUS LAW (the operator's live find):
    // the coordinator panel is NOT a board-side region — its
    // ↑↓ are its own (the zero-state example walk consumed them in the
    // pane; otherwise the key stays with the pane), exactly as its ↵ never
    // enters a row. The arrows used to move the board's selection from the
    // coordinator while ↵ refused to enter it: the selection moved under a
    // focus that could not act on it. browseKeysFor drops the ↑↓ row from
    // that panel's legend.
    if (
      (region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL)) ||
      (region === 'chat' && (key.upArrow || key.downArrow))
    ) {
      if (olderNavConsumed(key, event)) return
      event.stopImmediatePropagation()
      if (sessionRows.length === 0) return
      const at = Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current))
      const next = Math.min(sessionRows.length - 1, Math.max(0, at + (key.downArrow ? 1 : -1)))
      const row = sessionRows[next]
      if (row && row.sessionId !== boardSelRef.current) selectSession(row.sessionId)
      return
    }
    if (
      input === '?' &&
      !key.ctrl &&
      !key.meta &&
      // The one resolver the legend reads too: '?' opens the atlas from
      // the rows, the rail and the split pane, and from a composer only
      // while its draft is empty (with words it is a question mark).
      helpKeyFiresFor(region, (region === 'coordinator' ? draftRef : liveDraftRef).current.text.length === 0)
    ) {
      event.stopImmediatePropagation()
      helpOpenRef.current = true
      setHelpOpen(true)
      return
    }
    // ── the composers' ↵ (two composers — the focused panel routes) ────────
    if (key.return && !key.shift) {
      if (region === 'coordinator') {
        // An empty coordinator draft leaves ↵ to the pane's own grammar
        // (the zero-state example walk sends the highlighted example).
        if (draftRef.current.text.trim().length === 0) return
        event.stopImmediatePropagation()
        if (!pastGate()) return
        sendCoordinator()
        return
      }
      if (region !== 'live') return
      event.stopImmediatePropagation()
      if (!pastGate()) return
      if (liveDraftRef.current.text.trim().length === 0) {
        // (enter-dead-in-default-region): the live panel's ↵ on an EMPTY
        // draft is the advertised browse verb — enter the selected
        // session — never a silent empty-send return.
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel) enterSession(sel.sessionId)
        return
      }
      sendLive()
      return
    }
    if (reducedStage) {
      // THE REDUCED STAGE: no composer exists — the editing keys and the
      // type-through of printables below reach nothing (the rows and the
      // mirror keep their own keys above this line).
      return
    }
    if (region === 'chat') {
      // TYPING REACHES ONLY THE FOCUSED PANE: the
      // chat pane owns no composer in v1, so the composers' editing keys
      // and the printable type-through must not fire from here — a
      // keystroke in the chat pane never lands words in either draft.
      return
    }
    if (region !== 'coordinator' && region !== 'live') {
      // TYPING NEEDS THE COMPOSER'S OWN FOCUS: the rows and the rail carry
      // verbs, never words — a printable, a newline or a backspace reaches
      // a composer only while that composer holds focus (tab or click, as
      // its own hint says). So the list's declared letters never yield to
      // a type-through, and no keystroke moves the focus by itself; a key
      // a region does not declare does nothing there.
      return
    }
    // ── the editing keys belong to the FOCUSED composer: the coordinator
    //    panel's own draft, or the live composer (the row-side box whose
    //    target is the selected row). Content-adding keys respect the live
    //    gate — a refusing target takes no text, only the typed reason. ──────
    const side =
      region === 'coordinator'
        ? { ref: draftRef, undo: undoRef, edit: editDraft, focus: 'coordinator' as ConcourseRegion }
        : { ref: liveDraftRef, undo: liveUndoRef, edit: editLiveDraft, focus: 'live' as ConcourseRegion }
    const liveGateRefusal = (): string | null => {
      if (side.focus === 'coordinator') return null
      if (composeContextRef.current.kind !== 'chat') return null
      // THE BROADCAST FACE (broadcast item 2): with ≥2 marks the box speaks
      // to the marked set — the selection's own refusal class no longer
      // gates the words (the fan types each row's verdict at the send).
      if (broadcastFaceOf(markedRowsOf().length) !== null) return null
      const g = liveComposerGate(sessionRows.find(r => r.sessionId === boardSelRef.current))
      return g.ok ? null : g.line
    }
    // Typing in the LIVE composer ARMS the selected row (item 2): the
    // target turns explicit, the placeholder names it.
    // Under the broadcast face the MARKED SET is the target, not the
    // selection — the single-row arm would name the wrong addressee.
    const armSelectedForTyping = (): void => {
      if (side.focus !== 'live' || boardArmedRef.current !== null) return
      if (broadcastFaceOf(markedRowsOf().length) !== null) return
      const selId = boardSelRef.current
      if (selId !== null) {
        boardArmedRef.current = selId
        setBoardArmed(selId)
      }
    }
    if ((key.return && key.shift) || (key.ctrl && input === 'j')) {
      event.stopImmediatePropagation()
      const refusal = liveGateRefusal()
      if (refusal !== null) {
        setLiveNote({ tone: 'muted', text: refusal })
        return
      }
      armSelectedForTyping()
      recordDraftEdit(side.undo.current, side.ref.current, 'type')
      side.edit(d => insertAt(d, NL))
      return
    }
    if (key.ctrl && input === 'c' && side.ref.current.text.length > 0) {
      event.stopImmediatePropagation()
      recordDraftEdit(side.undo.current, side.ref.current, 'clear')
      side.edit(() => ({ text: '', caret: 0 }))
      return
    }
    if (key.ctrl && input === '_') {
      event.stopImmediatePropagation()
      const prev = undoDraft(side.undo.current)
      if (prev !== null) {
        if (side.focus === 'coordinator') {
          draftEditedRef.current = true
          draftRef.current = prev
          setDraft(prev)
        } else {
          liveDraftRef.current = prev
          setLiveDraft(prev)
        }
      }
      return
    }
    if (key.backspace || key.delete) {
      event.stopImmediatePropagation()
      recordDraftEdit(side.undo.current, side.ref.current, 'delete')
      side.edit(key.backspace ? backspaceAt : deleteAt)
      return
    }
    if (region === 'live' && key.rightArrow && !key.ctrl && !key.meta && liveDraftRef.current.text.length === 0) {
      // Line 5 from the live panel: an empty draft has no caret travel —
      // `→` peeks the selected row (the ↑↓ browse analog); on the OLDER
      // line it unfolds/folds the census drop-down (item 7); on an ARMED
      // row it ENTERS (item 2).
      event.stopImmediatePropagation()
      const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
      if (sel !== undefined && sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
        if (olderListRef.current !== null) setOlderList(null)
        else unfoldOlderList(sel)
        return
      }
      if (sel !== undefined && boardArmedRef.current === sel.sessionId) {
        enterSession(sel.sessionId)
        return
      }
      setRowPeekOpen(v => !v)
      return
    }
    if (region === 'coordinator' || region === 'live') {
      // Multiline drafts keep caret travel; the live panel's single-line
      // ↑↓ browse was consumed above, and the coordinator's ↑↓ stay in its
      // pane (the arrow-focus law).
      const motion = editorMotionOp(key)
      if (motion !== null) {
        event.stopImmediatePropagation()
        side.edit(motion)
        return
      }
      // IA-7's vertical caret motion, wired for BOTH composers so the
      // comment above holds: on a multiline draft ↑↓ move to the same column on the
      // adjacent line; on a single line the op is null and the key keeps
      // the surface's own meaning (the live panel browsed above; the
      // coordinator's stays in its pane).
      const vertical = caretVerticalOp(key, side.ref.current)
      if (vertical !== null) {
        event.stopImmediatePropagation()
        side.edit(vertical)
        return
      }
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
      // The printables land in the FOCUSED composer (the gate above keeps
      // every other region out): the coordinator's own draft, or the live
      // composer whose gate may refuse in type.
      event.stopImmediatePropagation()
      const refusal = liveGateRefusal()
      if (refusal !== null) {
        setLiveNote({ tone: 'muted', text: refusal })
        return
      }
      armSelectedForTyping()
      const payload = editorText(input)
      recordDraftEdit(side.undo.current, side.ref.current, payload.length > 1 ? 'paste' : 'type')
      side.edit(d => insertAt(d, payload))
      return
    }
  })

  // ── the mirror slot (the resident only at ZERO sessions) ───────
  const t = useMercuryTokens()
  // THEME-AWARE resident (operator addition — supersedes
  // the fixed resident of the era): the concourse's critter presence IS the session's
  // selected critter, from the same selection truth the REPL uses; the
  // concourse only follows the pick, never offers a change. The retired resident art
  // and its state transforms stay authored in critterData (their deletion is
  // a named deferral), but nothing mounts them any more.
  const residentAccent = useSessionAccent()
  const residentDef = React.useMemo(
    () => ({
      ...critterDefForKey(residentAccent.key),
      hue: residentAccent.accent,
      hueDeep: residentAccent.accentDeep,
    }),
    [residentAccent.key, residentAccent.accent, residentAccent.accentDeep],
  )
  const mirrorSlot = (rows: number, width: number): React.ReactNode => {
    if (contractAsk) {
      // THE CONTRACT OFFER's mount (ledger T2, the operator's placement):
      // the permission-class card paints IN the live-view pane — in the
      // live session view, to the right of the focused chat, never on it —
      // never centered over the board like the seat card.
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          <ContractOfferCard onAnswer={answerContractAsk} width={width} rows={rows} />
        </Box>
      )
    }
    const anySessions = sessionRows.length > 0 || snapshot.counts.live > 0
    if (!anySessions) {
      return (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden">
          {rows >= 8 && width >= 20 ? (
            /* SPECIMEN: the zero-sessions greeter — this empty state is BY
               DEFINITION a zero-agent state, so a session-verdict mount
               would render it permanently asleep under the agent predicate. */
            <AnimatedCritterArt def={residentDef} hero specimen />
          ) : null}
          <Text color={t.textMuted}>no sessions running</Text>
        </Box>
      )
    }
    const sel = sessionRows.find(r => r.sessionId === boardSel)
    if (!sel || sel.sessionId.startsWith('dispatch:') || sel.workspaceDir === undefined) {
      // (enter-session receipt): the route's 'board:open' notes
      // (pending / refused / failed) painted ONLY on a mounted SessionMirror
      // title row — a selection without a mirror (no workspace, dispatch
      // rows, empty peek) swallowed the receipt and ↵ read as dead. The
      // fallback face paints the same note grammar.
      const openNote = controlNotes?.['board:open']
      const noteRow = (() => {
        if (openNote === undefined) return null
        const n = controlNoteOf(openNote)
        return n.state === 'refused' || n.state === 'failed' ? (
          <Text color={t.failureText} wrap="truncate-end">
            ✕ {n.reason ?? 'refused'}
            {n.next !== undefined ? ` · ${n.next}` : ''}
          </Text>
        ) : n.state === 'applied' ? (
          <Text color={t.success} wrap="truncate-end">
            ✓ {n.reason ?? 'entering'}
          </Text>
        ) : (
          <Text color={t.textInstruction} wrap="truncate-end">
            {n.reason ?? 'working…'}
          </Text>
        )
      })()
      return (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" paddingX={1} overflow="hidden">
          {noteRow}
          <Text color={t.textInstruction} wrap="truncate-end">
            {sel && sel.sessionId.startsWith('dispatch:')
              ? sel.waitReason === 'repo-held'
                ? `repo held by ${sel.waitDetail ?? 'a live session'} — free the checkout to start this one`
                : sel.waitReason === 'unblocked'
                  ? 'unblocked — ask the coordinator to start it · m queues a message'
                  : sel.waitReason === 'no-repository' || sel.waitReason === 'unborn-head'
                    ? 'needs git — say yes to the offer and it starts on its own'
                    : `${concourseWaitCopy(sel.waitReason, sel.waitDetail)} — it starts when one frees · m queues a message`
              : sel?.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) === true
                // The same present-moves law as the composer's note: ↵
                // reaches the board only from the list and the live box.
                ? region === 'list' || region === 'live'
                  ? "the project's older chats — ↵ unfolds them on the board; a pick brings one back"
                  : "the project's older chats — tab to the list, ↵ unfolds them; a pick brings one back"
              : sel?.door !== undefined
                ? sel.door.kind === 'switch-project'
                  ? `${sel.title} — ↵ switches the board to ${sel.projectLabel}; they keep running either way`
                  : `${sel.title} — ↵ opens the repo picker`
                : sel?.state === 'parked'
                  ? 'parked — ↵ brings it back'
                  : 'select a session to mirror its chat · ↑↓'}
          </Text>
        </Box>
      )
    }
    return (
      <SessionMirror
        sessionId={sel.sessionId}
        workspaceId={sel.workspaceDir}
        title={sel.title}
        paneRows={rows}
        paneWidth={width}
        {...(splitGeo !== null ? { wheelBand: [0, splitGeo.dividerCol - 1] as [number, number] } : {})}
        focused={region === 'live'}
        onEnter={() => enterSession(sel.sessionId, { pointer: true })}
        state={sel.state}
        {...(sel.nowLabel !== undefined ? { nowLabel: sel.nowLabel } : {})}
        {...(controlNotes?.['board:open'] !== undefined
          ? { note: controlNotes['board:open'] }
          : {})}
      />
    )
  }

  const coordBounds: [number, number, number, number] =
    geo.profile === 'wide'
      ? [geo.coordCols[0], geo.coordCols[1], geo.mainBand[0], geo.mainBand[1]]
      : [3, 2 + geo.interior, geo.coordBand[0], geo.coordBand[1]]

  // ONE NAME OWNER (item 3): the hint teaches the gesture without naming
  // the project — the status rail's ground chip is the one painted name.
  // Manager mode's rest hint is the mode-scoped one (the mode-wear law).
  const restHint = managerOn
    ? 'one goal, one shot — the manager interviews, then plans the lanes'
    : coordinatorOn
      ? 'talk to the coordinator — try "launch two sessions on this project"'
      : 'describe a task — ↵ starts a session with it as title'
  // Every printed key true (the glyph pass law): the coordinator composer's
  // meta row advertises the shift+tab station exactly where it fires — on
  // the full stage in BOTH coordinator modes (L22).
  const coordinatorKeysHint = !reducedStage
    ? keyHintLabel(managerOn
      ? '↵ send · ⇧↵ newline · ⇧tab chat mode · tab panes'
      : '↵ send · ⇧↵ newline · ⇧tab manager · tab panes')
    : undefined
  // THE LIVE META ROW FOLLOWS THE DRAFT (TASK-017 supplement, SURVIVED L2):
  // on an EMPTY live draft ↵ never sends — it arms-then-enters (single-↵
  // on the reduced stage) — while the literal fallback said '↵ send' in
  // the same frame whose footer said '↵↵ enter session'. With words held,
  // ↵ IS a send everywhere (the draft-aware ↵ ruling), so the literal is
  // true and the hint stands down.
  const liveKeysHint =
    liveDraft.text.length === 0
      ? reducedStage
        ? '↵ enter session · tab panes'
        : '↵↵ enter session · tab panes'
      : undefined
  const contextLine =
    composeContext.kind === 'answer'
      ? { tone: 'warning' as const, text: `answer · ${composeContext.title} · ↵ delivers & resumes · esc cancels` }
      : composeContext.kind === 'rename'
        ? { tone: 'info' as const, text: `rename · ${composeContext.title} · type the new title · ↵ saves · esc cancels` }
        : broadcastArmed
          ? // THE BROADCAST ARM (broadcast item 2): the first ↵ armed the fan
            // — this line NAMES THE COUNT before the second ↵ sends. DERIVED
            // every paint, so the named count can never go stale (an edit to
            // the words or the marks disarms through the effect anyway).
            { tone: 'warning' as const, text: `broadcast · sends to ${markedRows.length} sessions · ↵ again sends · esc cancels` }
          : null

  // Click-to-caret (IP-4, the pointer half): EACH composer maps the click
  // against ITS own draftWindow (one owner per box — a drifted second
  // derivation put clicks a row off).
  const caretFromClick = (d: LineDraft, bandRows: number, visibleRow: number, col: number): number => {
    const lines = d.text.split(NL)
    const w = draftWindow(d, bandRows)
    const li = Math.max(
      0,
      Math.min(lines.length - 1, w.windowStart + Math.max(0, visibleRow - (w.hiddenAbove > 0 ? 1 : 0))),
    )
    let caret = 0
    for (let i = 0; i < li; i++) caret += (lines[i]?.length ?? 0) + 1
    caret += Math.max(0, Math.min(lines[li]?.length ?? 0, col))
    return caret
  }
  const onCoordinatorComposerClick = (visibleRow: number, col: number): void => {
    if (reducedStage) return
    setRegion('coordinator')
    const caret = caretFromClick(draftRef.current, coordBandDesired, visibleRow, col)
    editDraft(dd => ({ text: dd.text, caret: clampCaret(dd.text, caret) }))
  }
  const onLiveComposerClick = (visibleRow: number, col: number): void => {
    if (reducedStage) return
    setRegion('live')
    const caret = caretFromClick(liveDraftRef.current, Math.max(1, geo.liveComposerRows - 3), visibleRow, col)
    editLiveDraft(dd => ({ text: dd.text, caret: clampCaret(dd.text, caret) }))
  }

  // ── THE SPLIT COMPOSITION: the board pane at the
  // terminal's LEFT edge in exactly the columns the geometry law granted
  // (its own compositor reads the same frame through frameCols), one
  // divider column, and the chat pane taking the rest. Off-split the
  // layout stands alone, byte-identical to the landed board. ──────────────
  const boardTree = (
      <ConcourseLayout
        snapshot={snapshot}
        boardGroups={boardGroups}
        rowPeekOpen={rowPeekOpen}
        rowChipRows={chipRows}
        olderRows={olderRows}
        armedSelected={boardArmed !== null}
        markedIds={markedIds}
        rowPeekNode={(rows, width) => {
          const sel = peekSelRow
          if (sel === undefined) return null
          // The work chip: the selected row's running work, one amber line
          // (the estate's attention token, the board's done-dot leading it).
          // With the peek collapsed it IS the granted row; with the peek
          // open it leads the peek above the ask banner.
          const chipNode =
            chipLine !== null ? (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={t.warning} wrap="truncate-end">
                  {GLYPH.ok} {chipLine}
                </Text>
              </Box>
            ) : null
          // BOARD CONTROLS item 1: the typed who/what/when receipt on the
          // row — it outranks the chip for its beat, then clears.
          const receiptNode = (() => {
            if (rowControlNote === undefined) return null
            const n = controlNoteOf(rowControlNote)
            const ink =
              n.state === 'applied' ? t.success
              : n.state === 'pending' ? t.textInstruction
              : n.state === 'held' ? t.warning
              : t.failureText
            const glyph =
              n.state === 'applied' ? GLYPH.ok
              : n.state === 'pending' ? GLYPH.pending
              : n.state === 'held' ? GLYPH.pending
              : GLYPH.fail
            return (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={ink} wrap="truncate-end">
                  {glyph} {n.reason ?? n.state}
                  {n.next !== undefined ? ` · ${n.next}` : ''}
                </Text>
              </Box>
            )
          })()
          // ARM-THEN-ENTER (item 2): the armed row SHOWS the arm on its
          // granted line — the staged grammar in one sentence. The words
          // road is the live composer's own focus (tab reaches it from the
          // rows), advertised only when the gate would actually take words
          // (G4: a parked target must not advertise a queue it refuses). A
          // held live draft makes the next ↵ a SEND (the draft-aware ↵), so
          // the line says so instead of promising an enter. A standing
          // control receipt still outranks it for its beat.
          const armedNode =
            boardArmed === sel.sessionId ? (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={t.info} wrap="truncate-end">
                  {GLYPH.handoff} {liveDraft.text.trim().length > 0 ? 'armed — ↵ sends the draft · → enters' : 'armed — ↵ again enters'}
                  {/* Under the broadcast face typing speaks to the MARKED
                      set, not this row — the tail yields (item 2). */}
                  {liveDraft.text.trim().length === 0 && liveComposerGate(sel).ok && broadcastFaceOf(markedRows.length) === null ? ' · tab to message' : ''} · esc disarms
                </Text>
              </Box>
            ) : null
          // THE CLOSE-CHORD CONFIRM (the ruled visible hint between the two
          // presses): the pending chord is the row's NOW — it outranks even
          // a standing receipt for its beat, then everything returns.
          const closeHintNode =
            closeChordHint !== null ? (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={t.info} wrap="truncate-end">
                  {GLYPH.handoff} {closeChordHint}
                </Text>
              </Box>
            ) : null
          const rowLine = closeHintNode ?? receiptNode ?? armedNode ?? chipNode
          if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) && olderList !== null) {
            // ITEM 7 (L20): the census DROP-DOWN, in place under the line —
            // the very list the N counted. ↑↓ choose · ↵ brings it back ·
            // esc folds; rows click (select, then activate — the estate's
            // row grammar); the tail line is the honest arithmetic.
            const span = Math.max(1, rows - 1)
            const win = paneWindow(olderList.entries.length, olderList.at, span)
            const beyond = olderList.total - olderList.entries.length
            const tailParts = [
              ...(win.above > 0 ? [`↑ ${win.above}`] : []),
              ...(win.below > 0 ? [`↓ ${win.below}`] : []),
              ...(beyond > 0 ? [`+${beyond} more — /resume lists everything`] : []),
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
                // Line 6 at peek depth: the ask leads, never hidden by scroll.
                <Box height={1} flexShrink={0} overflow="hidden">
                  <Text color={t.warning} wrap="truncate-end">
                    asks: {askTileCopy(sel.title, ask)}
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
        focusTall={focusTall}
        liveDraftRows={liveDraftDesired}
        liveDraftEmpty={liveDraft.text.length === 0}
        coordinatorDraftEmpty={draft.text.length === 0}
        modelPickerOpen={settingsOpen}
        groundPickerOpen={groundPickerOpen}
        coordinatorNode={(rows, width) => reducedStage ? (
          // THE REDUCED STAGE's pane: the notice in the coordinator's place,
          // saying WHY this boot is the plain world (the router's word: the
          // saved switch, a `--chat` boot, or both) and the way back — a
          // `--chat` boot whose switch is on is never told to turn it on.
          <Box flexDirection="column" height={rows} width={width} overflow="hidden" paddingX={1}>
            <Text color={t.textSecondary} wrap="truncate-end">{`live view — the concourse is off${(() => { const why = plainWorldWhy(); return why !== null && why !== 'concourse off' ? ` (${why})` : '' })()}`}</Text>
            <Text color={t.textMuted} wrap="truncate-end">{`your sessions run and show here · ↵ enters one${keyMapHint.length > 0 ? ` · ${keyMapHint}` : ''}`}</Text>
            <Text color={t.textMuted} wrap="truncate-end">{concourseWayBack()}</Text>
          </Box>
        ) : (
          <CoordinatorPane
            callbacks={callbacks}
            mode={snapshot.coordinator.mode}
            {...(snapshot.coordinator.fallbackReason !== undefined
              ? { fallbackReason: snapshot.coordinator.fallbackReason }
              : {})}
            operatorHandle={snapshot.context.operatorHandle}
            focused={region === 'coordinator'}
            paneRows={rows}
            paneWidth={width}
            bounds={coordBounds}
            pending={pending}
            draftHeld={draft.text.trim().length > 0}
            modalUp={
              boardModalOwner({
                capacityAsk,
                trustAsk: trustAsk !== null,
                settingsOpen,
                groundPickerOpen,
                rowPick: rowPick !== null,
                seatAsk: seatAsk !== null,
                gitOffer: gitOffer !== undefined,
                contractAsk,
                managerSeatAsk: managerSeatAsk !== null,
                managerCardArmed: managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy,
                coordinatorFocused: region === 'coordinator',
              }) !== null
            }
            {...(gitOffer !== undefined && seatAsk === null && !contractAsk && geo.profile === 'wide' ? { gitOffer } : {})}
            onAnswerGitOffer={(requestId, allow, obligationId) =>
              callbacks.answerPermission?.(requestId, allow, obligationId)
            }
            {...(() => {
              // MANAGER MODE's card in the pane (T8: confined to the
              // coordinator's REPL) — the interview question, the plan, or
              // the busy plan while its Yes executes; the git offer and the
              // seat asks outrank it (one consent Select at a time).
              if (reducedStage || gitOffer !== undefined || seatAsk !== null || managerSeatAsk !== null) return {}
              if (managerAskArmed !== null) {
                const armed = managerAskArmed
                return {
                  managerCardNode: (
                    <ManagerAskCard
                      ask={armed.ask}
                      focused={region === 'coordinator'}
                      onAnswer={text => sendManagerAnswer(text)}
                      onEnough={() => sendManagerAnswer('enough — plan it')}
                      onDismiss={typedDraft => {
                        dismissedAsksRef.current.add(armed.entryId)
                        setDismissedAskBump(n => n + 1)
                        // The typed-but-unsent words survive the dismissal
                        // in the composer (FC-062).
                        if (typedDraft !== undefined && typedDraft.length > 0) {
                          draftEditedRef.current = true
                          draftRef.current = { text: typedDraft, caret: typedDraft.length }
                          setDraft(draftRef.current)
                        }
                      }}
                    />
                  ),
                }
              }
              const planData =
                managerPlanArmed ??
                (managerPlanBusy && convTail !== null && convTail.plan !== undefined
                  ? { entryId: convTail.id, plan: convTail.plan }
                  : null)
              if (planData !== null) {
                return {
                  managerCardNode: (
                    <ManagerPlanCard
                      plan={planData.plan}
                      focused={region === 'coordinator'}
                      busy={managerPlanBusy}
                      // THE HEIGHT BUDGET (MGR-1): the slot's rows minus the
                      // composer band + its frame and the pane's own title —
                      // the card fits above the composer instead of clipping
                      // its consent options and the composer off the pane.
                      maxRows={Math.max(8, rows - (Math.max(1, Math.min(coordBandDesired, rows - 8)) + 3) - 3)}
                      textWidth={Math.max(16, width - 8)}
                      onYes={supervision => answerManagerPlan(planData.entryId, planData.plan, true, supervision)}
                      onNo={() => answerManagerPlan(planData.entryId, planData.plan, false, planData.plan.supervision)}
                    />
                  ),
                }
              }
              return {}
            })()}
            settingsOpen={settingsOpen && geo.profile === 'wide'}
            onCloseSettings={() => closeCoordinatorSettings()}
            onFocus={() => setRegion('coordinator')}
            onSendExample={text => {
              draftEditedRef.current = true
              draftRef.current = { text, caret: text.length }
              setDraft(draftRef.current)
              sendCoordinator()
            }}
            collapsed={geo.profile === 'stacked' && focusTall !== 'coordinator'}
            tailNote={note}
            composerNode={
              // THE COORDINATOR PANE'S OWN COMPOSER (the two-composers
              // law): its REPL when on, the launcher when off — inside the
              // pane, capped so a tall draft never swallows the transcript.
              geo.profile === 'stacked' && focusTall !== 'coordinator' ? undefined : (
                <ConcourseComposer
                  width={Math.max(24, width - 4)}
                  bandRows={Math.max(1, Math.min(coordBandDesired, rows - 8))}
                  // While a manager card owns the
                  // keys the composer must not WEAR focus — the caret blinked
                  // and the rest hint advertised typing while every keystroke
                  // went to the card. Unfocused paint + the truthful hint.
                  focused={region === 'coordinator' && !(managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy)}
                  draft={draft}
                  pending={pending}
                  note={note}
                  restHint={
                    managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy
                      ? managerPlanBusy
                        ? 'the plan is dispatching — tab moves focus'
                        : 'the card above owns the keys — answer it, or tab moves focus'
                      : restHint
                  }
                  contextLine={null}
                  onComposerClick={onCoordinatorComposerClick}
                  {...(managerOn
                    ? { modeBand: { symbol: GLYPH.modeManager, label: 'manager mode on — goal in · interview · a plan of lanes' } }
                    : {})}
                  {...(coordinatorKeysHint !== undefined ? { keysHint: coordinatorKeysHint } : {})}
                />
              )
            }
          />
        )}
        mirrorNode={mirrorSlot}
        liveComposerNode={(bandRows, width) => {
          // THE LIVE COMPOSER (the two-composers law): the small box at the
          // live pane's foot — words to the SELECTED row, its placeholder
          // naming the target. THE BROADCAST FACE first (broadcast item 2):
          // ≥2 marks and the placeholder names the count + the ↵↵ grammar;
          // below the threshold the single-target gate speaks — its region
          // threaded so the older line's note only promises ↵ where that
          // key actually reaches the board — and a REFUSING gate paints
          // once through the single-paint law (liveComposerPaintOf): the
          // meta row carries the line, the placeholder empties.
          const face = broadcastFaceOf(markedRows.length)
          const g = liveComposerGate(sessionRows.find(r => r.sessionId === boardSel), region)
          const paint = liveComposerPaintOf(g, liveNote)
          return (
          <ConcourseComposer
            width={width}
            bandRows={bandRows}
            focused={region === 'live'}
            draft={liveDraft}
            pending={false}
            note={face !== null ? liveNote : paint.note}
            restHint={face !== null ? face.placeholder : paint.restHint}
            contextLine={contextLine}
            onComposerClick={onLiveComposerClick}
            {...(controlNotes?.['strip:composer'] !== undefined
              ? { composerNote: controlNotes['strip:composer'] }
              : {})}
            {...(liveKeysHint !== undefined ? { keysHint: liveKeysHint } : {})}
          />
          )
        }}
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
          openBootSettings: () => callbacks.enterBootSettings(),
          exitToRepl: () => callbacks.exitToRepl(),
          focusComposer: () => setRegion('coordinator'),
          focusList: () => setRegion('list'),
          // FN-017 R1 (route A): a POINTER door onto a Select arms only
          // while no other modal owns the keys — the predicate every
          // keyboard path yields on, read at click time from the same refs.
          // Unfenced, the rail's chip opened a visible picker over a
          // standing consent card whose Enter still fired (Ink dispatches
          // in mount order, not paint order): the operator consented to a
          // dispatch they could not see.
          openCoordinatorModel: () => {
            if (!mayArmBoardModal(modalFactsNow(), 'settings')) return
            openCoordinatorSettings()
          },
          openGroundPicker: () => {
            if (!mayArmBoardModal(modalFactsNow(), 'ground-picker')) return
            setGroundPickerOpen(v => !v)
          },
          ...(callbacks.retrySnapshot !== undefined ? { retrySnapshot: callbacks.retrySnapshot } : {}),
          // THE NEW SESSION TAB rides the full concourse only — the reduced
          // stage (rule 5's plain live view) wires no door, paints no tab.
          // The tab is a concourse birth gesture like n: it arms the
          // contract offer (ledger T2), whose No leg births as before.
          ...(reducedStage || callbacks.newSession === undefined ? {} : { newSession: () => armContractAsk() }),
        }}
        {...(controlNotes?.['board:new-session'] !== undefined ? { newSessionNote: controlNotes['board:new-session'] } : {})}
        {...(splitGeo !== null ? { frameCols: splitGeo.boardCols, splitOn: true } : {})}
      />
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
              onEnterFull={() => callbacks.exitToRepl()}
              onNewSession={() => callbacks.newSession?.()}
            />
          </Box>
        </Box>
      ) : (
        boardTree
      )}
      {/* C3 (win-triage S10): the atlas reads the FRAME, never the board
          pane — inside a split, `cols` is the halved pane width, which hid
          the SPLIT VIEW section exactly when split was on and centred the
          overlay over the pane instead of the screen. */}
      {helpOpen ? <ConcourseKeyAtlas cols={termCols} rows={termRows} chat={chatPresent()} reducedStage={reducedStage} splitOn={splitActive} /> : null}
      {settingsOpen && geo.profile !== 'wide' ? (
        <Box
          position="absolute"
          top={Math.max(1, Math.floor(termRows / 2) - 10)}
          left={Math.max(2, Math.floor((cols - Math.min(72, Math.max(48, cols - 8))) / 2))}
          width={Math.min(72, Math.max(48, cols - 8))}
          opaque
        >
          <CoordinatorModelPicker
            callbacks={callbacks}
            onClose={() => closeCoordinatorSettings()}
            allottedRows={Math.max(10, termRows - 8)}
            allottedWidth={Math.min(72, Math.max(48, cols - 8)) - 4}
          />
        </Box>
      ) : null}
      {capacityAsk ? <CapacityAskModal cols={cols} rows={termRows} onAnswer={answerCapacityAsk} /> : null}
      {seatAsk !== null ? (
        // THE SEAT-OVERLOAD ASK (item 4): the standard consent card,
        // centered as the screen's declared modal — while it stands the git
        // offer's card yields its mount (one Select listens at a time).
        <Box
          position="absolute"
          top={Math.max(1, Math.floor(termRows / 2) - 7)}
          left={Math.max(2, Math.floor((cols - Math.min(72, Math.max(48, cols - 8))) / 2))}
          width={Math.min(72, Math.max(48, cols - 8))}
          flexDirection="column"
          opaque
        >
          <SeatOverloadCard live={seatAsk.live} ceiling={seatAsk.ceiling} onAnswer={answerSeatAsk} />
        </Box>
      ) : null}
      {managerSeatAsk !== null ? (
        // MANAGER MODE's seat-overload ask (T8: the ask still rides past
        // capacity — never bypassed): the same centered consent modal, with
        // the PLAN's honest math; declining dispatches nothing and the plan
        // card returns for editing.
        <Box
          position="absolute"
          top={Math.max(1, Math.floor(termRows / 2) - 7)}
          left={Math.max(2, Math.floor((cols - Math.min(72, Math.max(48, cols - 8))) / 2))}
          width={Math.min(72, Math.max(48, cols - 8))}
          flexDirection="column"
          opaque
        >
          <ManagerSeatAskCard
            live={managerSeatAsk.live}
            ceiling={managerSeatAsk.ceiling}
            lanes={managerSeatAsk.plan.lanes.length}
            focused={region === 'coordinator'}
            onAnswer={answerManagerSeatAsk}
          />
        </Box>
      ) : null}
      {groundPickerOpen ? (
        <Box
          position="absolute"
          top={Math.max(1, Math.floor(termRows / 2) - 9)}
          left={Math.max(2, Math.floor((cols - Math.min(74, Math.max(44, cols - 8))) / 2))}
          opaque
        >
          <GroundPicker
            currentGround={getCwd()}
            bootGround={getOriginalCwd()}
            onPick={dir => pickGround(dir)}
            onClose={() => setGroundPickerOpen(false)}
          />
        </Box>
      ) : null}
      {trustAsk !== null ? (
        <TrustAskModal cols={cols} rows={termRows} dir={trustAsk.dir} onAnswer={answerTrustAsk} />
      ) : null}
      {rowPick !== null ? (
        <RowPickModal
          cols={cols}
          rows={termRows}
          titlePrefix={rowPick.kind === 'model' ? 'MODEL' : 'EFFORT'}
          title={rowPick.title}
          legend={rowPick.kind === 'model' ? '↵ switches this session · esc keeps the model' : "↵ sets this session's effort · esc keeps it"}
          options={
            rowPick.kind === 'model'
              ? (snapshot.newSession.modelOptions ?? []).map(o => ({ id: o.modelId, label: o.displayName }))
              : EFFORT_LEVELS.map(l => ({ id: l, label: l }))
          }
          onPick={(id, label) => {
            const target = rowPick
            setRowPick(null)
            if (target.kind === 'model') callbacks.setSessionModel?.(target.sessionId, id, label)
            else callbacks.setSessionEffort?.(target.sessionId, id)
          }}
          onClose={() => setRowPick(null)}
        />
      ) : null}
      {gitOffer !== undefined &&
      !contractAsk &&
      geo.profile !== 'wide' &&
      // FN-017 R1 (route B): this is the screen's LAST absolute sibling, so
      // it paints above every picker mounted before it — the stacked card
      // therefore mounts exactly while the owner table names it (the seat
      // asks, the pickers, the row pick, the trust and capacity asks and the
      // atlas all outrank it), waiting its turn under a picker instead of
      // painting over a picker that still holds the keys.
      gitOfferOwnsTheKeys({
        capacityAsk,
        trustAsk: trustAsk !== null,
        settingsOpen,
        groundPickerOpen,
        rowPick: rowPick !== null,
        seatAsk: seatAsk !== null,
        gitOffer: true,
        contractAsk,
        managerSeatAsk: managerSeatAsk !== null,
        managerCardArmed: managerAskArmed !== null || managerPlanArmed !== null || managerPlanBusy,
        coordinatorFocused: region === 'coordinator',
        helpOpen,
      }) ? (
        // Below 120 columns the coordinator pane is a stacked band too short
        // for the card (the driven 100×30 capture clipped it whole), so the
        // card mounts as a screen-level overlay — the SAME law the model
        // picker follows below 120 columns — anchored at the BOTTOM of the
        // main band, right above the composer strip (permissions live at the
        // bottom), full interior width. Same card, same keys, same wire.
        <Box
          position="absolute"
          top={Math.max(1, geo.mainBand[1] - gitOfferCardRows(gitOffer.folder, geo.interior, gitOffer.folderHeld === true))}
          left={2}
          width={geo.interior}
          flexDirection="column"
          opaque
        >
          <GitOfferCard
            offer={gitOffer}
            onAnswer={(requestId, allow, obligationId) => callbacks.answerPermission?.(requestId, allow, obligationId)}
          />
        </Box>
      ) : null}
    </>
  )
}

/** The stacked overlay's row count for the git-offer card at `interior`
 *  columns: margin 1 + top border 1 + title 1 + the `git init(<folder>)`
 *  line(s) + the description's wrapped lines + question 1 + two options +
 *  blank 1 + legend 1 + bottom border 1. The text column is the interior
 *  minus the dialog's border + padding (4) — the driven 100×30 capture
 *  wrapped exactly there; anchoring by this keeps the card's bottom border
 *  ON the main band's last row, never over the composer strip's top rule.
 *  The description measures through the card's OWN composer
 *  (gitOfferDescription — derive, never duplicate), split fact included. */
function gitOfferCardRows(folder: string, interior: number, folderHeld: boolean): number {
  const textCols = Math.max(20, interior - 4)
  const descLen = gitOfferDescription(folder, folderHeld).length
  const gitLines = Math.max(1, Math.ceil((`git init(${folder})`.length) / textCols))
  const descLines = Math.max(1, Math.ceil(descLen / textCols))
  return 9 + gitLines + descLines
}

/** Hardening law 3: the folder-switch trust ask — a DECLARED modal in the
 *  capacity-ask grammar. Re-grounding onto a folder outside the trust
 *  ledger asks HERE before anything changes; y records the grant through
 *  the one ledger and switches, n/esc keeps the current ground. */
function TrustAskModal({
  cols,
  rows,
  dir,
  onAnswer,
}: {
  cols: number
  rows: number
  dir: string
  onAnswer: (trusted: boolean) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-trust-ask')
  const width = Math.min(70, Math.max(44, cols - 8))
  return (
    <Box
      position="absolute"
      top={Math.max(1, Math.floor(rows / 2) - 5)}
      left={Math.max(0, Math.floor((cols - width) / 2))}
      width={Math.min(width, cols)}
      flexDirection="column"
      borderStyle="round"
      borderColor={t.warning}
      paddingX={2}
      opaque={true}
    >
      <Box height={1} flexShrink={0}>
        <Text bold color={t.warning} wrap="truncate-end">
          UNTRUSTED FOLDER — trust check
        </Text>
      </Box>
      <Box flexShrink={0} marginTop={1} flexDirection="column">
        <Text color={t.textPrimary} wrap="wrap">
          Mercury has not been trusted with {dir} before. Sessions launched there run its code and
          read its settings.
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <InteractiveRow id="concourse:trust-ask:allow" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(true)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.warning} bold>
                y
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> trust this folder — switch to it</Text>
            </Text>
          )}
        </InteractiveRow>
        <InteractiveRow id="concourse:trust-ask:decline" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(false)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.warning} bold>
                n
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> keep the current ground — nothing changes</Text>
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc keeps the current ground · the grant persists in the trust ledger
        </Text>
      </Box>
    </Box>
  )
}

/** The one-time capacity ask is a real DECLARED
 *  modal — its own frame, wrapped copy, the answer keys painted at every
 *  geometry, clickable answer rows, and the standard one-layer esc. The old
 *  face was a 118-char composer meta line that truncated its own y/n tail
 *  at ≤120 columns and consumed esc with no visible layer to close. */
function CapacityAskModal({
  cols,
  rows,
  onAnswer,
}: {
  cols: number
  rows: number
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-capacity-ask')
  const width = Math.min(64, Math.max(44, cols - 8))
  return (
    <Box
      position="absolute"
      top={Math.max(1, Math.floor(rows / 2) - 5)}
      left={Math.max(0, Math.floor((cols - width) / 2))}
      width={Math.min(width, cols)}
      flexDirection="column"
      borderStyle="round"
      borderColor={t.info}
      paddingX={2}
      opaque={true}
    >
      <Box height={1} flexShrink={0}>
        <Text bold color={t.info} wrap="truncate-end">
          FIRST BOOT — capacity check
        </Text>
      </Box>
      <Box flexShrink={0} marginTop={1}>
        <Text color={t.textPrimary} wrap="wrap">
          may I run a one-time check of what this machine carries — cores, memory, other agent CLIs
          already running — to size how many parallel sessions fit?
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <InteractiveRow id="concourse:capacity-ask:allow" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(true)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.info} bold>
                y
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> run it once</Text>
            </Text>
          )}
        </InteractiveRow>
        <InteractiveRow id="concourse:capacity-ask:decline" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(false)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.info} bold>
                n
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> no probe — the machine's own reading decides</Text>
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc keeps the default · asked once, never again
        </Text>
      </Box>
    </Box>
  )
}

/** The key atlas — every grammar derives from controlManifest. */
function ConcourseKeyAtlas({ cols, rows, chat, reducedStage = false, splitOn = false }: { cols: number; rows: number; chat: boolean; reducedStage?: boolean; splitOn?: boolean }): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-help')
  // THE ATLAS READS THE RESOLVER (TASK-017 supplement, the L2 class): the
  // raw tables taught keys the current stage cannot fire — ⌃s and n on the
  // plain live view, the split grammar one column under its own gate — and
  // omitted the SESSIONS region entirely, the region that owns most of the
  // board's verbs. One resolver (regionKeysFor + its stageFilter) already
  // resolves every legend; the atlas prints the same truth.
  const stage = { newSession: !reducedStage }
  const sections: Array<{ title: string; keys: ReadonlyArray<{ keys: string; label: string }> }> = [
    { title: 'BROWSE', keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY] },
    { title: 'NEEDS YOU (rail)', keys: regionKeysFor('rail', stage) },
    { title: 'SESSIONS (list)', keys: regionKeysFor('list', stage) },
    // The coordinator panel exists on the full stage only — the plain
    // world must not be taught ⌃s (a printed key that does not fire).
    ...(reducedStage ? [] : [{ title: 'COORDINATOR (its composer)', keys: regionKeysFor('coordinator', stage) }]),
    { title: 'LIVE VIEW (its composer)', keys: regionKeysFor('live', stage) },
    // SPLIT VIEW rides the full stage AND the split's own frame gate —
    // at 120 columns `s` refuses with "split needs 121 columns" (and at 23
    // rows with the rows line), so the atlas teaches it only where the
    // toggle fires (one gate, one truth). SP-8: the rows speak
    // the LIVE state — while the full board stands, `s` OPENS the split and
    // no divider exists, so teaching the chat pane's '[ ] divider' and
    // 's full board' there taught keys of a frame that was not standing;
    // the pane grammar prints only while the split composes.
    ...(!reducedStage && splitAvailableAt(cols, rows)
      ? [
          splitOn
            ? { title: 'SPLIT VIEW (s toggles)', keys: regionKeysFor('chat', { ...stage, chatSession: chat }) }
            : { title: 'SPLIT VIEW (s toggles)', keys: [{ keys: 's', label: 'split view' }] },
        ]
      : []),
  ]
  // C3 (win-triage S10): the panel CLAMPS to the frame. The old top-only
  // clamp let a short frame paint the card past the bottom edge, so the
  // LAST rows — 'esc close' — shed first with no marker. Shedding is now
  // explicit and bottom-up: whole trailing sections fold into one counted
  // marker row, and the footer always paints. A frame the whole card fits
  // renders byte-identically.
  const composedHeight = (list: typeof sections, marker: boolean): number =>
    list.reduce((n, s) => n + 1 + s.keys.length, 0) +
    Math.max(0, list.length - 1) +
    3 +
    2 /* border rows */ +
    (marker ? 1 : 0)
  const maxHeight = Math.max(7, rows - 2)
  let shown = sections
  let hiddenSections = 0
  while (shown.length > 1 && composedHeight(shown, hiddenSections > 0) > maxHeight) {
    shown = shown.slice(0, -1)
    hiddenSections++
  }
  // The centering keeps the pre-clamp bias (the old height formula never
  // counted the border's two rows) so a frame the whole card fits paints at
  // the exact rows it always did; only the CLAMP reads the true height.
  const height = composedHeight(shown, hiddenSections > 0) - 2
  // THE PLATFORM SEAM (class 5): chips paint in the HOST's spelling —
  // identity on macOS (12-cell column, 46-wide card, byte-identical), and
  // where the words run wider (shift+↵/ctrl+j) the key column and the card
  // grow together so a spelling never clips its own label column.
  const keyCol = Math.max(12, ...sections.flatMap(s => s.keys.map(k => displayWidth(keyHintLabel(k.keys)) + 1)))
  const width = 46 + (keyCol - 12)
  return (
    <Box
      position="absolute"
      top={Math.max(1, Math.floor((rows - height) / 2))}
      left={Math.max(0, Math.floor((cols - width) / 2))}
      width={Math.min(width, cols)}
      flexDirection="column"
      borderStyle="round"
      borderColor={t.info}
      paddingX={2}
      opaque={true}
    >
      <Box height={1} flexShrink={0}>
        <Text bold color={t.info} wrap="truncate-end">
          CONCOURSE — keys
        </Text>
      </Box>
      {shown.map((s, si) => (
        <Box key={s.title} flexDirection="column" flexShrink={0} marginTop={si === 0 ? 0 : 1}>
          <Text color={t.infoText} bold wrap="truncate-end">
            {s.title}
          </Text>
          {s.keys.map(k => (
            <Box key={`${s.title}:${k.keys}`} height={1} flexShrink={0}>
              <Box width={keyCol} flexShrink={0}>
                <Text color={t.textPrimary}>{keyHintLabel(k.keys)}</Text>
              </Box>
              <Text color={t.textInstruction} wrap="truncate-end">
                {k.label}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {hiddenSections > 0 ? (
        <Box height={1} flexShrink={0} marginTop={1}>
          <Text color={t.textMuted} wrap="truncate-end">
            {`… ${hiddenSections} more section${hiddenSections === 1 ? '' : 's'} — grow the window`}
          </Text>
        </Box>
      ) : null}
      <Box height={1} flexShrink={0} marginTop={hiddenSections > 0 ? 0 : 1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc close
        </Text>
      </Box>
    </Box>
  )
}
