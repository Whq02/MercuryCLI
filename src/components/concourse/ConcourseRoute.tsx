import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { logForDebugging } from '../../utils/debug.js';
import { getCwd } from '../../utils/cwd.js';
import {
  chatOnlyBoot,
  chatPresent,
  consumeEntryDecisionInput,
  enterBootSettings,
  enterRootRepl,
  registerRouteSurface,
  returnToConcourse,
  surfaceGeneration,
  type SurfaceRoute,
} from '../../context/surfaceRoute.js';
import {
  buildConcourseSnapshot,
  dispatchSeedInputs,
  markParkedCleared,
  OLDER_CHATS_ROW_PREFIX,
  readConcourseSeedOverrides,
  resolveHarnessGround,
  sanitizeLabel,
  subscribeConcourseDraft,
  writeConcourseDraft,
  writeConcourseSeedOverride,
} from '../../services/concourse/concourseSnapshot.js';
import { subscribeObligations, resolveObligation } from '../../services/crew/obligations.js';
import { subscribeCurrentProject } from '../../utils/bootCardFacts.js';
import { getFocusedSessionConnector, hasFocusedSession, subscribeFocusedSessionConnector, withLanding } from '../../services/engine-connector/focusedConnector.js';
import { armEntryWarmth, settleEntryWarmth } from '../../services/concourse/sessionWarmth.js';
import { isCrossProjectFinishedRef } from '../../services/concourse/crossProjectPings.js';
import type { ConcourseCallbacks, ConcourseSnapshotV1, ControlNoteState } from './contracts.js';
import { controlNoteOf, concourseWaitCopy } from './contracts.js';
import { Box, Text, useInput } from '../../ink.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { splitAvailableAt, splitViewOn } from './splitView.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { ConcourseScreen } from './ConcourseScreen.js';
import { SessionWaitingRoom } from './SessionWaitingRoom.js';
import { ConcourseLockup } from './ConcourseHeader.js';

// ============================================================================
//  ConcourseRoute — the LIVE switchboard route surface (the enter/leave
//  over the snapshot seam). Registers 'concourse' with the
//  route owner, builds the atomic snapshot from the real owners, and wires
//  the callbacks to their receipts:
//
//  · enter session → THE HOP (attachAndEnter): the focused slot re-points
//    at the session's connector and the chat shows it whole — the same
//    cockpit, its own model, its consent card, its own numbers; the route
//    flips on the first paint. Nothing is yielded or swapped — every
//    session's runner keeps working, so entering works at any instant,
//    either direction; every row is a managed session, the one the screen
//    started included.
//  · answer & resume → settle the durable obligation ('answered', by the
//    operator, resumption = the session entry) THEN enter the session; open
// → enter WITHOUT resolving.
//  · strip submit → the concourseDispatch op (idempotent
//    clientMessageId; admit + deliver in one authed daemon call); the
// durable draft clears ONLY on the positive receipt — a refusal
//    keeps the draft and drives the resident's TYPED refused state.
//  · 'b' → the Boot Settings route; esc → the exact root REPL.
//
//  Refresh (the workbench armed-heartbeat precedent — armed only while the
//  surface is mounted): obligation/draft store changes + a 15 s bounded
//  poll over the records file; the worker delta channel replaces the
// poll. No idle work while unmounted.
// ============================================================================

// RB-05 (warm re-entry): the last coherent snapshot survives the route
// round trip at module scope — a re-mount paints the PRIOR board as its
// first frame (the operator saw it one second earlier) while the fresh
// rebuild replaces it within a beat; the 'assembling…' shell is only ever
// the FIRST-boot state.
let lastCoherentSnapshot: ConcourseSnapshotV1 | null = null

/** R11 — the snapshot coalescer: ONE active build plus at most ONE pending
 *  rerun. A trigger while a build runs marks the rerun and returns — it
 *  never stacks a concurrent board scan; when the active build settles, the
 *  marked rerun starts and reads all state at ITS OWN start, so every
 *  trigger's state is observed by some completed build (the no-dropped-
 *  trigger law: a trigger either starts a build or is covered by the rerun
 *  that starts after it). `runBuild` must settle (never throw) — the
 *  route's build body catches internally. Exported for the prover; the
 *  route's rebuild is the one product consumer. */
export function makeCoalescedRebuild(
  runBuild: () => Promise<void>,
  isAlive: () => boolean,
): () => void {
  let active = false
  let pending = false
  const kick = (): void => {
    if (active) {
      pending = true
      return
    }
    active = true
    void runBuild().finally(() => {
      active = false
      if (pending && isAlive()) {
        pending = false
        kick()
      }
    })
  }
  return kick
}

function useConcourseSnapshot(): {
  snapshot: ConcourseSnapshotV1 | null
  /** the live rebuild is failing (the snapshot shown is the last
   *  coherent one — or none yet during a failing first load). */
  failing: boolean
  setPeek: (sessionId: string) => void
  noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => void
  refresh: () => void
} {
  const [snapshot, setSnapshot] = useState<ConcourseSnapshotV1 | null>(lastCoherentSnapshot)
  // a failing rebuild KEEPS the last coherent snapshot on screen and
  // raises the degraded flag — the frame carries the notice + clear retry.
  const [failing, setFailing] = useState(false)
  const peekRef = useRef<string | undefined>(undefined)
  const residentRef = useRef<'wink' | 'refused' | 'held' | undefined>(undefined)
  // AT-02: the kernel's own diagnosis rides beside the resident state —
  // composed onto the built snapshot's peek (the caption paints it).
  const residentReasonRef = useRef<string | undefined>(undefined)
  const alive = useRef(true)
  // R7 C-MED-6: every trigger (draft keystrokes, the delta watcher, the
  // tick, peek changes) funnels through ONE coalesced rebuild — one active
  // build plus at most one pending rerun (makeCoalescedRebuild below), so
  // typing can never stack concurrent board scans; the rerun re-reads the
  // peek/resident refs and the stores at its own start, so no trigger's
  // state is ever dropped. The sequence fence survives as the belt: even
  // across the active→rerun chain only the newest build's result lands (an
  // older build landing last would regress the board AND feed a stale
  // draft echo into the pending-write ledger — typed text visibly
  // reverts).
  const buildSeq = useRef(0)
  const rebuild = useMemo(
    () =>
      makeCoalescedRebuild(async () => {
        const seq = ++buildSeq.current
        try {
          const s = await buildConcourseSnapshot({
            ...(peekRef.current !== undefined ? { peekSessionId: peekRef.current } : {}),
            ...(residentRef.current !== undefined ? { residentOverride: residentRef.current } : {}),
          })
          if (!alive.current || seq !== buildSeq.current) return
          const reason = residentReasonRef.current
          const next =
            reason !== undefined && s.peek !== null
              ? { ...s, peek: { ...s.peek, residentReason: reason } }
              : s
          lastCoherentSnapshot = next
          setSnapshot(next)
          setFailing(false)
        } catch (e) {
          logForDebugging(`[concourse] snapshot rebuild failed: ${e}`)
          if (alive.current && seq === buildSeq.current) setFailing(true)
        }
      }, () => alive.current),
    [],
  )
  // The assisted coordinator's obligation-open trigger — fires
  // ONLY under effective agent-assisted (Rules-only's needs-you emission is
  // owned by the hook; the policy revision dedup would no-op a double
  // anyway, but one owner is the law). Bounded: new OPEN ids since the last
  // sweep; the lane dedupes equivalent triggers again on its own.
  // The board runs NO obligation-open ride (FN-017 rank 8): that event's
  // only decision is kernel rule R3 (signal.emit), whose one live owner is
  // useObligationSignals in the REPL with a real sender. The board's sweep
  // was a second wire through the kernel's stub sender — it raced the hook
  // for the obligation's revision and, when it won, burned it: no host
  // notification, no activation pointer, permanently. The kernel now
  // refuses an emission with no sender; the board simply does not ask.
  useEffect(() => {
    alive.current = true
    rebuild()
    const unsubObl = subscribeObligations(
      () => {
        rebuild()
      },
      { scope: 'switchboard' },
    )
    const unsubDraft = subscribeConcourseDraft(rebuild)
    // THE BOARD RE-SCOPES ON THE PROJECT BEAT (the concourse is the control
    // plane and shows the current project's chats): the catalog door fires
    // on a ground move (the REPO picker, the boot face's Projects) and when
    // a first chat is catalogued while the board is up — the rows follow.
    const unsubProject = subscribeCurrentProject(rebuild)
    // THE BOARD FOLLOWS THE FOCUS (cross-project awareness, laws 2/3): the
    // ★ carry-over is derived from the slot, so a hop re-points it and the
    // board must re-derive within a beat — the carried row appears when the
    // focused chat leaves the current project's view and is handed back
    // SILENTLY when a session of the current project takes the slot (no
    // notice, no state change: it is simply no longer derived).
    const unsubSlot = subscribeFocusedSessionConnector(() => rebuild())
    // PUSH over poll — the daemon stamps
    // concourse-delta.json on every roster transition; watching its
    // directory wakes the rebuild within a beat. The revision (pid-scoped)
    // guards duplicate wakes; the 15 s tick below survives as the fallback
    // heartbeat for transports the watcher cannot see.
    let watcher: import('node:fs').FSWatcher | null = null
    let lastDelta = ''
    void Promise.all([import('../../daemon/concourseSupervisor.js'), import('node:fs')])
      .then(([sup, fs]) => {
        if (!alive.current) return
        const deltaPath = sup.concourseDeltaPath()
        // WIN-2: node:path derivation — the '/' split carved a junk dir on
        // win32 and armed an inert watcher (board silently degraded to the
        // heartbeat).
        const dir = dirname(deltaPath)
        const name = basename(deltaPath)
        try {
          fs.mkdirSync(dir, { recursive: true })
          watcher = fs.watch(dir, (_ev, file) => {
            if (file !== null && file !== name) return
            try {
              const raw = fs.readFileSync(deltaPath, 'utf8')
              const stamp = JSON.parse(raw) as { pid?: number; revision?: number }
              const key = `${stamp.pid ?? 0}:${stamp.revision ?? 0}`
              if (key === lastDelta) return
              lastDelta = key
            } catch {
              /* unreadable mid-rename — the rebuild below is still safe */
            }
            rebuild()
          })
          // An unlistened FSWatcher 'error' is an uncaught exception; the
          // 15s rebuild poll below already carries a dead watcher.
          watcher.on('error', () => {
            try {
              watcher?.close()
            } catch {
              /* already closed */
            }
            watcher = null
          })
        } catch {
          /* no watcher on this transport — the heartbeat poll still stands */
        }
      })
      .catch(() => {})
    const timer = setInterval(rebuild, 15_000)
    timer.unref?.()
    return () => {
      alive.current = false
      unsubObl()
      unsubDraft()
      unsubProject()
      unsubSlot()
      watcher?.close()
      clearInterval(timer)
    }
  }, [rebuild])
  return {
    snapshot,
    setPeek: (sessionId: string) => {
      peekRef.current = sessionId
      residentRef.current = undefined
      rebuild()
    },
    noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => {
      residentRef.current = state
      residentReasonRef.current = reason
      rebuild()
    },
    refresh: rebuild,
    failing,
  }
}

/** The capture seam (registered MERCURY_CONCOURSE_FIXTURE): the render/
 * parity scenarios drive the reference seed through the REAL route +
 *  screen machinery. Read once at mount; unset ⇒ null (production). */
function readFixtureSnapshot(): ConcourseSnapshotV1 | null {
  try {
    const path = process.env['MERCURY_CONCOURSE_FIXTURE']
    if (!path) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConcourseSnapshotV1
    if (parsed.schema !== 1) return null
    // The label floor guards THIS entry too — the live builder floors
    // its own labels; a fixture (test seam) must not smuggle control bytes
    // past the one renderer boundary.
    const floor = <T extends { title: string }>(r: T): T => ({ ...r, title: sanitizeLabel(r.title) })
    return {
      ...parsed,
      needsYou: parsed.needsYou.map(o => ({ ...floor(o), question: sanitizeLabel(o.question) })),
      groups: parsed.groups.map(g => ({ ...g, rows: g.rows.map(floor) })),
      peek: parsed.peek ? floor(parsed.peek) : null,
    }
  } catch {
    return null
  }
}

function LiveConcourse(): React.ReactNode {
  const fixture = useMemo(() => readFixtureSnapshot(), [])
  const { snapshot: liveSnapshot, failing, setPeek, noteResident: noteLiveResident, refresh } = useConcourseSnapshot()
  // THE STAY-IN-SPLIT LAW (the split-view sheet, item 3): while the split
  // frame composes (the operator's switch on AND the frame affording — the
  // screen derives composition from the same two facts), entering or
  // reactivating a row and the New Session birth KEEP the concourse route:
  // the hop re-points the one focused slot, the chat pane swaps to it, the
  // board side never loses its place. The full chat stays one deliberate
  // move away (the chat pane's ↵, shift+→, esc). Width rides a ref so the
  // async enter legs read the frame at COMPLETION, never a stale capture.
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const termColsRef = useRef(termCols)
  termColsRef.current = termCols
  // The rows leg rides the same ref discipline: the async
  // enter legs read the frame at COMPLETION, never a stale capture.
  const termRowsRef = useRef(termRows)
  termRowsRef.current = termRows
  const splitFrameStands = useCallback(
    (): boolean => splitViewOn() && splitAvailableAt(termColsRef.current, termRowsRef.current),
    [],
  )
  // THE OLDER CHATS BROWSE (operator, L20 — superseding the L11 /sessions
  // arm): ↵ on the "N older chats" line unfolds the census's drop-down IN
  // PLACE on the board (the screen owns it); a pick reactivates through
  // resumeOlderChat below — the SAME focusResumedSession leg a parked
  // row's ↵ rides. The board keeps the frame; no route change, no shunt.
  // pending/applied/refused receipts BESIDE the originating control.
  // 'pending' paints the moment the operator acts; the kernel receipt flips
  // it to applied/refused, which clears after a short beat (pending never
  // auto-clears — an in-flight op stays visible until it settles).
  const [controlNotes, setControlNotes] = useState<Readonly<Record<string, ControlNoteState>>>({})
  // Frontier B-quick-win (state-async-truth-06): the retired equal-state
  // guard let the FIRST refusal's timer delete the SECOND refusal's note
  // early (prev[control] !== state is false when the states match). Each
  // note now carries a monotonic identity its own timer checks, stale
  // timers clear on replacement, and unmount clears them all.
  const noteSeqRef = useRef(0)
  const noteIdentityRef = useRef<Record<string, number>>({})
  const noteTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(
    () => () => {
      for (const t of Object.values(noteTimersRef.current)) clearTimeout(t)
      noteTimersRef.current = {}
    },
    [],
  )
  // BOARD CONTROLS item 1: the row receipt's who/what/when — every row
  // control paints its settle on the SELECTED row (the board:row-control
  // slot under it), spelled as the deed, the actor and the clock.
  const rowReceiptClock = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const rowReceipt = (what: string): string => `${what} — you · ${rowReceiptClock()}`
  // AT-05: the ONE receipt→note mapping — a kernel 'noop' is an APPLIED
  // no-change with its own reason (pausing an already-paused session is not
  // a refusal); refusals carry the kernel's detail verbatim; 'failed' is
  // transport loss (retryable — the identity was kept, the retry replays).
  const noteFromReceipt = (receipt: { outcome?: string; detail?: string }): ControlNoteState =>
    receipt.outcome === 'applied'
      ? 'applied'
      : receipt.outcome === 'noop'
        ? { state: 'applied', reason: receipt.detail ?? 'no change' }
        : receipt.outcome === 'failed'
          ? {
              state: 'failed',
              reason: receipt.detail ?? 'the daemon did not answer',
              next: '↵ retries the same request',
            }
          : {
              state: 'refused',
              ...(receipt.detail !== undefined ? { reason: receipt.detail } : {}),
              // Advisor: a valid refusal names its next step — the
              // draft is preserved by the CU-05 law, so the retry is real.
              next: 'the draft is kept · ↵ retries',
            }
  const noteControl = useCallback((control: string, state: ControlNoteState): void => {
    setControlNotes(prev => ({ ...prev, [control]: state }))
    const mySeq = ++noteSeqRef.current
    noteIdentityRef.current[control] = mySeq
    const stale = noteTimersRef.current[control]
    if (stale !== undefined) {
      clearTimeout(stale)
      delete noteTimersRef.current[control]
    }
    // R7 + item 8: classify through
    // the ONE normalizer — refused AND failed notes carry a reason + next
    // step and must outlive a glance, whatever shape the call site passed
    // (bare word or reasoned object). A raw string compare here silently
    // demoted every OBJECT-shaped refusal to the 4s applied cadence.
    const kind = controlNoteOf(state).state
    if (kind !== 'pending') {
      // A refusal must outlive a glance (never a near-silent
      // refusal) — it lingers well past the applied receipt's short beat.
      // Any newer action on the same control overwrites the note at once.
      const timer = setTimeout(() => {
        if (noteIdentityRef.current[control] !== mySeq) return // superseded
        delete noteTimersRef.current[control]
        setControlNotes(prev => {
          const next = { ...prev }
          delete next[control]
          return next
        })
      }, kind === 'refused' || kind === 'failed' ? 10_000 : 4000)
      timer.unref?.()
      noteTimersRef.current[control] = timer
    }
  }, [])
  // R7 C-HIGH-2 (true replay, redirect leg): the id is the instruction's
  // identity for its target — a paused-target HOLD delivers on the replay of
  // the SAME id after resume. Held refusals retain it; anything else mints
  // fresh next time. ONE slot PER TARGET: a broadcast fan of N sends
  // overwrote a single slot N−1 times, so only the last target's held or
  // transport-lost delivery kept its replay identity — an earlier target's
  // re-send minted fresh, and the daemon's idempotent door could not dedupe
  // a first send that had in fact landed (a double delivery).
  const redirectIdRef = useRef<Map<string, { instruction: string; id: string }>>(new Map())
  // Advisor item 8: pause/resume now carry durable clientOpIds — one per
  // human intent per session, kept across 'failed' (transport-loss)
  // receipts so the retry replays into the daemon's applied-ops ledger.
  // The retained identity is the IMMEDIATE retry's, never a standing token
  // (3-3-3 challenge): it expires with the retry window, and BOTH of a
  // session's held ids die on any authoritative receipt — a resume landing
  // after a lost pause must not let a later pause replay the stale op.
  const controlOpIdRef = useRef<Map<string, { id: string; mintedAtMs: number }>>(new Map())
  const CONTROL_RETRY_WINDOW_MS = 15_000
  const mintControlOpId = useCallback((key: string, fresh: string): string => {
    const held = controlOpIdRef.current.get(key)
    const id = held !== undefined && Date.now() - held.mintedAtMs < CONTROL_RETRY_WINDOW_MS ? held.id : fresh
    controlOpIdRef.current.set(key, { id, mintedAtMs: held?.id === id ? held.mintedAtMs : Date.now() })
    return id
  }, [])
  // Frontier B1 (state-async-truth-14): pause/resume carry NO operation
  // identity — the concourseControl RPC has no clientMessageId (unlike the
  // concourseDispatch door redirect/answer/submit ride), so N rapid presses
  // fired N kernel ops with N receipt feed rows. One in-flight latch per
  // control settles duplicate clicks/↵ through exactly ONE operation; the
  // pending note (painted at once) is the visible truth, and the latch
  // releases on settle so a deliberate later press is a real new op.
  const peekOpInFlight = useRef<Set<string>>(new Set())
  // The resident note must paint through the FIXTURE seam too (the live
  // hook's override rides its own rebuild, which a static fixture masks) —
  // one local mirror composes over whichever snapshot wins below.
  const [residentNote, setResidentNote] = useState<
    { state: 'wink' | 'refused' | 'held'; reason?: string } | undefined
  >(undefined)
  const noteResident = useCallback(
    (state: 'wink' | 'refused' | 'held', reason?: string): void => {
      setResidentNote({ state, ...(reason !== undefined ? { reason } : {}) })
      noteLiveResident(state, reason)
    },
    [noteLiveResident],
  )
  const snapshot =
    fixture !== null
      ? residentNote !== undefined && fixture.peek !== null
        ? {
            ...fixture,
            peek: {
              ...fixture.peek,
              residentState: residentNote.state,
              ...(residentNote.reason !== undefined ? { residentReason: residentNote.reason } : {}),
            },
          }
        : fixture
      : liveSnapshot
  const snapshotRef = useRef<typeof snapshot>(null)
  snapshotRef.current = snapshot
  // THE STOP RECEIPT FOLLOWS THE ROW (the stop law): a stop the daemon
  // answered "stop sent — …" is on its way, and the removal hint belongs to
  // the moment the record reads stopped (the runner's acknowledgement,
  // never the kill's dispatch). The ids whose receipt still says "sent"
  // wait here; when their row lands stopped the receipt advances.
  const stopAwaitingStampRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const waiting = stopAwaitingStampRef.current
    if (waiting.size === 0) return
    for (const row of (snapshot?.groups ?? []).flatMap(g => g.rows)) {
      if (!waiting.has(row.sessionId) || row.state !== 'stopped') continue
      waiting.delete(row.sessionId)
      noteControl('strip:composer', { state: 'applied', reason: `stopped — ${keyHintLabel('⌃x ⌃x')} archives it (the chat stands parked)` })
    }
  }, [snapshot, noteControl])
  // ── enter = a WINDOW onto the session ────────────────────────────────
  // The real REPL opens onto the session at once — its chat read live from
  // its own file, the composer delivering through the daemon — and the route
  // flips the moment the first read painted. Nothing is yielded, drained,
  // killed or swapped: the session's runner keeps working, the seat's engine
  // keeps working, and entering works at any instant in either direction,
  // any number of times. A different session chosen while one opens
  // supersedes it (the last-chosen session wins).
  const enterOpRef = useRef<{ sessionId: string; gen: number } | null>(null)
  // a queued row opens a WAITING ROOM, never a
  // refusal — seat-neutral (no admission call exists on this path).
  const [waitingRoom, setWaitingRoom] = useState<{
    dispatchId: string
    title: string
    project: string
  } | null>(null)
  // Deliver the room's stacked messages IN ORDER once the
  // session exists — remove an entry only on a positive receipt; the ledger
  // answers 'replayed' for already-delivered ids (exactly-once).
  const drainQueuedStack = useCallback(async (dispatchId: string, sessionId: string): Promise<void> => {
    try {
      const store = await import('../../services/concourse/concourseSnapshot.js')
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const entries = await store.readConcourseQueuedStack(dispatchId)
      for (const entry of entries) {
        const reply = (await daemonControlRpc(
          {
            op: 'concourseDispatch',
            clientMessageId: entry.clientMessageId,
            prompt: entry.text,
            workspaceDir: '',
            targetSessionId: sessionId,
            by: 'operator',
          } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; refusal?: string }
        if (reply.ok === true) {
          await store.removeConcourseQueuedStackEntry(dispatchId, entry.clientMessageId)
        } else if (reply.refusal === 'edited-replay') {
          // Unrecoverable identity clash — keeping it would wedge the FIFO.
          await store.removeConcourseQueuedStackEntry(dispatchId, entry.clientMessageId)
        } else {
          break
        }
      }
    } catch (e) {
      // Fail-soft, never SILENT — a thrown TypeError here read as
      // "nothing queued" with zero trace.
      logForDebugging(`[concourse] queued-stack drain failed (replayed next pump): ${e}`)
    }
  }, [])
  const attachAndEnter = useCallback(
    (
      sessionId: string,
      noteKey: string,
      opts?: { fullChat?: boolean; parkedFact?: { transcriptPath: string; title: string }; entry?: 'dispatch' | 'settled' },
    ): void => {
      if (sessionId.startsWith('dispatch:')) {
        noteControl(noteKey, {
          state: 'refused',
          reason: 'still waiting for a seat',
          next: 'it starts when one frees',
        })
        return
      }
      if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
        // THE OLDER LINE UNFOLDS ON THE BOARD (L20): its ↵ is the screen's
        // own drop-down, never a route change — an older id reaching this
        // door is a wiring defect, answered in type, not with a shunt.
        noteControl(noteKey, { state: 'refused', reason: 'the older chats unfold on the board — ↵ on the line opens them' })
        return
      }
      // THE CONCOURSE IS THE CONTROL PLANE (Law 9, rule 4): a PARKED row
      // names a chat of the current project with no runner — ↵ REACTIVATES
      // it in place through the estate's ONE resume door
      // (focusResumedSession, the door Projects-↵ rides): its transcript
      // paints first, the daemon admits the same durable session behind the
      // paint, it becomes the focused chat (shift+←/→ ordinary from there),
      // and the next snapshot paints it as a live row — born through the one
      // path, never a second writer of records. The session keeps its own
      // ground; the harness ground is the rail's pick, untouched by a resume.
      // An OLDER chat from the census drop-down rides the SAME leg: its
      // fact arrives as `parkedFact` because no board row carries it.
      const row = snapshotRef.current?.groups.flatMap(g => g.rows).find(r => r.sessionId === sessionId)
      const rowParked = row?.state === 'parked' ? { transcriptPath: row.transcriptPath, title: row.title } : undefined
      const parked = opts?.parkedFact ?? rowParked
      const op = { sessionId, gen: surfaceGeneration() }
      enterOpRef.current = op
      noteControl(noteKey, { state: 'pending', reason: parked !== undefined ? 'bringing it back…' : 'opening…' })
      // paint-from-warmth: the entry ARMS the paint hint at the decision —
      // the revealed chat's first frame carries the viewer's warm tail (or
      // the honest loading row) while the fold lands behind; settled in the
      // finally below (landing-settled either way — the fold is the truth).
      // The arm names the COVERED identity too — the session still holding
      // the slot at this decision (C → board → A): until the hop re-points,
      // the revealed chat's mount IS that session, and the hint must cover
      // its records rather than die as a mismatch (the identity law).
      armEntryWarmth(sessionId, row?.title ?? parked?.title, hasFocusedSession() ? getFocusedSessionConnector().sessionId() : undefined)
      // THE HOP: the focused slot re-points at the session's connector (its
      // records paint first — the flicker law). Armed SYNCHRONOUSLY through
      // withLanding so the landing gate opens in the committing event's own
      // dispatch — the chat is "in flight" before this handler returns and
      // the entry commit below has a chat to flip onto. Nothing is yielded
      // or swapped.
      const landing = withLanding(
        (async () => {
          const hops = await import('../../services/switchboard/hopIntoSession.js')
          return parked !== undefined
            ? await hops.focusResumedSession(sessionId, parked.transcriptPath, { title: parked.title })
            : await hops.hopIntoBoardSession(sessionId)
        })(),
      )
      // THE ENTRY COMMIT LANDS IN THE COMMITTING DISPATCH (the
      // input-generation-leak closure): the operator's confirming ↵ or
      // click commits the transition NOW — commitTransition consumes the
      // committing event and its chunk-mates at the law's own watermark
      // (surfaceRoute R1a), so a doubled enter can never leak through the
      // transition into the revealed composer. The hop lands BEHIND the
      // flip (the slot re-point keeps the epoch fence — last-chosen wins);
      // the paint half of this ordering — the revealed chat's first frame
      // carrying content instead of a cold fold — is paint-from-warmth's.
      // While the split frame stands, a row enter is the SLOT re-point
      // alone — the chat pane swaps, the route holds (stay-in-split) — and
      // the SAME decision consumes the committing input through the route
      // owner's no-transition door; a journey whose purpose NEEDS the full
      // chat (the rail's answer routes to the consent card, which lives
      // only there) flips even while the split frame stands. A 'settled'
      // entry (the waiting room's admit, the obligation door's post-read
      // open — continuations that left the deciding dispatch long ago)
      // keeps the landed late-flip shape: a consumption stamped outside
      // the deciding dispatch would eat keystrokes typed meanwhile.
      const settled = opts?.entry === 'settled'
      const split = splitFrameStands() && opts?.fullChat !== true
      let flippedGen: number | null = null
      if (!settled) {
        if (split) {
          consumeEntryDecisionInput()
        } else if (enterRootRepl().ok) {
          flippedGen = surfaceGeneration()
        }
      }
      void (async () => {
        try {
          const hop = await landing
          if (!hop.ok) {
            noteControl(noteKey, { state: 'refused', reason: hop.reason })
            // The entry flipped onto a chat that never landed: the frame
            // returns to the board — the exact ground the operator chose
            // from — unless they navigated since (the yank law). This
            // microtask always beats the REPL's absent-chat settle (a
            // timeout), so a failed entry never bounces to the boot face.
            if (flippedGen !== null && surfaceGeneration() === flippedGen) returnToConcourse()
            return
          }
          if (enterOpRef.current !== op) return
          if (!settled) {
            noteControl(noteKey, split ? { state: 'applied', reason: 'in the chat pane' } : 'applied')
            return
          }
          // The yank law for the 'settled' legs: a late leg never drags a
          // navigating operator — the route flips only while they have not
          // moved since their choice (the slot keeps the session either
          // way: views are not sessions).
          if (surfaceGeneration() === op.gen) {
            if (splitFrameStands() && opts?.fullChat !== true) {
              noteControl(noteKey, { state: 'applied', reason: 'in the chat pane' })
            } else {
              noteControl(noteKey, 'applied')
              enterRootRepl()
            }
          }
        } catch (e) {
          logForDebugging(`[switchboard] hop failed: ${e}`)
          noteControl(noteKey, { state: 'failed', reason: 'the session could not be opened', next: '↵ retries' })
          if (flippedGen !== null && surfaceGeneration() === flippedGen) returnToConcourse()
        } finally {
          // Landing settled (records on hand, refused, or thrown): the
          // paint hint stands down — per-session, so a newer entry's arm
          // survives this older landing's settle.
          settleEntryWarmth(sessionId)
          if (enterOpRef.current === op) enterOpRef.current = null
        }
      })()
    },
    [noteControl, splitFrameStands],
  )
  const waitingRoomAdmitted = useCallback(
    (dispatchId: string, sessionId: string): void => {
      void (async () => {
        await drainQueuedStack(dispatchId, sessionId)
        setWaitingRoom(null)
        setPeek(sessionId)
        // 'settled': the admit arrived from the daemon, not a keystroke —
        // the entry keeps the landed late-flip shape (no input consumption
        // outside a deciding dispatch).
        attachAndEnter(sessionId, 'board:open', { entry: 'settled' })
      })()
    },
    [drainQueuedStack, attachAndEnter],
  )
  const callbacks = useMemo<ConcourseCallbacks>(
    () => ({
      // receipts beside controls — the screen's own guards paint
      // through the same note store (R7 E-MED-6's queued board ↵).
      noteControl,
      enterSession: sessionId => {
        // Item 5: entering a QUEUED session opens NO screen — the screen's
        // own guard paints the in-place queued line first; a dispatch id
        // reaching here anyway lands in attachAndEnter's typed refusal
        // (never the retired void screen).
        if (!sessionId.startsWith('dispatch:')) setPeek(sessionId)
        attachAndEnter(sessionId, 'board:open')
      },
      // THE OLDER-CHATS BROWSE (L20): a census pick reactivates through the
      // ONE resume door — the parked leg, its fact handed through because
      // no board row carries a record-less older chat.
      resumeOlderChat: (sessionId, transcriptPath, title) => {
        attachAndEnter(sessionId, 'board:open', { parkedFact: { transcriptPath, title } })
      },
      // The deliver-on-start room, EXPLICITLY: 'm' on the queued row and the
      // rail's 'open session' on a queued question come here; ↵ never does.
      openQueuedRoom: sessionId => {
        if (!sessionId.startsWith('dispatch:')) return
        const row = snapshotRef.current?.groups
          .flatMap(g => g.rows)
          .find(r => r.sessionId === sessionId)
        setWaitingRoom({
          dispatchId: sessionId.slice('dispatch:'.length),
          title: row?.title ?? 'queued session',
          project: row?.projectLabel ?? '',
        })
      },
      peekSession: sessionId => {
        setResidentNote(undefined)
        setPeek(sessionId)
      },
      answerObligation: (obligationId, answer) => {
        // (the H answer law): the typed answer DELIVERS to the exact
        // session through the kernel's obligation.answer verb — the same
        // idempotent dispatch door — and only the delivery receipt settles
        // the obligation. A refused delivery (dead session, unreachable
        // daemon) leaves the question OPEN with a visible typed refusal.
        noteControl('strip:composer', 'pending')
        void (async () => {
          try {
            const o = await import('../../services/crew/obligations.js')
            const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
            if (!row || row.status !== 'open') {
              // The C3 discipline: a stale click racing an elsewhere-answered
              // question is a VISIBLE typed refusal, never silence.
              noteResident('refused', 'this question already settled elsewhere')
              noteControl('strip:composer', {
                state: 'refused',
                reason: 'this question already settled elsewhere',
                next: 'the rail shows what is still open',
              })
              refresh()
              return
            }
            const kernel = await import('../../services/concourse/coordinatorKernel.js')
            const receipt = await kernel.executeKernelDecision({
              verb: 'obligation.answer',
              obligationId,
              sessionId: row.sessionId,
              // Stable per obligation: a retry after a typed HOLD/refusal
              // REPLAYS the same delivery instead of double-delivering.
              clientMessageId: `obl-answer:${obligationId}`,
              answer,
              by: 'operator',
            })
            const feed = await import('../../services/concourse/coordinatorReceipts.js')
            feed.ingestCoordinatorReceipts([{ ...receipt, actorAgentId: 'operator' }])
            if (receipt.outcome === 'refused') noteResident('refused', receipt.detail)
            else if (receipt.outcome === 'failed') noteResident('held', receipt.detail)
            noteControl('strip:composer', noteFromReceipt(receipt as { outcome?: string; detail?: string }))
          } catch (e) {
            logForDebugging(`[concourse] answer failed: ${e}`)
            noteResident('held', 'the delivery failed — ↵ retries the same delivery')
            noteControl('strip:composer', { state: 'failed', reason: 'the delivery failed', next: '↵ retries the same delivery' })
          }
          refresh()
        })()
      },
      // Q2 (the ask-wire): y/n on a parked permission ask — the daemon
      // routes the control_response back through the child's own channel.
      answerPermission: (requestId, allow, obligationId) => {
        void (async () => {
          try {
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const o = await import('../../services/crew/obligations.js')
            const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
            const reply = (await daemonControlRpc(
              {
                op: 'concourseControl',
                action: 'answer-permission',
                sessionId: row?.sessionId ?? 'unknown',
                by: 'operator',
                requestId,
                allow,
              } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string }
            if (reply.ok === true && reply.outcome === 'applied') {
              noteControl('strip:composer', { state: 'applied', reason: allow ? 'allowed' : 'denied' })
            } else {
              noteControl('strip:composer', {
                state: 'refused',
                reason: reply.detail ?? 'the ask was already answered',
              })
            }
          } catch {
            noteControl('strip:composer', {
              state: 'failed',
              reason: 'the daemon was unreachable',
              next: 'answer again from the rail',
            })
          }
          refresh()
        })()
      },
      // The close chord's STOP stage (⌃x ⌃x — the plain-x verb retired):
      // stop keeps the row visible as 'stopped'; the same
      // completed chord again releases it (row leaves the board, the
      // transcript survives). Both heal the daemon first.
      stopSession: sessionId => {
        void (async () => {
          try {
            const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
            const daemonUp = await ensureOwnedDaemon()
            if (!daemonUp) {
              // No daemon to ask: a runner that died with it is stopped in
              // the record directly (nothing to kill — the stop verb stamps
              // a dead pid without a roster); a live runner under an
              // unreachable daemon is left alone with the reason on screen.
              const supervisor = await import('../../daemon/concourseSupervisor.js')
              const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
              const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
              const runnerAlive = rec?.pid !== undefined && isProcessAlive(rec.pid)
              if (rec !== undefined && !runnerAlive) {
                const out = supervisor.stopConcourseSession(sessionId, 'operator', undefined)
                noteControl(
                  'strip:composer',
                  out.outcome === 'refused'
                    ? { state: 'refused', reason: out.detail ?? out.reason }
                    : out.outcome === 'applied' && !out.acknowledged
                      ? (stopAwaitingStampRef.current.add(sessionId), { state: 'applied', reason: `stop sent — ${out.runnerId} ends its turn; the row reads stopped once it is gone` })
                      : { state: 'applied', reason: `stopped — ${keyHintLabel('⌃x ⌃x')} archives it (the chat stands parked)` },
                )
              } else {
                noteControl('strip:composer', { state: 'failed', reason: 'the daemon that hosts sessions is not reachable and the runner is alive', next: `${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` })
              }
              refresh()
              return
            }
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const reply = (await daemonControlRpc(
              { op: 'concourseControl', action: 'stop', sessionId, by: 'operator' } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string; error?: string; code?: string }
            // The refusal paints the daemon's OWN sentence — the handler's
            // detail, else the wire's error and code — never a bare "stop
            // refused" that hides why (the operator's x-x on their only
            // session read exactly that). An applied stop paints the verb's
            // detail too: a stop still on its way ("stop sent — …") says so
            // while the runner is going, and the removal hint appears only
            // once the record's stamp has landed (the runner is gone) —
            // the record reads stopped on the runner's acknowledgement,
            // never on the kill's dispatch.
            const acknowledged = reply.ok === true && reply.outcome === 'applied' && /^stopped /.test(reply.detail ?? '')
            if (reply.ok === true && reply.outcome === 'applied' && !acknowledged && reply.detail !== undefined) stopAwaitingStampRef.current.add(sessionId)
            noteControl(
              'strip:composer',
              reply.ok === true && reply.outcome !== 'refused'
                ? {
                    state: 'applied',
                    reason: acknowledged || reply.outcome === 'noop' || reply.detail === undefined ? `stopped — ${keyHintLabel('⌃x ⌃x')} archives it (the chat stands parked)` : reply.detail,
                  }
                : { state: 'refused', reason: reply.detail ?? reply.error ?? `stop refused${reply.code !== undefined ? ` (${reply.code})` : ''}` },
            )
          } catch {
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: `${keyHintLabel('⌃x ⌃x')} retries` })
          }
          refresh()
        })()
      },
      // THE ARCHIVE RUNG (the close chord's second): the stopped row PARKS —
      // the record stands parked on the board (the chat survives; ↵ brings it
      // back, ⇧→ may still enter it) until the third rung deletes it. The
      // daemon's park verb stamps a dead runner's record parked by intent.
      archiveSession: sessionId => {
        void (async () => {
          try {
            const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
            const daemonUp = await ensureOwnedDaemon()
            if (!daemonUp) {
              noteControl('strip:composer', { state: 'failed', reason: 'the daemon that hosts sessions is not reachable', next: `${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` })
              refresh()
              return
            }
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const reply = (await daemonControlRpc(
              { op: 'sessionControl', action: 'park', sessionId, by: 'operator' } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string; error?: string; code?: string }
            noteControl(
              'strip:composer',
              reply.ok === true && reply.outcome !== 'refused'
                ? { state: 'applied', reason: `archived — the chat stands parked; ${keyHintLabel('⌃x ⌃x')} again deletes it` }
                : { state: 'refused', reason: reply.detail ?? reply.error ?? `archive refused${reply.code !== undefined ? ` (${reply.code})` : ''}` },
            )
          } catch {
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: `${keyHintLabel('⌃x ⌃x')} retries` })
          }
          refresh()
        })()
      },
      removeSession: sessionId => {
        void (async () => {
          try {
            if (sessionId.startsWith('dispatch:')) {
              // A queued row is a held reservation, not a session — x
              // withdraws it in one press (resending recreates it). SB-C6:
              // through the daemon's ledger mutex, never a cross-process
              // direct write racing an in-flight dispatch. A daemon-less
              // board (nothing running) falls back to the direct write —
              // no writer exists to race.
              const clientMessageId = sessionId.slice('dispatch:'.length)
              let gone = false
              try {
                const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
                const reply = (await daemonControlRpc(
                  { op: 'concourseWithdraw', clientMessageId } as never,
                  { timeoutMs: 10_000 },
                )) as { ok?: boolean; withdrawn?: boolean }
                if (reply.ok !== true) throw new Error('withdraw rpc refused')
                gone = reply.withdrawn === true
              } catch {
                const { withdrawConcourseDispatch } = await import('../../daemon/concourseDispatch.js')
                gone = withdrawConcourseDispatch(clientMessageId)
              }
              noteControl(
                'strip:composer',
                gone
                  ? { state: 'applied', reason: 'withdrawn — the queued request left the board' }
                  : { state: 'applied', reason: 'already off the board' },
              )
              refresh()
              return
            }
            // THE DOUBLE-X ON A PARKED ROW (the concourse-as-resume rule, 3):
            // no runner to stop — the board's own cleared mark is the first
            // effect, exactly what a release leaves behind for a live row
            // (the chat survives on disk; the boot face and /resume still
            // offer it). A parked row with NO record (transcript history)
            // needs no daemon and ends here; a parked RECORD (the operator
            // closed that chat — the daemon's close state) is released
            // through the same release door a live row rides below, so the
            // row leaves the board for good (the record ends; the transcript
            // survives).
            if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
              // The older line holds no chat to clear — the chats behind it
              // are cleared one by one from the picker, never as a pile.
              noteControl('strip:composer', { state: 'applied', reason: 'the older chats stay — ↵ opens them; clear one at a time from there' })
              return
            }
            const parkedRow = snapshotRef.current?.groups.flatMap(g => g.rows).find(r => r.sessionId === sessionId)
            if (parkedRow?.state === 'parked') {
              await markParkedCleared(sessionId)
              const supervisorSync = await import('../../daemon/concourseSupervisor.js')
              const parkedRecord = Object.values(supervisorSync.readSessionWorkers()).find(
                r => r.sessionId === sessionId && r.endedAt === undefined,
              )
              if (parkedRecord === undefined) {
                noteControl('strip:composer', { state: 'applied', reason: 'cleared from the board — the chat survives; the boot face or /resume bring it back' })
                refresh()
                return
              }
            }
            const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
            const daemonUp = await ensureOwnedDaemon()
            const supervisor = await import('../../daemon/concourseSupervisor.js')
            const rec = Object.values(supervisor.readSessionWorkers()).find(
              r => r.sessionId === sessionId && r.endedAt === undefined,
            )
            if (!rec) {
              noteControl('strip:composer', { state: 'applied', reason: 'already off the board' })
              refresh()
              return
            }
            let reply: { ok?: boolean; settled?: boolean; error?: string; code?: string }
            if (daemonUp) {
              const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
              reply = (await daemonControlRpc(
                // The session spelling (the wire's current name; the daemon
                // floor speaks it — the birth door above already rides
                // sessionAdmit): the legacy concourseRelease/workerId pair
                // retires with proto 4.
                { op: 'sessionRelease', runnerId: rec.runnerId } as never,
                { timeoutMs: 15_000 },
              )) as typeof reply
            } else {
              // No daemon to ask: a runner that died with it settles in the
              // record directly (the daemon's own release does exactly this
              // once nothing is left to kill); a live runner under an
              // unreachable daemon is never ended invisibly.
              const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
              const runnerAlive = rec.pid !== undefined && isProcessAlive(rec.pid)
              reply = runnerAlive
                ? { ok: false, error: `the daemon that hosts sessions is not reachable and the runner is alive — ${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` }
                : { ok: true, settled: supervisor.settleConcourseWorker(rec.runnerId) }
            }
            // A released chat is a cleared chat: the same mark the parked
            // chord-clear leaves, so "removed from the board" holds — the
            // row never bounces back beneath as parked.
            if (reply.ok === true && reply.settled !== false) {
              await markParkedCleared(sessionId).catch(() => {})
            }
            // The reaped-session ghost (operator item 4): releasing the
            // session the focused slot points at (it IS, or last was, the
            // focused chat) would leave the slot on a DEAD session — the
            // surface strip's step to the focused chat (and esc's root
            // return) opened the reaped chat. Re-point the slot to the
            // honest next: the first surviving board session in the
            // board's own painted order. Releasing the LAST row closes the
            // last chat (Law 9, rule 5; the operator's ruling on the ONLY
            // session): the slot rests on no session — the
            // connector detaches and says the blur — the chat stop leaves
            // the strip, and THE BOARD STAYS THE FRAME ("back to the two
            // screens": the menu and the concourse); nothing is minted at
            // the screen's cwd and nothing bounces to the menu.
            if (reply.ok === true && reply.settled !== false) {
              try {
                const slot = await import('../../services/engine-connector/focusedConnector.js')
                if (slot.getFocusedSessionConnector().sessionId() === sessionId) {
                  const hops = await import('../../services/switchboard/hopIntoSession.js')
                  // A parked row has no runner to hop into — it is never
                  // a survivor; with no survivor the slot simply rests.
                  const survivors = (snapshotRef.current?.groups.flatMap(g => g.rows) ?? []).filter(
                    r =>
                      r.sessionId !== sessionId &&
                      !r.sessionId.startsWith('dispatch:') &&
                      !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) &&
                      r.state !== 'queued' &&
                      r.state !== 'stopped' &&
                      r.state !== 'parked',
                  )
                  let repointed = false
                  for (const next of survivors) {
                    const hop = await hops.hopIntoBoardSession(next.sessionId)
                    if (hop.ok) {
                      repointed = true
                      break
                    }
                  }
                  if (!repointed) slot.releaseFocusedSessionConnector()
                }
              } catch (e) {
                // Fail-soft but never silent: the release itself settled.
                logForDebugging(`[concourse] focus re-point after reap failed: ${e}`)
              }
            }
            // The refusal paints the daemon's OWN sentence, never a bare
            // "release refused" that hides why.
            noteControl(
              'strip:composer',
              reply.ok === true && reply.settled !== false
                ? { state: 'applied', reason: 'removed from the board — the transcript survives' }
                : {
                    state: 'refused',
                    reason:
                      reply.ok === true
                        ? 'release refused — the worker process is still alive with no kill channel'
                        : reply.error ?? `release refused${reply.code !== undefined ? ` (${reply.code})` : ''}`,
                  },
            )
          } catch {
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: `${keyHintLabel('⌃x ⌃x')} retries` })
          }
          refresh()
        })()
      },
      // THE BOARD'S RENAME (session-aware naming, L16): the typed title
      // rides the daemon's set-title door as the OPERATOR's word — it
      // outranks and outlives the one-time mint (the record's one writer
      // holds the law); the receipt paints beside the composer and the
      // delta stamp repaints every board with the new name.
      renameSession: (sessionId, title) => {
        noteControl('strip:composer', 'pending')
        void (async () => {
          try {
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const reply = (await daemonControlRpc(
              { op: 'concourseControl', action: 'set-title', sessionId, by: 'operator', title, titleSource: 'operator' } as never,
              { timeoutMs: 10_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string }
            noteControl(
              'strip:composer',
              reply.ok === true && reply.outcome === 'applied'
                ? { state: 'applied', reason: `renamed to "${title.trim().slice(0, 40)}"` }
                : { state: 'refused', reason: reply.detail ?? 'the title was not set' },
            )
          } catch {
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: 'r retries' })
          }
          refresh()
        })()
      },
      openObligation: obligationId => {
        void import('../../services/crew/obligations.js').then(async o => {
          const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
          // a failed open is a VISIBLE receipt beside the enter
          // control, never a silent no-op (stale obligation, dead session,
          // or a refused route all land the same typed note). R7 C-HIGH-3:
          // a dispatch-refused question carries the pseudo session id
          // `dispatch:<cmid>` — there is no session surface to open.
          // AT-11: the note may paint beside a peek showing a DIFFERENT
          // session — it NAMES its subject so a receipt can never read as
          // the peeked session's own enter being refused.
          const subject = row ? `'${(row.question ?? row.sessionId).slice(0, 40)}'` : 'a settled question'
          if (!row) {
            noteControl('peek:enter-full-session', {
              state: 'refused',
              reason: 'that question already settled — nothing to open',
            })
            return
          }
          if (row.sessionId.startsWith('dispatch:')) {
            // 'open session' on a queued
            // question opens its WAITING ROOM — the button now actually
            // opens something instead of refusing.
            const boardRow = snapshotRef.current?.groups
              .flatMap(g => g.rows)
              .find(r => r.sessionId === row.sessionId)
            setWaitingRoom({
              dispatchId: row.sessionId.slice('dispatch:'.length),
              title: boardRow?.title ?? (row.question ?? 'queued session').slice(0, 48),
              project: boardRow?.projectLabel ?? '',
            })
            return
          }
          void subject
          // W2: open = the same guarded one-terminal full swap as ↵ on the
          // row — attachAndEnter paints its own typed receipts. The answer
          // journey NEEDS the full chat (the consent card lives only
          // there), so it flips even while the split frame stands.
          // 'settled': this continuation left the deciding dispatch at the
          // obligation read above — the entry keeps the landed late-flip
          // shape (no input consumption outside a deciding dispatch).
          attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })
          // THE CROSS-PROJECT FINISHED PING settles on its door (law 5, once
          // per need, never a nag): opening the chat IS the review — the
          // need is met the moment the operator takes the door; the ask
          // kinds stay open until answered in the chat.
          if (isCrossProjectFinishedRef(row.ref)) {
            void o
              .resolveObligation(obligationId, { kind: 'resolved', by: 'operator', scope: 'switchboard' })
              .catch(e => logForDebugging(`[concourse] cross-project ping settle failed: ${e}`))
          }
        })
      },
      // A4: 'd' re-owners the question to the operator — the durable
      // row's owner + revision move at the obligations owner; the rail
      // repaints from the store change.
      // AT-04: the withdraw loop closes — 'w' on the rail settles the
      // question through the SAME settlement owner every other exit uses;
      // the receipt names its subject (the AT-11 discipline).
      withdrawObligation: obligationId => {
        void (async () => {
          try {
            const o = await import('../../services/crew/obligations.js')
            const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
            const subject = row ? `'${(row.question ?? '').slice(0, 40)}'` : 'the question'
            const res = await resolveObligation(obligationId, { kind: 'withdrawn', by: 'operator', scope: 'switchboard' })
            noteControl(
              'strip:composer',
              res.settled
                ? { state: 'applied', reason: `withdrew ${subject}` }
                : { state: 'refused', reason: `${subject} already settled (${res.status})` },
            )
          } catch (e) {
            logForDebugging(`[concourse] withdraw failed: ${e}`)
            noteControl('strip:composer', { state: 'failed', reason: 'the withdraw failed', next: 'w retries' })
          }
          refresh()
        })()
      },
      claimObligation: obligationId => {
        void (async () => {
          try {
            const o = await import('../../services/crew/obligations.js')
            const { getOperatorName } = await import('../../utils/cockpit/presenceLive.js')
            await o.redirectObligation(obligationId, getOperatorName() || 'operator', { by: 'operator', scope: 'switchboard' })
          } catch (e) {
            logForDebugging(`[concourse] claim failed: ${e}`)
          }
          refresh()
        })()
      },
      // Pause/resume/redirect ride executeKernelDecision —
      // the SAME owner path the kernel and the assisted lane use (the
      // parity); the receipt rows on the feed under the OPERATOR actor (the
      // §F-2 stamp discipline: attribution names who acted).
      // BOARD CONTROLS item 1: pause/resume/interrupt/set-model settle
      // their receipts ON THE ROW — the board:row-control slot under the
      // selected row (the retired peek pane's note keys painted nowhere).
      pauseAfterTurn: sessionId => {
        if (peekOpInFlight.current.has('row:pause')) return // duplicate press mid-flight — ONE op
        peekOpInFlight.current.add('row:pause')
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'pausing…' })
        void (async () => {
          try {
            const { randomUUID } = await import('../../utils/crypto.js')
            const kernel = await import('../../services/concourse/coordinatorKernel.js')
            // Advisor item 8: ONE durable identity per human intent — a
            // 'failed' (transport-loss) receipt KEEPS it so the retry
            // replays into the daemon's applied-ops ledger.
            const clientOpId = mintControlOpId(`pause:${sessionId}`, `concourse-op-${randomUUID()}`)
            const receipt = await kernel.executeKernelDecision({
              verb: 'session.pause',
              sessionId,
              by: 'operator',
              reason: 'operator pause after turn',
              clientOpId,
            })
            if (receipt.outcome !== 'failed') {
              controlOpIdRef.current.delete(`pause:${sessionId}`)
              controlOpIdRef.current.delete(`resume:${sessionId}`)
            }
            const feed = await import('../../services/concourse/coordinatorReceipts.js')
            feed.ingestCoordinatorReceipts([{ ...receipt, actorAgentId: 'operator', opId: clientOpId }])
            // The ruled row wording: the row wears "paused by you".
            noteControl(
              `board:row-control:${sessionId}`,
              receipt.outcome === 'applied'
                ? { state: 'applied', reason: `paused by you · ${rowReceiptClock()}` }
                : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
            )
          } catch (e) {
            logForDebugging(`[concourse] pause failed: ${e}`)
            noteControl(`board:row-control:${sessionId}`, 'refused')
          }
          peekOpInFlight.current.delete('row:pause')
          refresh()
        })()
      },
      resumeSession: sessionId => {
        if (peekOpInFlight.current.has('row:resume')) return // duplicate press mid-flight — ONE op
        peekOpInFlight.current.add('row:resume')
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'resuming…' })
        void (async () => {
          try {
            const { randomUUID } = await import('../../utils/crypto.js')
            const kernel = await import('../../services/concourse/coordinatorKernel.js')
            const clientOpId = mintControlOpId(`resume:${sessionId}`, `concourse-op-${randomUUID()}`)
            const receipt = await kernel.executeKernelDecision({ verb: 'session.resume', sessionId, by: 'operator', clientOpId })
            if (receipt.outcome !== 'failed') {
              controlOpIdRef.current.delete(`pause:${sessionId}`)
              controlOpIdRef.current.delete(`resume:${sessionId}`)
            }
            const feed = await import('../../services/concourse/coordinatorReceipts.js')
            feed.ingestCoordinatorReceipts([{ ...receipt, actorAgentId: 'operator', opId: clientOpId }])
            noteControl(
              `board:row-control:${sessionId}`,
              receipt.outcome === 'applied'
                ? { state: 'applied', reason: rowReceipt('resumed') }
                : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
            )
          } catch (e) {
            logForDebugging(`[concourse] resume failed: ${e}`)
            noteControl(`board:row-control:${sessionId}`, 'refused')
          }
          peekOpInFlight.current.delete('row:resume')
          refresh()
        })()
      },
      // BOARD CONTROLS item 1 (`i`): abort the running turn on the child's
      // own control channel — concourseControl `interrupt`. The turn ends,
      // the session stays; never a kill, never a park. Carries a durable
      // clientOpId (interrupt mutates state — the applied-ops ledger makes
      // a retry after response loss exactly-once).
      interruptSession: sessionId => {
        if (peekOpInFlight.current.has('row:interrupt')) return // duplicate press mid-flight — ONE op
        peekOpInFlight.current.add('row:interrupt')
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'interrupting…' })
        void (async () => {
          try {
            const { randomUUID } = await import('../../utils/crypto.js')
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const clientOpId = mintControlOpId(`interrupt:${sessionId}`, `concourse-op-${randomUUID()}`)
            const reply = (await daemonControlRpc(
              { op: 'concourseControl', action: 'interrupt', sessionId, by: 'operator', clientOpId } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string; error?: string; code?: string }
            if (reply.ok !== true) {
              // Transport loss keeps the identity (the ledger replays the
              // first receipt); a wire refusal releases it.
              if (reply.code !== 'ETIMEOUT' && reply.code !== 'ENOCONN') controlOpIdRef.current.delete(`interrupt:${sessionId}`)
              noteControl(`board:row-control:${sessionId}`, {
                state: reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN' ? 'failed' : 'refused',
                reason: reply.error ?? 'the interrupt did not reach the daemon',
                next: 'i retries',
              })
            } else {
              controlOpIdRef.current.delete(`interrupt:${sessionId}`)
              noteControl(
                `board:row-control:${sessionId}`,
                reply.outcome === 'applied'
                  ? { state: 'applied', reason: rowReceipt('interrupted · idle') }
                  : reply.outcome === 'noop'
                    ? { state: 'applied', reason: reply.detail ?? 'no turn to interrupt' }
                    : { state: 'refused', reason: reply.detail ?? 'the session refused the interrupt' },
              )
            }
          } catch (e) {
            logForDebugging(`[concourse] interrupt failed: ${e}`)
            noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'i retries' })
          }
          peekOpInFlight.current.delete('row:interrupt')
          refresh()
        })()
      },
      // BOARD CONTROLS item 1 (`m`): the session's model, in place —
      // concourseControl `set-model` (idle applies now; busy parks it and
      // the idle edge applies; the chat's grey "model switched" note is the
      // connector's own settle paint). State-idempotent daemon-side — no
      // durable op identity; a re-press is an honest no-op.
      setSessionModel: (sessionId, modelId, displayName) => {
        if (peekOpInFlight.current.has('row:model')) return // duplicate press mid-flight — ONE op
        peekOpInFlight.current.add('row:model')
        const spoken = displayName ?? modelId
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: `switching to ${spoken}…` })
        void (async () => {
          try {
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const reply = (await daemonControlRpc(
              { op: 'concourseControl', action: 'set-model', sessionId, by: 'operator', model: modelId } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string; error?: string; code?: string }
            noteControl(
              `board:row-control:${sessionId}`,
              reply.ok === true && reply.outcome === 'applied'
                ? { state: 'applied', reason: rowReceipt(`model → ${spoken}`) }
                : reply.ok === true && reply.outcome === 'queued'
                  ? { state: 'held', reason: rowReceipt(reply.detail ?? `${spoken} applies when this turn ends`) }
                  : reply.ok === true && reply.outcome === 'noop'
                    ? { state: 'applied', reason: reply.detail ?? `already on ${spoken}` }
                    : {
                        state: reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN' ? 'failed' : 'refused',
                        reason: reply.detail ?? reply.error ?? 'the model was not switched',
                        next: 'm retries',
                      },
            )
          } catch (e) {
            logForDebugging(`[concourse] set-model failed: ${e}`)
            noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'm retries' })
          }
          peekOpInFlight.current.delete('row:model')
          refresh()
        })()
      },
      redirectSession: (sessionId, instruction) => {
        noteControl('strip:composer', 'pending')
        void (async () => {
          try {
            const { randomUUID } = await import('../../utils/crypto.js')
            const kernel = await import('../../services/concourse/coordinatorKernel.js')
            // R7 C-HIGH-2 (true replay): the id is the INSTRUCTION's identity
            // for this target — a paused target HOLDS the row, and re-sending
            // the same text after resume must REPLAY the same id to deliver
            // (the valve's own contract). New text mints fresh.
            const minted = redirectIdRef.current.get(sessionId)
            const clientMessageId =
              minted !== undefined && minted.instruction === instruction ? minted.id : `concourse-redirect-${randomUUID()}`
            redirectIdRef.current.set(sessionId, { instruction, id: clientMessageId })
            const receipt = await kernel.executeKernelDecision({
              verb: 'session.redirect',
              sessionId,
              clientMessageId,
              instruction,
              by: 'operator',
            })
            if (receipt.outcome === 'applied') redirectIdRef.current.delete(sessionId)
            // Only the typed valve hold ('session-paused …') and transport
            // loss ('failed' — the daemon may have applied it; the replay
            // door absorbs the retry) keep the identity; terminal refusals
            // release it so a corrected retry is a NEW message, never a
            // dead replay.
            else if (receipt.outcome !== 'failed' && !(receipt.detail ?? '').startsWith('session-paused'))
              redirectIdRef.current.delete(sessionId)
            const feed = await import('../../services/concourse/coordinatorReceipts.js')
            feed.ingestCoordinatorReceipts([{ ...receipt, actorAgentId: 'operator' }])
            // AT-03/05: the valve hold is HELD truth (its replay is the
            // designed door); noop is applied-no-change; refusals carry the
            // kernel's own detail.
            const held = (receipt.detail ?? '').startsWith('session-paused') || receipt.outcome === 'failed'
            noteResident(receipt.outcome === 'applied' ? 'wink' : held ? 'held' : 'refused', receipt.detail)
            noteControl(
              'strip:composer',
              held
                ? { state: 'held', reason: receipt.detail, next: '↵ again replays after resume' }
                : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
            )
          } catch (e) {
            logForDebugging(`[concourse] redirect failed: ${e}`)
            // Transport/defect keeps the identity — the resident says HELD
            // (replay is the designed door), never refused.
            noteResident('held', 'the daemon was unreachable')
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
          }
          refresh()
        })()
      },
      // BOARD CONTROLS item 1 (`e`) — the session's
      // effort in place, through concourseControl `set-effort` (an older
      // daemon answers the honest unknown-action refusal and the receipt
      // paints it). The handler
      // mirrors set-model's grammar; the receipt mirrors it here too.
      setSessionEffort: (sessionId, effort) => {
        if (peekOpInFlight.current.has('row:effort')) return // duplicate press mid-flight — ONE op
        peekOpInFlight.current.add('row:effort')
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: `effort → ${effort}…` })
        void (async () => {
          try {
            const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
            const reply = (await daemonControlRpc(
              { op: 'concourseControl', action: 'set-effort', sessionId, by: 'operator', effort } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; outcome?: string; detail?: string; error?: string; code?: string }
            noteControl(
              `board:row-control:${sessionId}`,
              reply.ok === true && reply.outcome === 'applied'
                ? { state: 'applied', reason: rowReceipt(`effort → ${effort}`) }
                : reply.ok === true && reply.outcome === 'queued'
                  ? { state: 'held', reason: rowReceipt(reply.detail ?? `${effort} applies when this turn ends`) }
                  : reply.ok === true && reply.outcome === 'noop'
                    ? { state: 'applied', reason: reply.detail ?? `already at ${effort}` }
                    : {
                        state: reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN' ? 'failed' : 'refused',
                        reason: reply.detail ?? reply.error ?? 'the effort was not set',
                        next: 'e retries',
                      },
            )
          } catch (e) {
            logForDebugging(`[concourse] set-effort failed: ${e}`)
            noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'e retries' })
          }
          peekOpInFlight.current.delete('row:effort')
          refresh()
        })()
      },
      startSessionDraft: text => {
        void writeConcourseDraft(text)
      },
      setDraftSeed: patch => {
        // Seed writes CHAIN so a submit can await the last one (the
        // read-after-write law — never dispatch yesterday's seeds).
        seedWriteChain.current = seedWriteChain.current.then(() => writeConcourseSeedOverride(patch))
      },
      submitSessionDraft: () => {
        /* wired below — submit needs the dispatch seam (submitDraft). */
      },
      enterBootSettings: () => {
        enterBootSettings()
      },
      exitToRepl: () => {
        // Esc leaves the board for the focused chat; with NO chat the home
        // verb refuses (never a flash of the empty REPL — the bridge law)
        // and the boot face takes the frame directly — the destination the
        // esc legend already names (browseKeysFor: 'boot face' while no
        // chat exists). Without the fall-through esc was a dead key under
        // a live label.
        if (!enterRootRepl().ok) enterBootSettings()
      },
      // The OWNER executes the safe-boundary switch
      // (validated against the composed registry; typed refusal receipts;
      // config untouched on refusal); the snapshot rebuilds so the chip
      // repaints the new truth; the receipt returns to the picker's note.
      switchCoordinatorModel: async modelId => {
        const models = await import('../../services/concourse/coordinatorModels.js')
        const receipt = await models.switchCoordinatorAssistModel(modelId)
        refresh()
        return receipt
      },
      switchCoordinatorMode: async mode => {
        const models = await import('../../services/concourse/coordinatorModels.js')
        const receipt = await models.switchCoordinatorMode(mode)
        refresh()
        return receipt
      },
      // The coordinator effort dial (the e doorway): the OWNER normalizes
      // and writes; the receipt returns for the picker's note line.
      switchCoordinatorEffort: async effortWord => {
        const models = await import('../../services/concourse/coordinatorModels.js')
        const receipt = await models.switchCoordinatorEffort(effortWord)
        refresh()
        return receipt
      },
      // The G wave: the conversation door — durable append + assisted turn
      // + reply-with-receipts at the lane owner; the board refreshes so any
      // executed vocabulary paints in the same beat.
      sendCoordinatorMessage: async (text, clientMessageId, onAccepted, opts) => {
        const lane = await import('../../services/concourse/coordinatorLane.js')
        // AT-07: the surface-held identity replays the same durable entry
        // on retry (the conversation store dedups by id). onAccepted rides
        // through to the lane's durable-append acceptance point. The
        // manager flag (ledger T7+T8) binds this one turn's addendum+tools.
        await lane.runOperatorMessageTurn(text, {}, {
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
          ...(onAccepted !== undefined ? { onAccepted } : {}),
          ...(opts?.manager === true ? { manager: true } : {}),
        })
        refresh()
      },
    }),
    [setPeek, noteResident, refresh, noteControl, attachAndEnter],
  )
  // Q2: the terminal notification ping — one coalesced ping when a
  // needs-you obligation lands; nothing else ever pings. Mounted with the
  // route; tolerant of the module landing separately.
  useEffect(() => {
    let handle: { dispose(): void } | null = null
    let alive = true
    void import('../../services/switchboard/askPing.js')
      .then(m => {
        if (!alive) return
        handle = m.startAskPing()
      })
      .catch(() => {
        /* fail-soft: a broken notifier must never break the board */
      })
    return () => {
      alive = false
      handle?.dispose()
    }
  }, [])
  // The submit: the concourseDispatch op (idempotent, admit+deliver in
  // one authed call); positive receipt clears the durable draft, a refusal
  // keeps it and drives the resident's typed refused state.
  // ONE dispatch per submit gesture. Enter autorepeat would otherwise mint a
  // fresh clientMessageId per repeat during the RPC round-trip (up to 15 s) —
  // every repeat admitted a session. The latch holds until the op settles;
  // the store-clear on success then empties the draft for good.
  const submitInFlight = useRef(false)
  // Every seed write joins ONE chain so submit can await the tail — the
  // read-after-write law over the lock-free seed store.
  const seedWriteChain = useRef<Promise<unknown>>(Promise.resolve())
  // THE DOOR-IN-SWING GUARD at the one non-list birth door (the same class
  // the list owner guards): newSession is reachable from the board's n-card
  // answer, the split pane's direct ↵ and any future caller — a doubled
  // gesture must swing the birth once, and the settle (either way) releases
  // so 'n retries' stays true.
  const birthInFlightRef = useRef(false)
  // R7 C-HIGH-2 (true replay): the clientMessageId is the DRAFT's identity,
  // not the gesture's. While a submit is HELD (seat ceiling / workspace
  // collision) a retry of the unchanged draft REPLAYS the same id, so the
  // reservation re-attempts admission — the held-replay door as designed —
  // instead of stranding one QUEUED ghost per press. A positive receipt or
  // a hard failure mints fresh (a hard-failed row is terminal; retrying it
  // by replay would refuse forever even after the operator fixes the seeds).
  // Advisor item 8: the identity covers the COMPLETE target + seed envelope
  // (workspace, isolation, model, title, agent, seats), not the draft text
  // alone — a seed edit mints fresh, matching the daemon's envelope law.
  const submitIdRef = useRef<{ key: string; id: string } | null>(null)
  // Advisor item 8: the held identity survives a UI restart — rehydrate
  // once from the durable draft store so ↵ after a relaunch replays the
  // SAME clientMessageId (the stranded-QUEUED-ghost exit).
  useEffect(() => {
    void import('../../services/concourse/concourseSnapshot.js').then(async s => {
      if (submitIdRef.current !== null) return
      const held = await s.readConcourseHeldDispatch()
      if (held !== null && submitIdRef.current === null)
        submitIdRef.current = { key: held.envelopeKey, id: held.clientMessageId }
    })
  }, [])
  // THE DAEMON-START OFFER state: armed by an ENOCONN
  // dispatch; y spawns the owned daemon + replays the held draft, n keeps
  // the draft with the honest manual copy. Ref, not state — the screen
  // reads it per keypress (no re-render needed to arm/disarm).
  const daemonOfferRef = useRef<{ draft: string } | null>(null)
  const submitDraft = useCallback(
    (draft: string): void => {
      if (submitInFlight.current) return
      submitInFlight.current = true
      void (async () => {
        try {
          const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
          const { randomUUID } = await import('../../utils/crypto.js')
          // The structured seeds ride the REAL op inputs through the ONE
          // painted-truth mapping (dispatchSeedInputs — shared with the
          // preflight preview). Isolation always rides: the op's absent
          // default ('exclusive') is not a state the strip paints.
          // Submit reads AFTER every pending seed write settles (the
          // F-review catch: a lock-free store read racing the last
          // keystroke's write dispatched yesterday's seeds while the chips
          // showed the new value — '@bob'+Enter sent '@bo').
          await seedWriteChain.current
          const seeds = await readConcourseSeedOverrides()
          // The PAINTED resolved model rides the op even when no explicit
          // override exists — the daemon must never resolve a divergent
          // default of its own (display ≡ dispatch across processes).
          // SB-: snapshotRef is kept current per render — the `snapshot`
          // state var here is the submit closure's stale capture, so the
          // painted default model and the dispatched one could diverge.
          const si = dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId)
          const envelopeKey = `${draft}\u0000${JSON.stringify(si)}`
          const minted = submitIdRef.current
          const clientMessageId =
            minted !== null && minted.key === envelopeKey ? minted.id : `concourse-ui-${randomUUID()}`
          submitIdRef.current = { key: envelopeKey, id: clientMessageId }
          // The exact op inputs, built ONCE — the same bytes ride the live
          // submit, the held store (the pump replays them verbatim),
          // and any ↵ replay. An UNCHOSEN isolation is the
          // daemon's decision (main checkout first, fork when held) — only
          // an explicit pick rides the op; the receipt names a carved fork.
          const opInputs: Record<string, unknown> = {
            workspaceDir: si.workspaceDir,
            ...(si.modelKey !== undefined ? { model: si.modelKey } : {}),
            ...(si.effort !== undefined ? { effort: si.effort } : {}),
            title: si.title ?? draft.replace(/\s+/g, ' ').slice(0, 48),
            ...(si.agentName !== undefined ? { agentName: si.agentName } : {}),
            ...(si.seatsMax !== undefined ? { seatsMax: si.seatsMax } : {}),
            ...(seeds.isolation !== undefined ? { isolation: si.isolation } : {}),
          }
          const reply = await daemonControlRpc(
            {
              op: 'concourseDispatch',
              clientMessageId,
              by: 'operator',
              prompt: draft,
              ...opInputs,
            } as never,
            { timeoutMs: 15_000 },
          )
          const snapshotStore = await import('../../services/concourse/concourseSnapshot.js')
          if ((reply as { ok?: boolean }).ok) {
            submitIdRef.current = null
            await snapshotStore.writeConcourseHeldDispatch(null)
            await writeConcourseDraft('')
            noteResident('wink')
            // a silently carved fork NAMES itself on the
            // applied receipt — slug first (the strip clamps the tail).
            // Folder-switch hardening law 5: EVERY applied launch receipt
            // names the folder it landed in — a submit racing a ground
            // switch lands in exactly one folder, and this says which.
            const okr = reply as { branchName?: string; mainHolderTitle?: string }
            const landedIn = basename(si.workspaceDir) || si.workspaceDir
            noteControl(
              'strip:composer',
              okr.branchName !== undefined
                ? {
                    state: 'applied',
                    reason: `on worktree ${okr.branchName} in ${landedIn}${okr.mainHolderTitle !== undefined ? ` — main checkout is with ${okr.mainHolderTitle}` : ''}`,
                  }
                : { state: 'applied', reason: `started in ${landedIn}` },
            )
          } else {
            // AT-03: HELD is admission-queue truth, never a refusal — the
            // identity is KEPT (its replay is the designed re-admission
            // door) and both paints say so with the kernel's own reason.
            const r = reply as {
              state?: string
              heldReason?: string
              heldByTitle?: string
              moves?: Array<{ verb: string; label: string }>
              detail?: string
              error?: string
              code?: string
            }
            if (r.state === 'queued') {
              await snapshotStore.writeConcourseHeldDispatch({
                clientMessageId,
                envelopeKey,
                prompt: draft,
                op: opInputs,
              })
              const waitCopy = concourseWaitCopy(r.heldReason, r.heldByTitle)
              noteResident('held', waitCopy)
              noteControl('strip:composer', {
                state: 'held',
                reason: waitCopy,
                next: r.moves?.[0]?.label ?? '↵ again replays the same request',
              })
            } else if (r.code === 'ETIMEOUT' || r.code === 'ENOCONN') {
              // Durable-identity law (advisor item 8): daemonControlRpc never
              // throws — transport loss arrives as a SYNTHETIC reply, which
              // would otherwise fall into the refusal fold and CLEAR the id. The
              // daemon may have applied the op; the identity is KEPT (and
              // persisted — a restart rehydrates it) so ↵ replays the SAME
              // request into the dispatch ledger's replay door and collects
              // the first receipt instead of admitting a duplicate session.
              await snapshotStore.writeConcourseHeldDispatch({
                clientMessageId,
                envelopeKey,
                prompt: draft,
                op: opInputs,
              })
              if (r.code === 'ENOCONN') {
                // THE DAEMON-START OFFER: ENOCONN is
                // "no daemon at the socket" — a dead-end failure taught the
                // operator nothing ("wtf does this bar do"). The note asks;
                // the screen routes y/n while armed (answerDaemonOffer).
                // ETIMEOUT (a daemon exists, but slow) keeps plain replay.
                daemonOfferRef.current = { draft }
                noteResident('held', 'the daemon that hosts background sessions is not running')
                noteControl('strip:composer', {
                  state: 'failed',
                  reason: 'the daemon that hosts background sessions is not running',
                  next: 'y starts it · n keeps your draft',
                })
              } else {
                noteResident('held', 'the daemon did not answer')
                noteControl('strip:composer', {
                  state: 'failed',
                  reason: 'the daemon did not answer',
                  next: '↵ retries the same request',
                })
              }
            } else {
              submitIdRef.current = null
              // A terminal refusal releases the identity EVERYWHERE — the
              // persisted half too, or a restart rehydrates a dead replay.
              await snapshotStore.writeConcourseHeldDispatch(null)
              const reason = r.detail ?? r.error ?? 'the dispatch was refused'
              noteResident('refused', reason)
              noteControl('strip:composer', {
                state: 'refused',
                reason,
                next: 'edit the task or seeds · ↵ retries',
              })
            }
          }
        } catch (e) {
          // AT-01: transport/defect is FAILED (retryable), never a refusal.
          logForDebugging(`[concourse] dispatch failed: ${e}`)
          noteResident('held', 'the daemon was unreachable')
          noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
        } finally {
          // Hold the latch briefly past settle: Enter autorepeat (~30/s) can
          // slip between fast sequential round-trips — a settle cooldown
          // turns a held key into ONE dispatch without suppressing a real
          // later re-submit (imperceptible at human cadence).
          setTimeout(() => {
            submitInFlight.current = false
          }, 500)
          refresh()
        }
      })()
    },
    [noteResident, refresh, noteControl],
  )
  // the shell never blanks — before the first snapshot lands the
  // assembling shell holds the surface (and a failing FIRST load offers the
  // clear retry); after that, failures keep the last coherent snapshot and
  // the screen paints the degraded help rail.
  const answerDaemonOffer = useCallback(
    (yes: boolean): void => {
      const offer = daemonOfferRef.current
      if (offer === null) return
      daemonOfferRef.current = null
      if (!yes) {
        noteControl('strip:composer', {
          state: 'failed',
          reason: 'the daemon that hosts background sessions is not running',
          next: 'start it with `mercury daemon` · your draft is kept',
        })
        return
      }
      noteControl('strip:composer', { state: 'pending', reason: 'starting the daemon…' })
      void (async () => {
        const { spawnOwnedDaemon } = await import('../../daemon/ownedDaemon.js')
        const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
        const pid = spawnOwnedDaemon(getCwd(), { label: 'concourse' })
        if (pid === undefined) {
          noteControl('strip:composer', {
            state: 'failed',
            reason: 'the daemon did not start (see .mercury/daemon/daemon.log)',
            next: 'run `mercury daemon` yourself · your draft is kept',
          })
          return
        }
        // Readiness: poll the control socket (bounded — a fresh daemon
        // writes its key + binds within a boot beat; 10s covers cold disk).
        for (let i = 0; i < 40; i++) {
          const probe = (await daemonControlRpc({ op: 'concourseList' } as never, { timeoutMs: 500 })) as { code?: string }
          if (probe.code !== 'ENOCONN') {
            // Up — REPLAY the held draft: same seeds + same text resolve
            // the same envelope, so the kept identity rides the replay door.
            submitDraft(offer.draft)
            return
          }
          await new Promise(res => setTimeout(res, 250))
        }
        noteControl('strip:composer', {
          state: 'failed',
          reason: 'the daemon started but never answered (see .mercury/daemon/daemon.log)',
          next: '↵ retries · your draft is kept',
        })
      })()
    },
    [noteControl, submitDraft],
  )
  // THE GROUND LAW's boot half, AMENDED (operator drive 6b): the ground
  // DEFAULTS to the folder the terminal was opened from — a chip persisted
  // by a previous boot never leaks across boots (booting from
  // ~/Desktop/backup must not stand on last week's repo). The rail's repo
  // selector re-grounds LIVE within this run; boot always starts honest.
  const bootGroundApplied = useRef(false)
  useEffect(() => {
    if (fixture !== null || bootGroundApplied.current) return
    bootGroundApplied.current = true
    void (async () => {
      try {
        const seeds = await readConcourseSeedOverrides()
        if (typeof seeds.projectDir === 'string' && seeds.projectDir.length > 0 && seeds.projectDir !== getCwd()) {
          await writeConcourseSeedOverride({ projectDir: null })
          refresh()
        }
      } catch {
        /* the chip is a projection */
      }
    })()
  }, [fixture, refresh])
  // (the admission pump): 'it starts when one frees' becomes TRUE —
  // on every snapshot refresh, a held launch whose block cleared replays
  // its SAME kept identity through the daemon's designed re-admission door
  // (idempotent: a lost race just holds again). Content comes from the
  // caller-side held store; the daemon ledger keeps digests only.
  const pumpBusyRef = useRef(false)
  useEffect(() => {
    if (fixture !== null) return
    if (pumpBusyRef.current) return
    const snap = liveSnapshot
    if (!snap) return
    pumpBusyRef.current = true
    void (async () => {
      try {
        const store = await import('../../services/concourse/concourseSnapshot.js')
        const dispatchMod = await import('../../daemon/concourseDispatch.js')
        const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
        // The hand-back sweep: a hand-back marker an earlier build left (a
        // one-terminal swap that never reached the daemon) replays here
        // until it lands, and a record still stamped as with-you by a
        // terminal that is gone is handed back the same way — a session
        // must NEVER stay stranded off the board. A window mints neither.
        try {
          const attachedMod = await import('../../services/switchboard/attachedSession.js')
          const marker = await store.readConcoursePendingHandback()
          let handedBack = 0
          if (
            marker !== null &&
            // Replay with the marker's ORIGINAL mint time — the daemon
            // refuses it if the session was re-entered since.
            (await attachedMod.completeHandback(marker.kind, marker.sessionId, {
              mintedAtMs: marker.mintedAtMs,
            }))
          ) {
            handedBack++
          }
          handedBack += await attachedMod.healStaleAttachRecords()
          if (handedBack > 0) {
            noteControl('strip:composer', {
              state: 'applied',
              reason: 'the session was handed back — it lives on the board again',
            })
            refresh()
          }
        } catch {
          /* the marker survives — next refresh retries */
        }
        // half: held DELIVERIES replay on their own too — a with-you
        // or paused hold delivers the moment its session is free again.
        const deliveries = await store.readConcourseHeldDeliveries()
        const deliveryIds = Object.keys(deliveries)
        if (deliveryIds.length > 0) {
          const { readSessionWorkers } = await import('../../daemon/concourseSupervisor.js')
          const workers = Object.values(readSessionWorkers())
          for (const sessionId of deliveryIds) {
            const heldDelivery = deliveries[sessionId]
            if (heldDelivery === undefined) continue
            const drec = dispatchMod.readConcourseDispatches()[heldDelivery.clientMessageId]
            if (drec === undefined || drec.heldReason === undefined || drec.state !== 'queued') {
              await store.writeConcourseHeldDelivery(sessionId, null)
              continue
            }
            const w = workers.find(x => x.sessionId === sessionId && x.endedAt === undefined)
            const free = w !== undefined && w.attachedAt === undefined && w.pausedAt === undefined && w.attachRequestedAt === undefined
            if (!free) continue
            const dreply = (await daemonControlRpc(
              {
                op: 'concourseDispatch',
                clientMessageId: heldDelivery.clientMessageId,
                prompt: heldDelivery.text,
                workspaceDir: '',
                targetSessionId: sessionId,
                by: 'operator',
              } as never,
              { timeoutMs: 15_000 },
            )) as { ok?: boolean; heldReason?: string }
            if (dreply.ok === true || dreply.heldReason === undefined) {
              // Delivered — or settled terminal (a terminal row never
              // re-delivers): the kept identity is spent either way.
              await store.writeConcourseHeldDelivery(sessionId, null)
              refresh()
            }
          }
        }
        // Finding 3d: stale needs-you rows EXPIRE — a question
        // whose subject is absent (settled dispatch, removed session) must
        // not demand answers forever. Bounded, fail-soft, never the host
        // session's own rows.
        try {
          const rowsNY = snap.needsYou ?? []
          if (rowsNY.length > 0) {
            const o = await import('../../services/crew/obligations.js')
            const sup = await import('../../daemon/concourseSupervisor.js')
            const state = await import('../../bootstrap/state.js')
            const hostId = String(state.getSessionId())
            const workerRecs = Object.values(sup.readSessionWorkers())
            const ledger = dispatchMod.readConcourseDispatches()
            for (const ny of rowsNY.slice(0, 12)) {
              const sid = ny.sessionId
              if (sid === hostId || sid.startsWith('folder:')) continue
              // SB-C5 (close audit): staleness needs POSITIVE evidence — the
              // old default-stale killed kernel:capacity asks in one beat
              // (their ledger rows sit 'failed'-retryable by construction)
              // and silently expired questions on ids the concourse never
              // owned (crew asks under a foreign session id).
              let stale = false
              if (sid.startsWith('dispatch:')) {
                const drow = ledger[sid.slice('dispatch:'.length)]
                stale =
                  drow !== undefined &&
                  (drow.sessionId !== undefined || drow.reason?.startsWith('withdrawn') === true)
              } else {
                stale =
                  workerRecs.some(r => r.sessionId === sid && r.endedAt !== undefined) &&
                  !workerRecs.some(r => r.sessionId === sid && r.endedAt === undefined)
              }
              if (stale) {
                await o
                  .resolveObligation(ny.obligationId, { kind: 'superseded', by: 'board-sweep', scope: 'switchboard' })
                  .catch(() => undefined)
              }
            }
          }
        } catch {
          /* the sweep is a projection — never blocks the pump */
        }
        const held = await store.readConcourseHeldDispatch()
        if (held === null || held.prompt === undefined) return
        const rec = dispatchMod.readConcourseDispatches()[held.clientMessageId]
        if (rec === undefined) return
        if (rec.sessionId !== undefined && rec.state !== 'queued' && rec.state !== 'failed') {
          // Admitted elsewhere (the daemon's git-ready replay lands here too)
          // — deliver any stacked messages AND retire the slot, or this
          // branch re-runs forever on a row that no longer waits.
          await drainQueuedStack(held.clientMessageId, rec.sessionId)
          await store.writeConcourseHeldDispatch(null)
          return
        }
        if (rec.state !== 'queued' || rec.heldReason === undefined || rec.sessionId !== undefined) return
        const reason = dispatchMod.normalizeHoldReason(rec.heldReason)
        const rows = snap.groups.flatMap(g => g.rows)
        let cleared = false
        if (reason === 'seat') {
          const { effectiveSeatCeiling } = await import('../../daemon/concourseSupervisor.js')
          cleared = snap.counts.live < effectiveSeatCeiling()
        } else if (reason === 'repo-held') {
          cleared = !rows.some(
            r =>
              r.workspaceDir === rec.workspaceId &&
              r.worktreeBranch === undefined &&
              !r.sessionId.startsWith('dispatch:') &&
              r.state !== 'queued' &&
              r.state !== 'stopped',
          )
        } else if (reason === 'no-repository' || reason === 'unborn-head') {
          const { workspaceKindOf } = await import('../../daemon/concourseWorktrees.js')
          cleared = rec.workspaceId !== undefined && workspaceKindOf(rec.workspaceId) === 'git'
        }
        if (!cleared) return
        const reply = (await daemonControlRpc(
          {
            op: 'concourseDispatch',
            clientMessageId: held.clientMessageId,
            by: 'operator',
            prompt: held.prompt,
            ...(held.op ?? {}),
          } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; sessionId?: string; branchName?: string }
        if (reply.ok === true) {
          await store.writeConcourseHeldDispatch(null)
          noteControl('strip:composer', {
            state: 'applied',
            reason:
              reply.branchName !== undefined
                ? `the queued session started on worktree ${reply.branchName}`
                : 'the queued session started — its block cleared',
          })
          if (reply.sessionId !== undefined) await drainQueuedStack(held.clientMessageId, reply.sessionId)
          refresh()
        }
      } catch (e) {
        // The pump's whole beat must stay fail-soft but visible.
        logForDebugging(`[concourse] admission pump beat failed (next refresh retries): ${e}`)
      } finally {
        pumpBusyRef.current = false
      }
    })()
  }, [liveSnapshot, fixture, drainQueuedStack, noteControl, refresh])
  // HOOK-ORDER LAW: every hook above this line — the assembling-shell early
  // return must trail ALL hooks (React #310: the crash-1786803220631 boot).
  if (!snapshot) return <ConcourseAssemblingShell failing={failing} onRetry={refresh} />
  if (waitingRoom !== null) {
    // the queued session's waiting room — same geometry family as
    // the watch surface; promotion to live is the ordinary enter journey.
    return (
      <SessionWaitingRoom
        dispatchId={waitingRoom.dispatchId}
        title={waitingRoom.title}
        project={waitingRoom.project}
        onBack={() => setWaitingRoom(null)}
        onAdmitted={sessionId => waitingRoomAdmitted(waitingRoom.dispatchId, sessionId)}
      />
    )
  }
  // B5 (D2): submit is an EXPLICIT callback carrying the screen's LOCAL
  // echo. The retired equality heuristic (keystroke text === stored draft ⇒
  // submit) could fire on a backspace-and-retype and dropped characters
  // through the async store round-trip.
  const screenCallbacks: ConcourseCallbacks = {
    ...callbacks,
    startSessionDraft: (text: string, caret?: number) => void writeConcourseDraft(text, undefined, caret),
    setDraftSeed: patch => {
      seedWriteChain.current = seedWriteChain.current.then(() => writeConcourseSeedOverride(patch))
      if ('projectDir' in patch) {
        // THE GROUND LAW: the selected repo IS
        // the harness ground — changing it re-grounds the whole product
        // (the focused chat included — the ONE apply owner re-grounds a
        // blank focused chat so New Session lands in the pick), a cd for
        // the harness; clearing it returns to the boot folder. Sessions
        // keep their OWN grounds regardless.
        void import('../../services/switchboard/harnessGround.js')
          .then(m =>
            m.applyHarnessGround(
              typeof patch.projectDir === 'string' && patch.projectDir.length > 0 ? patch.projectDir : null,
            ),
          )
          .catch(() => {
            /* ground apply is best-effort; the seed write is the record */
          })
      }
    },
    // THE NEW SESSION TAB (Law 9, rule 4 — "a small little tab there"): a
    // blank session born through THE ONE BIRTH DOOR in the CURRENT ground —
    // the rail's repo pick (the seed, read after every pending seed write
    // settles: the read-after-write law the submit follows) or the boot
    // folder — then the chat focuses under the yank law. No words, no draft
    // consumed, no dispatch op: the same birth the boot face's New Session
    // makes, from the board. A birth the daemon refuses paints its own
    // sentence on the tab; nothing is entered.
    newSession: (opts?: { contractText?: string }) => {
      if (birthInFlightRef.current) return
      birthInFlightRef.current = true
      const gen = surfaceGeneration()
      noteControl('board:new-session', { state: 'pending', reason: 'starting a session…' })
      void (async () => {
        try {
          await seedWriteChain.current
          const ground = await resolveHarnessGround()
          const { bornSession } = await import('../../services/switchboard/bornSession.js')
          const born = await bornSession({ workspaceDir: ground })
          if (!born.ok) {
            noteControl('board:new-session', { state: 'refused', reason: born.reason, next: 'n retries' })
            return
          }
          // The offer's Yes leg (coordinator-tooling T2): the composed words
          // become the born session's advisory contract DRAFT through the
          // daemon's one contract verb — before the enter, so the chat
          // opens with the agreement already on the record (the agent
          // acknowledges it through its own contract tool). A set the
          // daemon refuses never un-births the session: the note says the
          // honest miss and /contract retries.
          let contractNote = ''
          const contractText = opts?.contractText?.trim() ?? ''
          if (contractText.length > 0) {
            try {
              const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
              const reply = (await daemonControlRpc(
                { op: 'sessionControl', action: 'contract', sessionId: born.sessionId, by: 'operator', contract: { op: 'set', text: contractText } } as never,
                { timeoutMs: 10_000 },
              )) as { ok?: boolean; outcome?: string; detail?: string }
              if (reply.ok !== true || reply.outcome !== 'applied') {
                contractNote = ` — the contract was not set (${reply.detail ?? 'the daemon refused it'}); /contract retries`
              }
            } catch {
              contractNote = ' — the contract was not set (the daemon was unreachable); /contract retries'
            }
          }
          if (surfaceGeneration() === gen) {
            // Stay-in-split: the newborn takes the slot and the chat pane
            // paints it — the birth needs no route move while the split
            // frame stands.
            if (splitFrameStands()) {
              noteControl('board:new-session', { state: 'applied', reason: `${born.title} — in the chat pane${contractNote}` })
            } else {
              noteControl('board:new-session', { state: 'applied', reason: `entering ${born.title}${contractNote}` })
              enterRootRepl()
            }
          }
        } catch (e) {
          logForDebugging(`[concourse] new session failed: ${e}`)
          noteControl('board:new-session', { state: 'failed', reason: 'the session could not start', next: 'n retries' })
        } finally {
          birthInFlightRef.current = false
        }
      })()
    },
    submitSessionDraft: (text: string) => {
      if (text.trim().length > 0) submitDraft(text)
    },
    daemonOfferArmed: () => daemonOfferRef.current !== null,
    answerDaemonOffer,
    retrySnapshot: refresh,
  }
  return (
    <ConcourseScreen
      snapshot={snapshot}
      callbacks={screenCallbacks}
      degraded={failing}
      controlNotes={controlNotes}
      // THE PLAIN WORLD ⇒ the reduced stage: the plain live view of the
      // sessions (rows + mirror), no coordinator controls. The world is the
      // router's ONE fact — the concourse switched off, OR a `--chat` boot
      // (whose switch may well be on): the explicit doors (/concourse,
      // ctrl+x c, the face's row where it exists) open the live view there,
      // never the coordinator board.
      reducedStage={chatOnlyBoot()}
    />
  )
}

/** the pre-snapshot shell — the Concourse surface exists from the
 *  first frame (never a blank route), names its state, and carries the
 *  clear retry when the first load is failing. */
function ConcourseAssemblingShell({ failing, onRetry }: { failing: boolean; onRetry: () => void }): React.ReactNode {
  const t = useMercuryTokens()
  const { rows: termRows } = useTerminalSize()
  // Esc leaves for the focused chat, else the boot face directly (the home
  // verb refuses on an empty bridge); the label says which — read at render
  // (the shell is the transient first-load frame).
  const escLabel = chatPresent() ? 'esc focused chat' : 'esc boot face'
  useInput((input, key, event) => {
    if (key.escape) {
      event.stopImmediatePropagation()
      if (!enterRootRepl().ok) enterBootSettings()
      return
    }
    if (key.ctrl && input === 'r') {
      event.stopImmediatePropagation()
      onRetry()
      return
    }
  })
  return (
    <Box flexDirection="column" width="100%" height={termRows} paddingX={2} alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor={failing ? t.warning : t.info} paddingX={3} paddingY={1} alignItems="center">
        {/* The shared ramped lockup — the shell
            never splits the title grammar from the live header. */}
        <ConcourseLockup />
        {failing ? (
          <>
            <Text color={t.warning}>the live view is unavailable — nothing loaded yet</Text>
            <Text color={t.textMuted}>{`${keyHintLabel('⌃r')} retry · ${escLabel}`}</Text>
          </>
        ) : (
          <>
            <Text color={t.textSecondary}>assembling the concourse…</Text>
            <Text color={t.textMuted}>{escLabel}</Text>
          </>
        )}
      </Box>
    </Box>
  )
}

registerRouteSurface('concourse', { render: () => <LiveConcourse /> })
// AR-10 (operator-ruled): the attached worker renders BENEATH the live
// MercuryFrame band — telemetry stays visible exactly while driving.
