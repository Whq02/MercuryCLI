import type { UUID } from 'crypto'
import type { AgentId } from '../../types/ids.js'
import type {
  AttributionSnapshotEntry,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  Entry,
  FileHistorySnapshotEntry,
  PersistedWorktreeSession,
  TranscriptMessage,
  TurnEnded,
} from '../../types/logs.js'
import type { StorageRowKind, StorageRowOf } from '../../rows/storage.js'
import { isCompactBoundaryMessage } from '../messages/systemMessages.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { isPersistedProgressEntry } from './paths.js'
import { createTranscriptRows, transcriptRows } from './rowGraph.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type TranscriptFoldState = Unbuilt

export function emptyFoldState(): TranscriptFoldState {
  return notBuilt('src/utils/sessionStorage/fold.ts:48')
}

function noteRowBehindTurnEnd(state: TranscriptFoldState, row: TranscriptMessage): void {
  const ended = state.turnEnds.get(row.sessionId)
  if (ended === undefined || row.isSidechain || state.messages.has(row.uuid)) return
  if (row.type === 'attachment') ended.trailing.push(row.uuid)
  else if (row.type === 'user' || (row.type === 'assistant' && row.isApiErrorMessage !== true)) {
    state.turnEnds.delete(row.sessionId)
    state.turnsOpen.set(row.sessionId, true)
  }
}

function appendReplacements<K>(map: Map<K, ContentReplacementRecord[]>, key: K, additions: ContentReplacementRecord[]): void {
  let records = map.get(key)
  if (!records) map.set(key, records = [])
  records.push(...additions)
}

export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  return notBuilt('src/utils/sessionStorage/fold.ts:155')
}

export function finishTranscriptFold(state: TranscriptFoldState): void {
  transcriptRows(state.messages).finish()
}
