import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { logForDebugging } from '../../utils/debug.js';
import { getCwd } from '../../utils/cwd.js';
import { getInitialEffortSetting } from '../../utils/effort.js';
import { armFaceDoorDeepLink } from '../../substrate/splashHandover.js';
import {
  chatOnlyBoot,
  enterBootSettings,
  enterRootChat,
  registerRouteSurface,
  surfaceGeneration,
} from '../../context/surfaceRoute.js';
import {
  dispatchSeedInputs,
  markParkedCleared,
  OLDER_CHATS_ROW_PREFIX,
  readConcourseSeedOverrides,
  resolveHarnessGround,
  writeConcourseDraft,
  writeConcourseSeedOverride,
} from '../../services/concourse/concourseSnapshot.js';
import { resolveObligation } from '../../services/crew/obligations.js';
import { removePrefixRecord } from '../../services/providers/anthropic/prefixRecordStore.js';
import type { ConcourseCallbacks } from './contracts.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { splitAvailableAt, splitViewOn } from './splitView.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { ConcourseScreen } from './ConcourseScreen.js';
import { SessionWaitingRoom } from './SessionWaitingRoom.js';
import { ConcourseAssemblingShell } from './route/Assembling.js';
import { noteFromReceipt, rowReceipt, rowReceiptClock } from './route/receipts.js';
import { readFixtureSnapshot, useConcourseSnapshot } from './route/useConcourseSnapshot.js';
import { useConcourseAdmissionPump } from './route/useConcourseAdmissionPump.js';
import { useConcourseControlNotes } from './route/useConcourseControlNotes.js';
import { useConcourseDraftDispatch } from './route/useConcourseDraftDispatch.js';
import { useConcourseEntry } from './route/useConcourseEntry.js';

export { makeCoalescedRebuild } from './route/useConcourseSnapshot.js';


async function restFocusedSlotAfterRelease(
  sessionId: string,
  rows: ReadonlyArray<{ sessionId: string; state: string }>,
): Promise<void> {
  try {
    const slot = await import('../../services/engine-connector/focusedConnector.js')
    if (slot.getFocusedSessionConnector().sessionId() !== sessionId) return
    const hops = await import('../../services/switchboard/hopIntoSession.js')
    const survivors = rows.filter(
      r =>
        r.sessionId !== sessionId &&
        !r.sessionId.startsWith('dispatch:') &&
        !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX) &&
        r.state !== 'queued' &&
        r.state !== 'stopped' &&
        r.state !== 'parked',
    )
    for (const next of survivors) {
      const hop = await hops.hopIntoBoardSession(next.sessionId)
      if (hop.ok) return
    }
    slot.releaseFocusedSessionConnector()
  } catch (e) {
    logForDebugging(`[concourse] focus re-point after reap failed: ${e}`)
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
  const { controlNotes, noteControl } = useConcourseControlNotes()
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
  const { waitingRoom, setWaitingRoom, drainQueuedStack, attachAndEnter, waitingRoomAdmitted } = useConcourseEntry({ noteControl, splitFrameStands, snapshotRef, setPeek })
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
            const control = await import('../../services/concourse/boardControl.js')
            const receipt = await control.executeBoardControl({
              verb: 'obligation.answer',
              obligationId,
              sessionId: row.sessionId,
              clientMessageId: `obl-answer:${obligationId}`,
              answer,
              by: 'operator',
            })
            control.noteBoardControl(receipt)
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
              const workers = await import('../../daemon/concourseWorkers.js')
              const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
              const rec = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
              const runnerAlive = rec?.pid !== undefined && isProcessAlive(rec.pid)
              if (rec !== undefined && !runnerAlive) {
                const out = workers.stopConcourseSession(sessionId, 'operator', undefined)
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
            const parkApplied = reply.ok === true && reply.outcome !== 'refused'
            const workers = await import('../../daemon/concourseWorkers.js')
            const released = parkApplied && !Object.values(workers.readSessionWorkers()).some(r => r.sessionId === sessionId && r.endedAt === undefined)
            if (released) {
              await markParkedCleared(sessionId).catch(() => {})
              removePrefixRecord(sessionId)
              await restFocusedSlotAfterRelease(sessionId, snapshotRef.current?.groups.flatMap(g => g.rows) ?? [])
            }
            noteControl(
              'strip:composer',
              parkApplied
                ? released
                  ? { state: 'applied', reason: 'removed from the board — the chat held no message' }
                  : { state: 'applied', reason: `archived — the chat stands parked; ${keyHintLabel('⌃x ⌃x')} again in 5 s deletes it` }
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
              removePrefixRecord(sessionId)
              const workersSync = await import('../../daemon/concourseWorkers.js')
              const parkedRecord = Object.values(workersSync.readSessionWorkers()).find(
                r => r.sessionId === sessionId && r.endedAt === undefined,
              )
              if (parkedRecord === undefined) {
                noteControl('strip:composer', { state: 'applied', reason: 'cleared from the board — the chat survives; the boot face or /sessions bring it back' })
                refresh()
                return
              }
            }
            const { ensureOwnedDaemon } = await import('../../services/switchboard/ensureDaemon.js')
            const daemonUp = await ensureOwnedDaemon()
            const workers = await import('../../daemon/concourseWorkers.js')
            const rec = Object.values(workers.readSessionWorkers()).find(
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
                : { ok: true, settled: workers.settleConcourseWorker(rec.runnerId) }
            }
            if (reply.ok === true && reply.settled !== false) {
              await markParkedCleared(sessionId).catch(() => {})
              removePrefixRecord(sessionId)
            }
            if (reply.ok === true && reply.settled !== false) {
              await restFocusedSlotAfterRelease(sessionId, snapshotRef.current?.groups.flatMap(g => g.rows) ?? [])
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
            const { getOperatorName } = await import('../../substrate/identity/operatorDisplayName.js')
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
            const control = await import('../../services/concourse/boardControl.js')
            const clientOpId = mintControlOpId(`pause:${sessionId}`, `concourse-op-${randomUUID()}`)
            const receipt = await control.executeBoardControl({
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
            control.noteBoardControl(receipt, { opId: clientOpId })
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
            const control = await import('../../services/concourse/boardControl.js')
            const clientOpId = mintControlOpId(`resume:${sessionId}`, `concourse-op-${randomUUID()}`)
            const receipt = await control.executeBoardControl({ verb: 'session.resume', sessionId, by: 'operator', clientOpId })
            if (receipt.outcome !== 'failed') {
              controlOpIdRef.current.delete(`pause:${sessionId}`)
              controlOpIdRef.current.delete(`resume:${sessionId}`)
            }
            control.noteBoardControl(receipt, { opId: clientOpId })
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
            const control = await import('../../services/concourse/boardControl.js')
            const minted = redirectIdRef.current.get(sessionId)
            const clientMessageId =
              minted !== undefined && minted.instruction === instruction ? minted.id : `concourse-redirect-${randomUUID()}`
            redirectIdRef.current.set(sessionId, { instruction, id: clientMessageId })
            const receipt = await control.executeBoardControl({
              verb: 'session.redirect',
              sessionId,
              clientMessageId,
              instruction,
              by: 'operator',
            })
            if (receipt.outcome === 'applied') redirectIdRef.current.delete(sessionId)
            else if (receipt.outcome !== 'failed' && !(receipt.detail ?? '').startsWith('session-paused'))
              redirectIdRef.current.delete(sessionId)
            control.noteBoardControl(receipt)
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
      enterBootSettings: (door, opener) => {
        if (door) armFaceDoorDeepLink(door, opener)
        return enterBootSettings().ok
      },
      exitToChat: () => {
        if (!enterRootChat().ok) enterBootSettings()
      },
    }),
    [setPeek, noteResident, refresh, noteControl, attachAndEnter],
  )
  const { seedWriteChain, birthInFlightRef, daemonOfferRef, submitDraft, answerDaemonOffer } = useConcourseDraftDispatch({ snapshotRef, noteResident, refresh, noteControl })
  useConcourseAdmissionPump({ fixture, liveSnapshot, refresh, drainQueuedStack, noteControl })
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
              enterRootChat()
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
    previewLaunch: async () => {
      await seedWriteChain.current
      const seeds = await readConcourseSeedOverrides()
      const si = dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId, getInitialEffortSetting())
      const folder = basename(si.workspaceDir) || si.workspaceDir
      if (seeds.isolation !== undefined) return { folder, forks: false, mainHolderTitle: null }
      const { previewDefaultedLaunch } = await import('../../daemon/concourseDispatch.js')
      const preview = previewDefaultedLaunch(si.workspaceDir)
      return { folder, forks: preview.forks, mainHolderTitle: preview.mainHolderTitle ?? null }
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

registerRouteSurface('concourse', { render: () => <LiveConcourse /> })
