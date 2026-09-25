
import type { UUID } from 'crypto'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { logError } from '../log.js'
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

export type TranscriptLoadResult = Omit<TranscriptFoldState, 'progressBridge'> & {
  leafUuids: Set<UUID>
}

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<TranscriptLoadResult> {
  let fold: TranscriptFoldState = emptyFoldState()
  try {
    const view = await readTranscript(filePath, { policy: opts?.keepAllLeaves ? 'all' : 'resume' })
    fold = copyOfFold(view.fold)
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

function copyOfFold(fold: TranscriptFoldState): TranscriptFoldState {
  return {
    messages: new Map(fold.messages),
    summaries: new Map(fold.summaries),
    customTitles: new Map(fold.customTitles),
    tags: new Map(fold.tags),
    agentNames: new Map(fold.agentNames),
    agentColors: new Map(fold.agentColors),
    agentSettings: new Map(fold.agentSettings),
    prNumbers: new Map(fold.prNumbers),
    prUrls: new Map(fold.prUrls),
    prRepositories: new Map(fold.prRepositories),
    modes: new Map(fold.modes),
    worktreeStates: new Map(fold.worktreeStates),
    fileHistorySnapshots: new Map(fold.fileHistorySnapshots),
    attributionSnapshots: new Map(fold.attributionSnapshots),
    contentReplacements: new Map([...fold.contentReplacements].map(([k, v]) => [k, [...v]])),
    agentContentReplacements: new Map([...fold.agentContentReplacements].map(([k, v]) => [k, [...v]])),
    contextCollapseCommits: [...fold.contextCollapseCommits],
    contextCollapseSnapshot: fold.contextCollapseSnapshot,
    progressBridge: fold.progressBridge,
  }
}

export async function loadSessionFile(sessionId: UUID): Promise<TranscriptLoadResult> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}
