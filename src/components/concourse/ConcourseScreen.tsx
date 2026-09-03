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


type ComposeContext =
  | { kind: 'chat' }
  | { kind: 'answer'; obligationId: string; title: string }
  | { kind: 'rename'; sessionId: string; title: string }

interface ConcourseCapsuleV2 {
  region: ConcourseRegion
  filtering: boolean
  filter: LineDraft
  boardSel: string | null
  railSel: string | null
  boardScroll: number | null
  managerMode?: boolean
}
let presentationCapsule: ConcourseCapsuleV2 | null = null
export function _resetConcourseCapsuleForTesting(): void {
  presentationCapsule = null
}

export function liveComposerGateOf(
  sel: ConcourseRowV1 | undefined,
  openAsk: boolean,
  region?: ConcourseRegion,
  credentialWall?: string,
): { ok: true; placeholder: string } | { ok: false; line: string } {
  if (sel === undefined) return { ok: false, line: 'no session selected — the coordinator panel starts one' }
  if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
    return {
      ok: false,
      line:
        region === undefined || region === 'list' || region === 'live'
          ? 'older chats — ↵ unfolds the list'
          : 'older chats — tab to the list, ↵ unfolds it',
    }
  }
  if (sel.door !== undefined) return { ok: false, line: 'a door — ↵ opens it; nothing to message' }
  if (sel.sessionId.startsWith('dispatch:') || sel.state === 'queued') return { ok: false, line: 'queued — m stacks a message for its start' }
  if (sel.state === 'parked') return { ok: false, line: 'parked — ↵↵ brings it back; a sleeping chat takes no queue' }
  if (sel.state === 'attached') return { ok: false, line: 'with you — type in its own chat' }
  if (sel.state === 'stopped') return { ok: false, line: `stopped — nothing listens; ${keyHintLabel('⌃x ⌃x')} archives it` }
  if (sel.state === 'needs-you' || openAsk) return { ok: false, line: 'needs you · ↵↵ to answer' }
  if (credentialWall !== undefined) return { ok: false, line: credentialWall }
  return { ok: true, placeholder: `message ${sel.title} · queued for its next turn` }
}

export function broadcastFaceOf(markedOnBoard: number): { placeholder: string } | null {
  if (markedOnBoard < 2) return null
  return { placeholder: `message ${markedOnBoard} sessions · ↵↵ sends to all marked` }
}

export function broadcastSummaryOf(sent: number, marked: number): string {
  return `sent to ${sent} of ${marked} · ${marked - sent} skipped`
}

export function liveComposerPaintOf(
  gate: { ok: true; placeholder: string } | { ok: false; line: string },
  note: { tone: 'muted' | 'warning'; text: string } | null,
): { restHint: string; note: { tone: 'muted' | 'warning'; text: string } | null } {
  if (gate.ok) return { restHint: gate.placeholder, note }
  return { restHint: '', note: note ?? { tone: 'muted', text: gate.line } }
}

function migrateCapsuleRegion(region: string | undefined): ConcourseRegion | undefined {
  if (region === 'composer') return 'coordinator'
  if (region === 'mirror') return 'live'
  if (region === 'rail' || region === 'list' || region === 'live' || region === 'coordinator' || region === 'chat') return region
  return undefined
}

const NL = String.fromCharCode(10)

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
  reducedStage?: boolean
}): React.ReactNode {
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const coordinatorOn = snapshot.coordinator.mode === 'agent-assisted'
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const keyMapHint = stripKeyMapHint()
  useSyncExternalStore(subscribeSplitView, splitViewVersion, splitViewVersion)
  const splitActive = !reducedStage && splitViewOn() && splitAvailableAt(termCols, termRows)
  const splitGeo = splitActive ? splitGeometryAt(termCols, splitViewRatio()) : null
  const cols = splitGeo !== null ? splitGeo.boardCols : termCols

  const [filtering, setFiltering] = useState(presentationCapsule?.filtering ?? false)
  const [filter, setFilter] = useState<LineDraft>(presentationCapsule?.filter ?? { text: '', caret: 0 })
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

  const [region, setRegion] = useState<ConcourseRegion>(() =>
    reducedStage ? 'list' : (migrateCapsuleRegion(presentationCapsule?.region) ?? 'coordinator'),
  )
  const [managerArmed, setManagerArmed] = useState<boolean>(() => presentationCapsule?.managerMode ?? false)
  const managerOn = managerArmed && !reducedStage
  const managerOnRef = useRef(managerOn)
  managerOnRef.current = managerOn
  const [helpOpen, setHelpOpen] = useState(false)
  const helpOpenRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  const openCoordinatorSettings = (): void => {
    setSettingsOpen(v => (v ? false : !reducedStage))
  }
  const closeCoordinatorSettings = (): void => {
    setSettingsOpen(false)
  }
  useEffect(() => {
    if (reducedStage && settingsOpen) setSettingsOpen(false)
  }, [reducedStage, settingsOpen])
  const [groundPickerOpen, setGroundPickerOpen] = useState(false)
  const groundPickerOpenRef = useRef(false)
  groundPickerOpenRef.current = groundPickerOpen

  const [railSel, setRailSel] = useState<string | null>(() => {
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
  const [rowPeekOpen, setRowPeekOpen] = useState(false)
  const rowPeekOpenRef = useRef(false)
  rowPeekOpenRef.current = rowPeekOpen
  const [olderList, setOlderList] = useState<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  const olderListRef = useRef<{ entries: OlderChatFact[]; total: number; at: number } | null>(null)
  olderListRef.current = olderList
  const unfoldOlderList = (row: ConcourseRowV1): void => {
    const projectDir = row.sessionId.slice(OLDER_CHATS_ROW_PREFIX.length)
    const excluded = new Set(
      snapshot.groups
        .flatMap(g => g.rows)
        .filter(r => r.door === undefined && !r.sessionId.startsWith('dispatch:') && !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
        .map(r => r.sessionId),
    )
    const census = olderChatsCensus(projectDir, excluded, Date.now(), { entryCap: PARKED_CAP })
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
  useEffect(() => {
    if (olderList !== null && (boardSel === null || !boardSel.startsWith(OLDER_CHATS_ROW_PREFIX))) setOlderList(null)
  }, [boardSel, olderList])
  const [boardArmed, setBoardArmed] = useState<string | null>(null)
  const boardArmedRef = useRef<string | null>(null)
  boardArmedRef.current = boardArmed
  useEffect(() => {
    if (boardArmed !== null && boardSel !== boardArmed) setBoardArmed(null)
  }, [boardSel, boardArmed])
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
  const markProjectRef = useRef(snapshot.context.projectLabel)
  useEffect(() => {
    if (markProjectRef.current === snapshot.context.projectLabel) return
    markProjectRef.current = snapshot.context.projectLabel
    setMarkedIds(new Set())
  }, [snapshot.context.projectLabel])
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
      if (needsSeatOverloadAsk(snapshot.counts.live, effectiveSeatCeiling())) {
        setSeatAsk({ text, live: snapshot.counts.live, ceiling: effectiveSeatCeiling() })
        return
      }
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
      })
  }

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

  const lastStopRef = useRef<{ sessionId: string; at: number } | null>(null)
  const closeChordGesture = (): void => {
    if (closeChordBlocked()) return
    const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
    if (!sel) return
    if (sel.sessionId.startsWith('dispatch:')) {
      callbacks.removeSession?.(sel.sessionId)
      return
    }
    if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
      setNote({ tone: 'muted', text: 'the older chats stay — ↵ opens them; clear one at a time from there' })
      return
    }
    if (sel.door !== undefined) {
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
      lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }
      callbacks.archiveSession?.(sel.sessionId)
      return
    }
    if (staged) {
      setNote({ tone: 'muted', text: `stop is on its way — the row reads stopped once its runner is gone; ${keyHintLabel('⌃x ⌃x')} then archives it` })
      callbacks.stopSession?.(sel.sessionId)
      return
    }
    lastStopRef.current = { sessionId: sel.sessionId, at: Date.now() }
    callbacks.stopSession?.(sel.sessionId)
  }
  const closeChordRoutineRef = useRef(closeChordGesture)
  closeChordRoutineRef.current = closeChordGesture
  useEffect(() => claimConcourseCloseChord(() => closeChordRoutineRef.current()), [])

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
    callbacks.noteControl?.(`board:row-control:${boardSelRef.current ?? 'none'}`, { state: 'refused', reason })
  }

  const enterSession = (sessionId: string, opts: { pointer?: boolean } = {}): void => {
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
    if (sessionId.startsWith('dispatch:')) {
      const row = sessionRows.find(r => r.sessionId === sessionId)
      const line =
        row?.waitReason === undefined || row.waitReason === 'seat'
          ? `queued — waits for a seat · ${snapshot.counts.live}/${effectiveSeatCeiling()} seats busy`
          : `queued — ${concourseWaitCopy(row.waitReason, row.waitDetail)}`
      setNote({ tone: 'muted', text: `${line} · m queues a message` })
      return
    }
    const door = sessionRows.find(r => r.sessionId === sessionId)?.door
    if (door !== undefined) {
      if (door.kind === 'switch-project') pickGround(door.dir)
      else setGroundPickerOpen(true)
      return
    }
    if (!reducedStage && opts.pointer !== true && boardArmedRef.current !== sessionId) {
      boardArmedRef.current = sessionId
      setBoardArmed(sessionId)
      return
    }
    boardArmedRef.current = null
    setBoardArmed(null)
    callbacks.enterSession(sessionId)
  }

  const gitOffer = useMemo<GitOfferV1 | undefined>(() => {
    const derived = deriveGitOffer(snapshot.needsYou)
    return derived !== undefined ? { ...derived, folderHeld: gitOfferFolderHeld(snapshot, derived.folder) } : undefined
  }, [snapshot])
  const gitOfferRef = useRef<GitOfferV1 | undefined>(gitOffer)
  gitOfferRef.current = gitOffer

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

  const beginAnswer = (obligationId: string): void => {
    const o = snapshot.needsYou.find(x => x.obligationId === obligationId)
    if (!o) return
    if (o.foreignProject !== undefined) {
      takeObligationDoor(o)
      return
    }
    if (reducedStage) {
      callbacks.openObligation(obligationId)
      return
    }
    const ref = o.ref ?? ''
    if (ref.startsWith('kernel:capacity:')) {
      setRegion('coordinator')
      setNote({
        tone: 'muted',
        text: `the draft is kept — edit it and ↵ resends · ${keyHintLabel('⌃x ⌃x')} on the queued row withdraws it`,
      })
      return
    }
    if (ref.startsWith('permission:git-init:')) {
      setRegion('coordinator')
      return
    }
    if (ref.startsWith('permission:')) {
      openObligationOrDoor(obligationId)
      return
    }
    setComposeContext({ kind: 'answer', obligationId, title: o.question })
    setRegion('live')
  }

  const [seatAsk, setSeatAsk] = useState<{ text: string; live: number; ceiling: number } | null>(null)
  const seatAskRef = useRef<{ text: string; live: number; ceiling: number } | null>(null)
  seatAskRef.current = seatAsk
  const answerSeatAsk = (allowed: boolean): void => {
    const ask = seatAskRef.current
    setSeatAsk(null)
    if (ask === null) return
    if (!allowed) {
      setNote({ tone: 'muted', text: 'kept — nothing dispatched; your draft stays' })
      return
    }
    void callbacks.sendCoordinatorMessage?.(ask.text).catch(() => {})
    callbacks.submitSessionDraft(ask.text)
    clearDraft()
  }

  const [contractAsk, setContractAsk] = useState(false)
  const contractAskRef = useRef(contractAsk)
  contractAskRef.current = contractAsk
  const armContractAsk = (): void => {
    if (seatAskRef.current !== null) return
    setContractAsk(true)
  }
  const answerContractAsk = (contractText: string | null): void => {
    setContractAsk(false)
    if (contractText === null) {
      callbacks.newSession?.()
      return
    }
    callbacks.newSession?.({ contractText })
  }

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
  const sendManagerAnswer = (text: string): void => {
    draftEditedRef.current = true
    draftRef.current = { text, caret: text.length }
    setDraft(draftRef.current)
    sendCoordinator()
  }
  const runManagerDispatch = (
    entryId: string,
    plan: import('../../services/concourse/managerMode.js').ManagerPlanV1,
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
      void import('../../services/concourse/managerMode.js').then(m => m.markManagerPlanState(entryId, { state: 'declined' }))
      setNote({ tone: 'muted', text: 'kept as a draft — nothing dispatched; say what to change' })
      return
    }
    const withSupervision = { ...plan, supervision }
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
    runManagerDispatch(ask.entryId, ask.plan, Math.max(0, ask.ceiling - ask.live))
  }
  useEffect(() => {
    if (reducedStage) return
    const rows = sessionRows.map(r => ({ sessionId: r.sessionId, state: r.state }))
    const counts = { live: snapshot.counts.live, ceiling: effectiveSeatCeiling() }
    void import('../../services/concourse/managerMode.js')
      .then(async m => {
        await m.appendManagerSupervisionRows(rows)
        const startedLane = await m.startWaitingManagerLane(counts)
        if (startedLane !== null) callbacks.retrySnapshot?.()
      })
      .catch(() => {})
  }, [snapshot.revision, snapshot.counts.live, reducedStage, sessionRows, callbacks])

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
          text: capacityDecisionReceipt(allowed, r.recommendedSeats),
        })
      })
      .catch(() => {})
  }

  const pastGate = useOpenEventGate()
  const peekSelRow = sessionRows.find(r => r.sessionId === boardSel)
  const peekRowLive =
    rowPeekOpen &&
    peekSelRow !== undefined &&
    (peekSelRow.state === 'working' || peekSelRow.state === 'needs-you' || peekSelRow.state === 'starting')
  const peekLive = useLiveTile(peekSelRow?.sessionId ?? '', peekSelRow?.workspaceDir, peekRowLive)
  const chipLine = useWorkChip(
    peekSelRow?.sessionId ?? '',
    peekSelRow !== undefined && peekSelRow.workspaceDir !== undefined && peekSelRow.state !== 'parked',
  )
  const rowControlNote = controlNotes?.[`board:row-control:${peekSelRow?.sessionId ?? 'none'}`]
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
  const olderRows = olderList !== null ? Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, olderList.entries.length + 1)) : 0
  const focusTall: 'mirror' | 'coordinator' = region === 'coordinator' ? 'coordinator' : 'mirror'
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
    const ring: ConcourseRegion[] = reducedStage ? ['list', 'live'] : ['coordinator', 'list', 'live']
    if (snapshot.needsYou.length > 0) ring.push('rail')
    if (splitActive) ring.push('chat')
    return ring
  }, [snapshot.needsYou.length, reducedStage, splitActive])
  useEffect(() => {
    if (region === 'rail' && snapshot.needsYou.length === 0) setRegion(reducedStage ? 'list' : 'coordinator')
  }, [region, snapshot.needsYou.length, reducedStage])
  useEffect(() => {
    if (reducedStage && region === 'coordinator') setRegion('list')
  }, [region, reducedStage])
  useEffect(() => {
    if (!splitActive && region === 'chat') setRegion(reducedStage ? 'list' : 'live')
  }, [region, splitActive, reducedStage])
  useEffect(() => {
    if (reducedStage) return
    const c = collapseSplitForFrame(termCols, termRows)
    if (c.collapsed) setNote({ tone: 'warning', text: c.line })
    else if (splitAvailableAt(termCols, termRows)) {
      setNote(prev => (prev !== null && prev.text.startsWith('split collapsed') ? null : prev))
    }
  }, [termCols, termRows, reducedStage])
  useEffect(() => {
    if (olderList !== null && geo.peekRows < 2) {
      setOlderList(null)
      setNote({ tone: 'muted', text: 'older chats folded — no room at this height' })
    }
  }, [olderList, geo.peekRows])

  const capsuleRef = useRef<ConcourseCapsuleV2 | null>(null)
  capsuleRef.current = { region, filtering, filter, boardSel, railSel, boardScroll, managerMode: managerArmed }
  useEffect(() => {
    presentationCapsule = null
    return () => {
      presentationCapsule = capsuleRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      event.stopImmediatePropagation()
      if (input === 'y' || input === 'Y') answerCapacityAsk(true)
      else if (input === 'n' || input === 'N' || key.escape) answerCapacityAsk(false)
      return
    }
    if (modalOwner === 'trust-ask') {
      event.stopImmediatePropagation()
      if (input === 'y' || input === 'Y') answerTrustAsk(true)
      else if (input === 'n' || input === 'N' || key.escape) answerTrustAsk(false)
      return
    }
    if (modalOwner !== null && modalOwner !== 'manager-seat-ask' && modalOwner !== 'manager-card') return
    const ctx = composeContextRef.current
    if (key.tab && !filtering) {
      event.stopImmediatePropagation()
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
    if (key.wheelUp || key.wheelDown) {
      const kp = event.keypress as { x?: number; y?: number }
      const overList =
        kp.x !== undefined && kp.y !== undefined
          ? kp.y >= geo.listBand[0] &&
            kp.y <= geo.listBand[1] &&
            kp.x >= (geo.profile === 'wide' ? geo.rightCols[0] : 3) &&
            kp.x <= (geo.profile === 'wide' ? geo.rightCols[1] : 2 + geo.interior)
          : region === 'list'
      if (!overList) return
      event.stopImmediatePropagation()
      if (sessionRows.length === 0) return
      const dir = key.wheelDown ? 1 : -1
      setBoardScroll(v => {
        const base = v ?? Math.max(0, sessionRows.findIndex(r => r.sessionId === boardSelRef.current) - 1)
        return Math.max(0, Math.min(Math.max(0, sessionRows.length - 1), base + dir * 3))
      })
      return
    }
    if (key.ctrl && input === 'a' && !coordinatorOn) {
      event.stopImmediatePropagation()
      void callbacks.switchCoordinatorMode('agent-assisted')
      return
    }
    if (key.ctrl && input === 's' && !reducedStage) {
      event.stopImmediatePropagation()
      openCoordinatorSettings()
      return
    }
    if (key.ctrl && input === 'g') {
      event.stopImmediatePropagation()
      setGroundPickerOpen(v => !v)
      return
    }
    if (key.escape) {
      event.stopImmediatePropagation()
      if (ctx.kind !== 'chat') {
        setComposeContext({ kind: 'chat' })
        return
      }
      if (olderListRef.current !== null) {
        setOlderList(null)
        return
      }
      if (broadcastArmedRef.current) {
        broadcastArmedRef.current = false
        setBroadcastArmed(false)
        return
      }
      if (boardArmedRef.current !== null) {
        boardArmedRef.current = null
        setBoardArmed(null)
        return
      }
      if (rowPeekOpenRef.current) {
        setRowPeekOpen(false)
        return
      }
      if (filterRef.current.text !== '') {
        filterRef.current = { text: '', caret: 0 }
        setFilter(filterRef.current)
        return
      }
      if (markedIdsRef.current.size > 0) {
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
      if (input === 'm' && !key.ctrl && !key.meta && pastGate()) {
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
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) setRowPick({ kind: 'effort', sessionId: target.row.sessionId, title: target.row.title })
        else rowControlRefused(target.reason ?? 'no session to set')
        return
      }
      if (input === 'i' && !key.ctrl && !key.meta && callbacks.interruptSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) callbacks.interruptSession(target.row.sessionId)
        else rowControlRefused(target.reason ?? 'nothing to interrupt')
        return
      }
      if (input === 'p' && !key.ctrl && !key.meta && pastGate()) {
        event.stopImmediatePropagation()
        const target = rowControlSel()
        if (target.row !== undefined) {
          if (target.row.state === 'paused') callbacks.resumeSession(target.row.sessionId)
          else callbacks.pauseAfterTurn(target.row.sessionId)
        } else rowControlRefused(target.reason ?? 'nothing to pause')
        return
      }
      if (input === 'r' && !key.ctrl && !key.meta && !reducedStage && callbacks.renameSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        const sel = sessionRows.find(row => row.sessionId === boardSelRef.current)
        if (!sel || sel.sessionId.startsWith('dispatch:') || sel.door !== undefined || sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) return
        setComposeContext({ kind: 'rename', sessionId: sel.sessionId, title: sel.title })
        setRegion('live')
        return
      }
      if (input === 'n' && !key.ctrl && !key.meta && !reducedStage && callbacks.newSession !== undefined && pastGate()) {
        event.stopImmediatePropagation()
        armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        event.stopImmediatePropagation()
        const out = toggleSplitView(termCols, termRows)
        if (!out.ok) setNote({ tone: 'muted', text: out.reason })
        else setNote(null)
        return
      }
      if ((input === '[' || input === ']') && !key.ctrl && !key.meta && splitActive && pastGate()) {
        event.stopImmediatePropagation()
        nudgeSplitRatio(input === '[' ? -1 : 1)
        return
      }
      if (input === ' ' && !key.ctrl && !key.meta && !reducedStage && pastGate()) {
        event.stopImmediatePropagation()
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel !== undefined) toggleMark(sel.sessionId)
        return
      }
    }
    if (region === 'chat') {
      if (key.return && pastGate()) {
        event.stopImmediatePropagation()
        if (hasFocusedSession()) callbacks.exitToRepl()
        else if (!landingInFlight()) armContractAsk()
        return
      }
      if (input === 's' && !key.ctrl && !key.meta && pastGate()) {
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
      helpKeyFiresFor(region, (region === 'coordinator' ? draftRef : liveDraftRef).current.text.length === 0)
    ) {
      event.stopImmediatePropagation()
      helpOpenRef.current = true
      setHelpOpen(true)
      return
    }
    if (key.return && !key.shift) {
      if (region === 'coordinator') {
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
        const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)
        if (sel) enterSession(sel.sessionId)
        return
      }
      sendLive()
      return
    }
    if (reducedStage) {
      return
    }
    if (region === 'chat') {
      return
    }
    if (region !== 'coordinator' && region !== 'live') {
      return
    }
    const side =
      region === 'coordinator'
        ? { ref: draftRef, undo: undoRef, edit: editDraft, focus: 'coordinator' as ConcourseRegion }
        : { ref: liveDraftRef, undo: liveUndoRef, edit: editLiveDraft, focus: 'live' as ConcourseRegion }
    const liveGateRefusal = (): string | null => {
      if (side.focus === 'coordinator') return null
      if (composeContextRef.current.kind !== 'chat') return null
      if (broadcastFaceOf(markedRowsOf().length) !== null) return null
      const g = liveComposerGate(sessionRows.find(r => r.sessionId === boardSelRef.current))
      return g.ok ? null : g.line
    }
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
      const motion = editorMotionOp(key)
      if (motion !== null) {
        event.stopImmediatePropagation()
        side.edit(motion)
        return
      }
      const vertical = caretVerticalOp(key, side.ref.current)
      if (vertical !== null) {
        event.stopImmediatePropagation()
        side.edit(vertical)
        return
      }
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
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

  const t = useMercuryTokens()
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
            <AnimatedCritterArt def={residentDef} hero specimen />
          ) : null}
          <Text color={t.textMuted}>no sessions running</Text>
        </Box>
      )
    }
    const sel = sessionRows.find(r => r.sessionId === boardSel)
    if (!sel || sel.sessionId.startsWith('dispatch:') || sel.workspaceDir === undefined) {
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

  const restHint = managerOn
    ? 'one goal, one shot — the manager interviews, then plans the lanes'
    : coordinatorOn
      ? 'talk to the coordinator — try "launch two sessions on this project"'
      : 'describe a task — ↵ starts a session with it as title'
  const coordinatorKeysHint = !reducedStage
    ? keyHintLabel(managerOn
      ? '↵ send · ⇧↵ newline · ⇧tab chat mode · tab panes'
      : '↵ send · ⇧↵ newline · ⇧tab manager · tab panes')
    : undefined
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
          ?
            { tone: 'warning' as const, text: `broadcast · sends to ${markedRows.length} sessions · ↵ again sends · esc cancels` }
          : null

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
          const chipNode =
            chipLine !== null ? (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={t.warning} wrap="truncate-end">
                  {GLYPH.ok} {chipLine}
                </Text>
              </Box>
            ) : null
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
          const armedNode =
            boardArmed === sel.sessionId ? (
              <Box height={1} flexShrink={0} overflow="hidden">
                <Text color={t.info} wrap="truncate-end">
                  {GLYPH.handoff} {liveDraft.text.trim().length > 0 ? 'armed — ↵ sends the draft · → enters' : 'armed — ↵ again enters'}
                  {
}
                  {liveDraft.text.trim().length === 0 && liveComposerGate(sel).ok && broadcastFaceOf(markedRows.length) === null ? ' · tab to message' : ''} · esc disarms
                </Text>
              </Box>
            ) : null
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
            onPickExample={text => {
              draftEditedRef.current = true
              draftRef.current = { text, caret: text.length }
              setDraft(draftRef.current)
            }}
            collapsed={geo.profile === 'stacked' && focusTall !== 'coordinator'}
            tailNote={note}
            composerNode={
              geo.profile === 'stacked' && focusTall !== 'coordinator' ? undefined : (
                <ConcourseComposer
                  width={Math.max(24, width - 4)}
                  bandRows={Math.max(1, Math.min(coordBandDesired, rows - 8))}
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
          openCoordinatorModel: () => {
            if (!mayArmBoardModal(modalFactsNow(), 'settings')) return
            openCoordinatorSettings()
          },
          openGroundPicker: () => {
            if (!mayArmBoardModal(modalFactsNow(), 'ground-picker')) return
            setGroundPickerOpen(v => !v)
          },
          ...(callbacks.retrySnapshot !== undefined ? { retrySnapshot: callbacks.retrySnapshot } : {}),
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
      {
}
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

function gitOfferCardRows(folder: string, interior: number, folderHeld: boolean): number {
  const textCols = Math.max(20, interior - 4)
  const descLen = gitOfferDescription(folder, folderHeld).length
  const gitLines = Math.max(1, Math.ceil((`git init(${folder})`.length) / textCols))
  const descLines = Math.max(1, Math.ceil(descLen / textCols))
  return 9 + gitLines + descLines
}

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

function ConcourseKeyAtlas({ cols, rows, chat, reducedStage = false, splitOn = false }: { cols: number; rows: number; chat: boolean; reducedStage?: boolean; splitOn?: boolean }): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-help')
  const stage = { newSession: !reducedStage }
  const sections: Array<{ title: string; keys: ReadonlyArray<{ keys: string; label: string }> }> = [
    { title: 'BROWSE', keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY] },
    { title: 'NEEDS YOU (rail)', keys: regionKeysFor('rail', stage) },
    { title: 'SESSIONS (list)', keys: regionKeysFor('list', stage) },
    ...(reducedStage ? [] : [{ title: 'COORDINATOR (its composer)', keys: regionKeysFor('coordinator', stage) }]),
    { title: 'LIVE VIEW (its composer)', keys: regionKeysFor('live', stage) },
    ...(!reducedStage && splitAvailableAt(cols, rows)
      ? [
          splitOn
            ? { title: 'SPLIT VIEW (s toggles)', keys: regionKeysFor('chat', { ...stage, chatSession: chat }) }
            : { title: 'SPLIT VIEW (s toggles)', keys: [{ keys: 's', label: 'split view' }] },
        ]
      : []),
  ]
  const composedHeight = (list: typeof sections, marker: boolean): number =>
    list.reduce((n, s) => n + 1 + s.keys.length, 0) +
    Math.max(0, list.length - 1) +
    3 +
    2  +
    (marker ? 1 : 0)
  const maxHeight = Math.max(7, rows - 2)
  let shown = sections
  let hiddenSections = 0
  while (shown.length > 1 && composedHeight(shown, hiddenSections > 0) > maxHeight) {
    shown = shown.slice(0, -1)
    hiddenSections++
  }
  const height = composedHeight(shown, hiddenSections > 0) - 2
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
