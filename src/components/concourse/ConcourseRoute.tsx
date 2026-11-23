import React, { useCallback, useMemo, useRef, useState } from 'react';
import { usePublish } from '../../hooks/effects.js';
import { armFaceDoorDeepLink } from '../../substrate/splashHandover.js';
import {
  activeReturnToken,
  chatOnlyBoot,
  enterBootSettings,
  enterRootChat,
  leaveCurrentSurface,
  registerRouteSurface,
  routeSurfaceRegistered,
} from '../../context/surfaceRoute.js';
import {
  writeConcourseDraft,
  writeConcourseSeedOverride,
} from '../../services/concourse/concourseSnapshot.js';
import type { ConcourseCallbacks, ControlNoteState } from './contracts.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { splitAvailableAt, splitViewOn } from './splitView.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { ConcourseScreen } from './ConcourseScreen.js';
import { SessionWaitingRoom } from './SessionWaitingRoom.js';
import { ConcourseAssemblingShell } from './route/Assembling.js';
import { readFixtureSnapshot, useConcourseSnapshot } from './route/useConcourseSnapshot.js';
import { useConcourseAdmissionPump } from './route/useConcourseAdmissionPump.js';
import { useConcourseControlNotes } from './route/useConcourseControlNotes.js';
import { useConcourseDraftDispatch } from './route/useConcourseDraftDispatch.js';
import { useConcourseEntry } from './route/useConcourseEntry.js';
import { newSession, previewLaunch } from './route/launchControls.js';
import { answerObligation, answerPermission, claimObligation, openObligation, withdrawObligation } from './route/obligationControls.js';
import { interruptSession, pauseAfterTurn, redirectSession, resumeSession, setSessionEffort, setSessionModel } from './route/rowControls.js';
import { archiveSession, removeSession, renameSession, stopSession } from './route/sessionControls.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';

export { makeCoalescedRebuild } from './route/useConcourseSnapshot.js';

export async function applySeedProjectGround(
  projectDir: unknown,
  noteControl: (control: string, state: ControlNoteState) => void,
  applyGround?: (dir: string | null) => Promise<string>,
): Promise<void> {
  const target = typeof projectDir === 'string' && projectDir.length > 0 ? projectDir : null
  try {
    const apply = applyGround ?? (await import('../../services/switchboard/harnessGround.js')).applyHarnessGround
    const applied = await apply(target)
    if (target !== null && applied !== target) {
      noteControl('strip:composer', {
        state: 'failed',
        reason: `Could not switch to ${target} — stayed in ${applied}; pick the repo again.`,
      })
    }
  } catch (error) {
    logForDebugging(`[concourse] ground switch failed: ${error}`)
    noteControl('strip:composer', {
      state: 'failed',
      reason: `Could not switch to ${target ?? 'the boot folder'} (${errorMessage(error)}) — pick the repo again.`,
    })
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
  usePublish(() => {
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
    () => {
      const controls = { noteControl, noteResident, refresh, snapshotRef, stopAwaitingStampRef, setWaitingRoom, attachAndEnter, peekOpInFlight, mintControlOpId, controlOpIdRef, redirectIdRef }
      return {
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
      answerObligation: (obligationId, answer) => answerObligation(controls, obligationId, answer),
      answerPermission: (requestId, allow, obligationId) => answerPermission(controls, requestId, allow, obligationId),
      stopSession: sessionId => stopSession(controls, sessionId),
      archiveSession: sessionId => archiveSession(controls, sessionId),
      removeSession: sessionId => removeSession(controls, sessionId),
      renameSession: (sessionId, title) => renameSession(controls, sessionId, title),
      openObligation: obligationId => openObligation(controls, obligationId),
      withdrawObligation: obligationId => withdrawObligation(controls, obligationId),
      claimObligation: obligationId => claimObligation(controls, obligationId),
      pauseAfterTurn: sessionId => pauseAfterTurn(controls, sessionId),
      resumeSession: sessionId => resumeSession(controls, sessionId),
      interruptSession: sessionId => interruptSession(controls, sessionId),
      setSessionModel: (sessionId, modelId, displayName) => setSessionModel(controls, sessionId, modelId, displayName),
      redirectSession: (sessionId, instruction) => redirectSession(controls, sessionId, instruction),
      setSessionEffort: (sessionId, effort) => setSessionEffort(controls, sessionId, effort),
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
        if (!enterRootChat().ok && (activeReturnToken()?.to.kind !== 'boot-settings' || !leaveCurrentSurface().ok)) {
          enterBootSettings()
        }
      },
      }
    },
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
  const launch = { noteControl, splitFrameStands, birthInFlightRef, seedWriteChain, snapshotRef }
  const screenCallbacks: ConcourseCallbacks = {
    ...callbacks,
    startSessionDraft: (text: string, caret?: number) => void writeConcourseDraft(text, undefined, caret),
    setDraftSeed: patch => {
      seedWriteChain.current = seedWriteChain.current.then(() => writeConcourseSeedOverride(patch))
      if ('projectDir' in patch) {
        void applySeedProjectGround(patch.projectDir, noteControl)
      }
    },
    newSession: () => newSession(launch),
    submitSessionDraft: (text: string) => {
      if (text.trim().length > 0) submitDraft(text)
    },
    previewLaunch: () => previewLaunch(launch),
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

export function registerConcourseRoute(): void {
  if (routeSurfaceRegistered('concourse')) return
  registerRouteSurface('concourse', { render: () => <LiveConcourse /> })
}
