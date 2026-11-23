import type { ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';
import type { useConcourseEntry } from './useConcourseEntry.js';

type Entry = ReturnType<typeof useConcourseEntry>;

export type RouteControls = {
  noteControl: (control: string, state: ControlNoteState) => void
  noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => void
  refresh: () => void
  snapshotRef: { current: ConcourseSnapshotV1 | null }
  stopAwaitingStampRef: { current: Set<string> }
  setWaitingRoom: Entry['setWaitingRoom']
  attachAndEnter: Entry['attachAndEnter']
  peekOpInFlight: { current: Set<string> }
  mintControlOpId: (key: string, fresh: string) => string
  controlOpIdRef: { current: Map<string, { id: string; mintedAtMs: number }> }
  redirectIdRef: { current: Map<string, { instruction: string; id: string }> }
}
