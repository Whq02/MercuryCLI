import { logForDebugging } from '../../../utils/debug.js';
import { markParkedCleared, OLDER_CHATS_ROW_PREFIX } from '../../../services/concourse/concourseSnapshot.js';
import { removePrefixRecord } from '../../../services/providers/anthropic/prefixRecordStore.js';
import { keyHintLabel } from '../../mercury-ui/keyHintLabel.js';
import type { ControlNoteState } from '../contracts.js';
import type { RouteControls } from './controlContext.js';

async function clearedMarkWritten(sessionId: string): Promise<boolean> {
  try {
    await markParkedCleared(sessionId)
    return true
  } catch (e) {
    logForDebugging(`[concourse] the cleared mark of ${sessionId} was not written, the row can come back: ${e}`)
    return false
  }
}

function clearedMarkMissedNote(): ControlNoteState {
  return { state: 'failed', reason: 'removed from the board, but that could not be recorded', next: `it may show again; ${keyHintLabel('⌃x ⌃x')} clears it then` }
}

async function restFocusedSlotAfterRelease(
  sessionId: string,
  rows: ReadonlyArray<{ sessionId: string; state: string }>,
): Promise<void> {
  try {
    const slot = await import('../../../services/engine-connector/focusedConnector.js')
    if (slot.getFocusedSessionConnector().sessionId() !== sessionId) return
    const hops = await import('../../../services/switchboard/hopIntoSession.js')
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

export function stopSession({ noteControl, stopAwaitingStampRef, refresh }: RouteControls, sessionId: string): void {
  void (async () => {
    try {
      const { ensureOwnedDaemon } = await import('../../../services/switchboard/ensureDaemon.js')
      const daemonUp = await ensureOwnedDaemon()
      if (!daemonUp) {
        const workers = await import('../../../daemon/concourseWorkers.js')
        const { isProcessAlive } = await import('../../../utils/ownerWatch.js')
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
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'concourseControl', action: 'stop', sessionId, by: 'operator' },
        { timeoutMs: 15_000 },
      )
      const acknowledged = reply.ok === true && reply.outcome === 'applied' && /^stopped /.test(reply.detail ?? '')
      if (reply.ok === true && reply.outcome === 'applied' && !acknowledged && reply.detail !== undefined) stopAwaitingStampRef.current.add(sessionId)
      noteControl(
        'strip:composer',
        reply.ok === true && reply.outcome !== 'refused'
          ? {
              state: 'applied',
              reason: acknowledged || reply.outcome === 'noop' || reply.detail === undefined ? `stopped — ${keyHintLabel('⌃x ⌃x')} archives it (the chat stands parked)` : reply.detail,
            }
          : { state: 'refused', reason: (reply.ok ? reply.detail : reply.error) ?? `stop refused${reply.ok ? '' : ` (${reply.code})`}` },
      )
    } catch {
      noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: `${keyHintLabel('⌃x ⌃x')} retries` })
    }
    refresh()
  })()
}

export function archiveSession({ noteControl, refresh, snapshotRef }: RouteControls, sessionId: string): void {
  void (async () => {
    try {
      const { ensureOwnedDaemon } = await import('../../../services/switchboard/ensureDaemon.js')
      const daemonUp = await ensureOwnedDaemon()
      if (!daemonUp) {
        noteControl('strip:composer', { state: 'failed', reason: 'the daemon that hosts sessions is not reachable', next: `${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` })
        refresh()
        return
      }
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'sessionControl', action: 'park', sessionId, by: 'operator' },
        { timeoutMs: 15_000 },
      )
      const parkApplied = reply.ok === true && reply.outcome !== 'refused'
      const workers = await import('../../../daemon/concourseWorkers.js')
      const released = parkApplied && !Object.values(workers.readSessionWorkers()).some(r => r.sessionId === sessionId && r.endedAt === undefined)
      const markWritten = released ? await clearedMarkWritten(sessionId) : true
      if (released) {
        removePrefixRecord(sessionId)
        await restFocusedSlotAfterRelease(sessionId, snapshotRef.current?.groups.flatMap(g => g.rows) ?? [])
      }
      noteControl(
        'strip:composer',
        parkApplied
          ? released
            ? markWritten
              ? { state: 'applied', reason: 'removed from the board — the chat held no message' }
              : clearedMarkMissedNote()
            : { state: 'applied', reason: `archived — the chat stands parked; ${keyHintLabel('⌃x ⌃x')} again in 5 s deletes it` }
          : { state: 'refused', reason: (reply.ok ? reply.detail : reply.error) ?? `archive refused${reply.ok ? '' : ` (${reply.code})`}` },
      )
    } catch {
      noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: `${keyHintLabel('⌃x ⌃x')} retries` })
    }
    refresh()
  })()
}

export function removeSession({ noteControl, refresh, snapshotRef }: RouteControls, sessionId: string): void {
  void (async () => {
    try {
      if (sessionId.startsWith('dispatch:')) {
        const clientMessageId = sessionId.slice('dispatch:'.length)
        let gone = false
        try {
          const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
          const reply = await daemonControlRpc(
            { op: 'concourseWithdraw', clientMessageId },
            { timeoutMs: 10_000 },
          )
          if (reply.ok !== true) throw new Error('withdraw rpc refused')
          gone = reply.withdrawn === true
        } catch {
          const { withdrawConcourseDispatch } = await import('../../../daemon/concourseDispatch.js')
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
        const workersSync = await import('../../../daemon/concourseWorkers.js')
        const parkedRecord = Object.values(workersSync.readSessionWorkers()).find(
          r => r.sessionId === sessionId && r.endedAt === undefined,
        )
        if (parkedRecord === undefined) {
          noteControl('strip:composer', { state: 'applied', reason: 'cleared from the board — the chat survives; the boot face or /sessions bring it back' })
          refresh()
          return
        }
      }
      const { ensureOwnedDaemon } = await import('../../../services/switchboard/ensureDaemon.js')
      const daemonUp = await ensureOwnedDaemon()
      const workers = await import('../../../daemon/concourseWorkers.js')
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
        const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
        reply = await daemonControlRpc(
          { op: 'sessionRelease', runnerId: rec.runnerId },
          { timeoutMs: 15_000 },
        )
      } else {
        const { isProcessAlive } = await import('../../../utils/ownerWatch.js')
        const runnerAlive = rec.pid !== undefined && isProcessAlive(rec.pid)
        reply = runnerAlive
          ? { ok: false, error: `the daemon that hosts sessions is not reachable and the runner is alive — ${keyHintLabel('⌃x ⌃x')} retries once the daemon is back` }
          : { ok: true, settled: workers.settleConcourseWorker(rec.runnerId) }
      }
      const markWritten = reply.ok === true && reply.settled !== false ? await clearedMarkWritten(sessionId) : true
      if (reply.ok === true && reply.settled !== false) {
        removePrefixRecord(sessionId)
      }
      if (reply.ok === true && reply.settled !== false) {
        await restFocusedSlotAfterRelease(sessionId, snapshotRef.current?.groups.flatMap(g => g.rows) ?? [])
      }
      noteControl(
        'strip:composer',
        reply.ok === true && reply.settled !== false
          ? markWritten
            ? { state: 'applied', reason: 'removed from the board — the transcript survives' }
            : clearedMarkMissedNote()
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
}

export function renameSession({ noteControl, refresh }: RouteControls, sessionId: string, title: string): void {
  noteControl('strip:composer', 'pending')
  void (async () => {
    try {
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'concourseControl', action: 'set-title', sessionId, by: 'operator', title, titleSource: 'operator' },
        { timeoutMs: 10_000 },
      )
      noteControl(
        'strip:composer',
        reply.ok === true && reply.outcome === 'applied'
          ? { state: 'applied', reason: `renamed to "${title.trim().slice(0, 40)}"` }
          : { state: 'refused', reason: (reply.ok ? reply.detail : undefined) ?? 'the title was not set' },
      )
    } catch {
      noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: 'r retries' })
    }
    refresh()
  })()
}
