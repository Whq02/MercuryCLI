import { useCallback, useRef, useState } from 'react';
import { logForDebugging } from '../../../utils/debug.js';
import { consumeEntryDecisionInput, enterRootChat, returnToConcourse, surfaceGeneration } from '../../../context/surfaceRoute.js';
import { markSessionSeen, OLDER_CHATS_ROW_PREFIX } from '../../../services/concourse/concourseSnapshot.js';
import { getFocusedSessionConnector, hasFocusedSession, withLanding } from '../../../services/engine-connector/focusedConnector.js';
import { armEntryWarmth, settleEntryWarmth } from '../../../services/concourse/sessionWarmth.js';
import type { ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';
import { passedOver } from '../../../utils/passedOver.js';

export function useConcourseEntry({
  noteControl,
  splitFrameStands,
  snapshotRef,
  setPeek,
}: {
  noteControl: (control: string, state: ControlNoteState) => void
  splitFrameStands: () => boolean
  snapshotRef: { current: ConcourseSnapshotV1 | null }
  setPeek: (sessionId: string) => void
}) {
  const enterOpRef = useRef<{ sessionId: string; gen: number } | null>(null)
  const [waitingRoom, setWaitingRoom] = useState<{
    dispatchId: string
    title: string
    project: string
  } | null>(null)
  const drainQueuedStack = useCallback(async (dispatchId: string, sessionId: string): Promise<void> => {
    try {
      const store = await import('../../../services/concourse/concourseSnapshot.js')
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const entries = await store.readConcourseQueuedStack(dispatchId)
      for (const entry of entries) {
        const reply = await daemonControlRpc(
          {
            op: 'concourseDispatch',
            clientMessageId: entry.clientMessageId,
            prompt: entry.text,
            workspaceDir: '',
            targetSessionId: sessionId,
            by: 'operator',
          },
          { timeoutMs: 15_000 },
        )
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
      void markSessionSeen(sessionId).catch(passedOver)
      const row = snapshotRef.current?.groups.flatMap(g => g.rows).find(r => r.sessionId === sessionId)
      const rowParked = row?.state === 'parked' ? { transcriptPath: row.transcriptPath, title: row.title } : undefined
      const parked = opts?.parkedFact ?? rowParked
      const op = { sessionId, gen: surfaceGeneration() }
      enterOpRef.current = op
      noteControl(noteKey, { state: 'pending', reason: parked !== undefined ? 'bringing it back…' : 'opening…' })
      armEntryWarmth(sessionId, row?.title ?? parked?.title, hasFocusedSession() ? getFocusedSessionConnector().sessionId() : undefined)
      const landing = withLanding(
        (async () => {
          const hops = await import('../../../services/switchboard/hopIntoSession.js')
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
        } else if (enterRootChat().ok) {
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
              enterRootChat()
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
  return { waitingRoom, setWaitingRoom, drainQueuedStack, attachAndEnter, waitingRoomAdmitted }
}
