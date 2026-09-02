
import type { UUID } from 'crypto'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  FileHistorySnapshotMessage,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import { logError } from '../log.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { emptyFoldState, type TranscriptFoldState } from './fold.js'
import { getProjectDir } from './paths.js'
import { computeResumeLeaves, readTranscript } from './transcriptReader.js'

export { applyTranscriptEntry, emptyFoldState, type TranscriptFoldState } from './fold.js'
export {
  _resetTranscriptLoadDegradationForTesting,
  pruneRecordBranchesBeforeParse,
  subscribeTranscriptLoadDegradation,
  transcriptLoadDegradation,
  type TranscriptLoadDegradation,
} from './transcriptReader.js'

type TranscriptLoadResult = Omit<TranscriptFoldState, 'progressBridge'> & {
  leafUuids: Set<UUID>
}

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<TranscriptLoadResult> {
  let fold: TranscriptFoldState = emptyFoldState()
  try {
    const view = await readTranscript(filePath, { policy: opts?.keepAllLeaves ? 'all' : 'resume' })
    fold = view.fold
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError(
        new Error(
          `transcript load failed for ${filePath}; continuing with partial state: ${e}`,
        ),
      )
    }
  }

  const { progressBridge: _internal, ...publicFold } = fold

  return {
    ...publicFold,
    leafUuids: computeResumeLeaves(publicFold.messages),
  }
}

export async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}
