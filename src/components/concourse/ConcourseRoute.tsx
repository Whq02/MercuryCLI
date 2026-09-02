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


let lastCoherentSnapshot: ConcourseSnapshotV1 | null = null

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
  failing: boolean
  setPeek: (sessionId: string) => void
  noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => void
  refresh: () => void
} {
  const [snapshot, setSnapshot] = useState<ConcourseSnapshotV1 | null>(lastCoherentSnapshot)
  const [failing, setFailing] = useState(false)
  const peekRef = useRef<string | undefined>(undefined)
  const residentRef = useRef<'wink' | 'refused' | 'held' | undefined>(undefined)
  const residentReasonRef = useRef<string | undefined>(undefined)
  const alive = useRef(true)
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
    const unsubProject = subscribeCurrentProject(rebuild)
    const unsubSlot = subscribeFocusedSessionConnector(() => rebuild())
    let watcher: import('node:fs').FSWatcher | null = null
    let lastDelta = ''
    void Promise.all([import('../../daemon/concourseSupervisor.js'), import('node:fs')])
      .then(([sup, fs]) => {
        if (!alive.current) return
        const deltaPath = sup.concourseDeltaPath()
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
            }
            rebuild()
          })
          watcher.on('error', () => {
            try {
              watcher?.close()
            } catch {
            }
            watcher = null
          })
        } catch {
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

function readFixtureSnapshot(): ConcourseSnapshotV1 | null {
  try {
    const path = process.env['MERCURY_CONCOURSE_FIXTURE']
    if (!path) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConcourseSnapshotV1
    if (parsed.schema !== 1) return null
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
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const termColsRef = useRef(termCols)
  termColsRef.current = termCols
  const termRowsRef = useRef(termRows)
  termRowsRef.current = termRows
  const splitFrameStands = useCallback(
    (): boolean => splitViewOn() && splitAvailableAt(termColsRef.current, termRowsRef.current),
    [],
  )
  const [controlNotes, setControlNotes] = useState<Readonly<Record<string, ControlNoteState>>>({})
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
  const rowReceiptClock = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const rowReceipt = (what: string): string => `${what} — you · ${rowReceiptClock()}`
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
    const kind = controlNoteOf(state).state
    if (kind !== 'pending') {
      const timer = setTimeout(() => {
        if (noteIdentityRef.current[control] !== mySeq) return
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
  const redirectIdRef = useRef<Map<string, { instruction: string; id: string }>>(new Map())
  const controlOpIdRef = useRef<Map<string, { id: string; mintedAtMs: number }>>(new Map())
  const CONTROL_RETRY_WINDOW_MS = 15_000
  const mintControlOpId = useCallback((key: string, fresh: string): string => {
    const held = controlOpIdRef.current.get(key)
    const id = held !== undefined && Date.now() - held.mintedAtMs < CONTROL_RETRY_WINDOW_MS ? held.id : fresh
    controlOpIdRef.current.set(key, { id, mintedAtMs: held?.id === id ? held.mintedAtMs : Date.now() })
    return id
  }, [])
  const peekOpInFlight = useRef<Set<string>>(new Set())
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
  const enterOpRef = useRef<{ sessionId: string; gen: number } | null>(null)
  const [waitingRoom, setWaitingRoom] = useState<{
    dispatchId: string
    title: string
    project: string
  } | null>(null)
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
          await store.removeConcourseQueuedStackEntry(dispatchId, entry.clientMessageId)
        } else {
          break
        }
      }
    } catch (e) {
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
        noteControl(noteKey, { state: 'refused', reason: 'the older chats unfold on the board — ↵ on the line opens them' })
        return
      }
      const row = snapshotRef.current?.groups.flatMap(g => g.rows).find(r => r.sessionId === sessionId)
      const rowParked = row?.state === 'parked' ? { transcriptPath: row.transcriptPath, title: row.title } : undefined
      const parked = opts?.parkedFact ?? rowParked
      const op = { sessionId, gen: surfaceGeneration() }
      enterOpRef.current = op
      noteControl(noteKey, { state: 'pending', reason: parked !== undefined ? 'bringing it back…' : 'opening…' })
      armEntryWarmth(sessionId, row?.title ?? parked?.title, hasFocusedSession() ? getFocusedSessionConnector().sessionId() : undefined)
      const landing = withLanding(
        (async () => {
          const hops = await import('../../services/switchboard/hopIntoSession.js')
          return parked !== undefined
            ? await hops.focusResumedSession(sessionId, parked.transcriptPath, { title: parked.title })
            : await hops.hopIntoBoardSession(sessionId)
        })(),
      )
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
            if (flippedGen !== null && surfaceGeneration() === flippedGen) returnToConcourse()
            return
          }
          if (enterOpRef.current !== op) return
          if (!settled) {
            noteControl(noteKey, split ? { state: 'applied', reason: 'in the chat pane' } : 'applied')
            return
          }
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
        attachAndEnter(sessionId, 'board:open', { entry: 'settled' })
      })()
    },
    [drainQueuedStack, attachAndEnter],
  )
  const callbacks = useMemo<ConcourseCallbacks>(
    () => ({
      noteControl,
      enterSession: sessionId => {
        if (!sessionId.startsWith('dispatch:')) setPeek(sessionId)
        attachAndEnter(sessionId, 'board:open')
      },
      resumeOlderChat: (sessionId, transcriptPath, title) => {
        attachAndEnter(sessionId, 'board:open', { parkedFact: { transcriptPath, title } })
      },
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
        noteControl('strip:composer', 'pending')
        void (async () => {
          try {
            const o = await import('../../services/crew/obligations.js')
            const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
            if (!row || row.status !== 'open') {
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
      stopSession: sessionId => {
        void (async () => {
          try {
            const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
            const daemonUp = await ensureOwnedDaemon()
            if (!daemonUp) {
              const supervisor = await import('../../daemon/concourseSupervisor.js')
              const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
              const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
              const runnerAlive = rec?.pid !== undefined && isProcessAlive(rec.pid)
              if (rec !== undefined && !runnerAlive) {
                const out = supervisor.stopConcourseSession(sessionId, 'operator', undefined)
                noteControl('strip:composer', out.outcome === 'refused' ? { state: 'refused', reason: out.detail ?? out.reason } : { state: 'applied', reason: `stopped — ${keyHintLabel('⌃x ⌃x')} removes it from the board` })
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
            noteControl(
              'strip:composer',
              reply.ok === true && reply.outcome !== 'refused'
                ? { state: 'applied', reason: `stopped — ${keyHintLabel('⌃x ⌃x')} removes it from the board` }
                : { state: 'refused', reason: reply.detail ?? reply.error ?? `stop refused${reply.code !== undefined ? ` (${reply.code})` : ''}` },
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
            if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {
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
                { op: 'sessionRelease', runnerId: rec.runnerId } as never,
                { timeoutMs: 15_000 },
              )) as typeof reply
            } else {
              const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
              const runnerAlive = rec.pid !== undefined && isProcessAlive(rec.pid)
              reply = runnerAlive
                ? { ok: false, error: `the daemon that hosts sessions is not reachable and the runner is alive — ${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` }
                : { ok: true, settled: supervisor.settleConcourseWorker(rec.runnerId) }
            }
            if (reply.ok === true && reply.settled !== false) {
              await markParkedCleared(sessionId).catch(() => {})
            }
            if (reply.ok === true && reply.settled !== false) {
              try {
                const slot = await import('../../services/engine-connector/focusedConnector.js')
                if (slot.getFocusedSessionConnector().sessionId() === sessionId) {
                  const hops = await import('../../services/switchboard/hopIntoSession.js')
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
                logForDebugging(`[concourse] focus re-point after reap failed: ${e}`)
              }
            }
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
          const subject = row ? `'${(row.question ?? row.sessionId).slice(0, 40)}'` : 'a settled question'
          if (!row) {
            noteControl('peek:enter-full-session', {
              state: 'refused',
              reason: 'that question already settled — nothing to open',
            })
            return
          }
          if (row.sessionId.startsWith('dispatch:')) {
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
          attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })
          if (isCrossProjectFinishedRef(row.ref)) {
            void o
              .resolveObligation(obligationId, { kind: 'resolved', by: 'operator', scope: 'switchboard' })
              .catch(e => logForDebugging(`[concourse] cross-project ping settle failed: ${e}`))
          }
        })
      },
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
      pauseAfterTurn: sessionId => {
        if (peekOpInFlight.current.has('row:pause')) return
        peekOpInFlight.current.add('row:pause')
        noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'pausing…' })
        void (async () => {
          try {
            const { randomUUID } = await import('../../utils/crypto.js')
            const kernel = await import('../../services/concourse/coordinatorKernel.js')
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
        if (peekOpInFlight.current.has('row:resume')) return
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
      interruptSession: sessionId => {
        if (peekOpInFlight.current.has('row:interrupt')) return
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
      setSessionModel: (sessionId, modelId, displayName) => {
        if (peekOpInFlight.current.has('row:model')) return
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
            else if (receipt.outcome !== 'failed' && !(receipt.detail ?? '').startsWith('session-paused'))
              redirectIdRef.current.delete(sessionId)
            const feed = await import('../../services/concourse/coordinatorReceipts.js')
            feed.ingestCoordinatorReceipts([{ ...receipt, actorAgentId: 'operator' }])
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
            noteResident('held', 'the daemon was unreachable')
            noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
          }
          refresh()
        })()
      },
      setSessionEffort: (sessionId, effort) => {
        if (peekOpInFlight.current.has('row:effort')) return
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
        seedWriteChain.current = seedWriteChain.current.then(() => writeConcourseSeedOverride(patch))
      },
      submitSessionDraft: () => {
      },
      enterBootSettings: () => {
        enterBootSettings()
      },
      exitToRepl: () => {
        if (!enterRootRepl().ok) enterBootSettings()
      },
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
      switchCoordinatorEffort: async effortWord => {
        const models = await import('../../services/concourse/coordinatorModels.js')
        const receipt = await models.switchCoordinatorEffort(effortWord)
        refresh()
        return receipt
      },
      sendCoordinatorMessage: async (text, clientMessageId, onAccepted, opts) => {
        const lane = await import('../../services/concourse/coordinatorLane.js')
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
  useEffect(() => {
    let handle: { dispose(): void } | null = null
    let alive = true
    void import('../../services/switchboard/askPing.js')
      .then(m => {
        if (!alive) return
        handle = m.startAskPing()
      })
      .catch(() => {
      })
    return () => {
      alive = false
      handle?.dispose()
    }
  }, [])
  const submitInFlight = useRef(false)
  const seedWriteChain = useRef<Promise<unknown>>(Promise.resolve())
  const birthInFlightRef = useRef(false)
  const submitIdRef = useRef<{ key: string; id: string } | null>(null)
  useEffect(() => {
    void import('../../services/concourse/concourseSnapshot.js').then(async s => {
      if (submitIdRef.current !== null) return
      const held = await s.readConcourseHeldDispatch()
      if (held !== null && submitIdRef.current === null)
        submitIdRef.current = { key: held.envelopeKey, id: held.clientMessageId }
    })
  }, [])
  const daemonOfferRef = useRef<{ draft: string } | null>(null)
  const submitDraft = useCallback(
    (draft: string): void => {
      if (submitInFlight.current) return
      submitInFlight.current = true
      void (async () => {
        try {
          const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
          const { randomUUID } = await import('../../utils/crypto.js')
          await seedWriteChain.current
          const seeds = await readConcourseSeedOverrides()
          const si = dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId)
          const envelopeKey = `${draft}\u0000${JSON.stringify(si)}`
          const minted = submitIdRef.current
          const clientMessageId =
            minted !== null && minted.key === envelopeKey ? minted.id : `concourse-ui-${randomUUID()}`
          submitIdRef.current = { key: envelopeKey, id: clientMessageId }
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
              await snapshotStore.writeConcourseHeldDispatch({
                clientMessageId,
                envelopeKey,
                prompt: draft,
                op: opInputs,
              })
              if (r.code === 'ENOCONN') {
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
          logForDebugging(`[concourse] dispatch failed: ${e}`)
          noteResident('held', 'the daemon was unreachable')
          noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
        } finally {
          setTimeout(() => {
            submitInFlight.current = false
          }, 500)
          refresh()
        }
      })()
    },
    [noteResident, refresh, noteControl],
  )
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
        for (let i = 0; i < 40; i++) {
          const probe = (await daemonControlRpc({ op: 'concourseList' } as never, { timeoutMs: 500 })) as { code?: string }
          if (probe.code !== 'ENOCONN') {
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
      }
    })()
  }, [fixture, refresh])
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
        try {
          const attachedMod = await import('../../services/switchboard/attachedSession.js')
          const marker = await store.readConcoursePendingHandback()
          let handedBack = 0
          if (
            marker !== null &&
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
        }
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
              await store.writeConcourseHeldDelivery(sessionId, null)
              refresh()
            }
          }
        }
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
        }
        const held = await store.readConcourseHeldDispatch()
        if (held === null || held.prompt === undefined) return
        const rec = dispatchMod.readConcourseDispatches()[held.clientMessageId]
        if (rec === undefined) return
        if (rec.sessionId !== undefined && rec.state !== 'queued' && rec.state !== 'failed') {
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
        logForDebugging(`[concourse] admission pump beat failed (next refresh retries): ${e}`)
      } finally {
        pumpBusyRef.current = false
      }
    })()
  }, [liveSnapshot, fixture, drainQueuedStack, noteControl, refresh])
  if (!snapshot) return <ConcourseAssemblingShell failing={failing} onRetry={refresh} />
  if (waitingRoom !== null) {
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
  const screenCallbacks: ConcourseCallbacks = {
    ...callbacks,
    startSessionDraft: (text: string, caret?: number) => void writeConcourseDraft(text, undefined, caret),
    setDraftSeed: patch => {
      seedWriteChain.current = seedWriteChain.current.then(() => writeConcourseSeedOverride(patch))
      if ('projectDir' in patch) {
        void import('../../services/switchboard/harnessGround.js')
          .then(m =>
            m.applyHarnessGround(
              typeof patch.projectDir === 'string' && patch.projectDir.length > 0 ? patch.projectDir : null,
            ),
          )
          .catch(() => {
          })
      }
    },
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
      reducedStage={chatOnlyBoot()}
    />
  )
}

function ConcourseAssemblingShell({ failing, onRetry }: { failing: boolean; onRetry: () => void }): React.ReactNode {
  const t = useMercuryTokens()
  const { rows: termRows } = useTerminalSize()
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
        {
}
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
