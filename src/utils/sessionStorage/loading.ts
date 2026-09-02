// sessionStorage/loading — the resume read contract: loadTranscriptFile
// hands back the fold of one transcript plus the computed resume leaves.
// The bytes are the one transcript reader's business (transcriptReader.ts
// — offset, fold, growth reads, the cold ladder, the degradation latch);
// the entry fold is fold.ts. Mercury-owned.

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

/** The fold state minus its internal bridge map, plus the computed leaves —
 *  what loadTranscriptFile hands back. */
type TranscriptLoadResult = Omit<TranscriptFoldState, 'progressBridge'> & {
  leafUuids: Set<UUID>
}

/**
 * Read one transcript file into a fold state plus computed resume leaves.
 * The absent-file case resolves to an empty result by design (a fresh
 * session has no file yet); any OTHER failure still resolves — resume must
 * degrade, not crash — but is logged with its cause first.
 *
 * The reader keeps the fold per path: a transcript read before in this
 * process folds only what was appended since (the cold ladder — snapshot
 * plus tail, the big-file strategies, the plain read — runs once, and
 * again only when the file was truncated, replaced or rewritten). The maps
 * handed back are the reader's own: read them, never mutate them.
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<TranscriptLoadResult> {
  let fold: TranscriptFoldState = emptyFoldState()
  try {
    const view = await readTranscript(filePath, { policy: opts?.keepAllLeaves ? 'all' : 'resume' })
    fold = view.fold
  } catch (e) {
    // Missing file = a session that has not written yet: quiet, empty
    // result. Anything else still degrades to an empty fold — resume must
    // not crash — but says why first.
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

/** Resolve a sessionId to its transcript in the current project tree and
 *  load it. */
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
