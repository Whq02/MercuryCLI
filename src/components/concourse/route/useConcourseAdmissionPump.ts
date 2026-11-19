import { useEffect, useRef } from 'react';
import { logForDebugging } from '../../../utils/debug.js';
import { getCwd } from '../../../utils/cwd.js';
import { readConcourseSeedOverrides, writeConcourseSeedOverride } from '../../../services/concourse/concourseSnapshot.js';
import type { ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';
import { deliverHeld, dispatchHeld, handBack, sweepNeedsYou, type PumpBeat } from './admissionBeats.js';

export function useConcourseAdmissionPump({
  fixture,
  liveSnapshot,
  refresh,
  drainQueuedStack,
  noteControl,
}: {
  fixture: ConcourseSnapshotV1 | null
  liveSnapshot: ConcourseSnapshotV1 | null
  refresh: () => void
  drainQueuedStack: (dispatchId: string, sessionId: string) => Promise<void>
  noteControl: (control: string, state: ControlNoteState) => void
}): void {
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
        const store = await import('../../../services/concourse/concourseSnapshot.js')
        const dispatchMod = await import('../../../daemon/concourseDispatch.js')
        const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
        const beat: PumpBeat = { snap, store, dispatchMod, daemonControlRpc, noteControl, refresh, drainQueuedStack }
        await handBack(beat)
        await deliverHeld(beat)
        try {
          const rowsNY = snap.needsYou ?? []
          if (rowsNY.length > 0) {
            await sweepNeedsYou(beat, rowsNY)
          }
        } catch {
        }
        await dispatchHeld(beat)
      } catch (e) {
        logForDebugging(`[concourse] admission pump beat failed (next refresh retries): ${e}`)
      } finally {
        pumpBusyRef.current = false
      }
    })()
  }, [liveSnapshot, fixture, drainQueuedStack, noteControl, refresh])
}
