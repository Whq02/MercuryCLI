import type { UUID } from 'crypto'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { isENOENT } from '../errors.js'
import { logError } from '../log.js'
import { emptyFoldState, type TranscriptFoldState } from './fold.js'
import { getProjectDir } from './paths.js'
import { createTranscriptRows } from './rowGraph.js'
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

function cloneFold(fold: TranscriptFoldState): Omit<TranscriptFoldState, 'progressBridge'> {
  return {
    messages: createTranscriptRows(fold.messages),
    summaries: new Map(fold.summaries),
    customTitles: new Map(fold.customTitles),
    tags: new Map(fold.tags),
    agentNames: new Map(fold.agentNames),
    agentColors: new Map(fold.agentColors),
    agentSettings: new Map(fold.agentSettings),
    sessionBriefs: new Map(fold.sessionBriefs),
    sessionBriefAdds: new Map(fold.sessionBriefAdds),
    prNumbers: new Map(fold.prNumbers),
    prUrls: new Map(fold.prUrls),
    prRepositories: new Map(fold.prRepositories),
    modes: new Map(fold.modes),
    advisorSwitches: new Map(fold.advisorSwitches),
    swarmSwitches: new Map(fold.swarmSwitches),
    sessionModels: new Map(fold.sessionModels),
    worktreeStates: new Map(fold.worktreeStates),
    fileHistorySnapshots: new Map(fold.fileHistorySnapshots),
    attributionSnapshots: new Map(fold.attributionSnapshots),
    contentReplacements: new Map(
      Array.from(fold.contentReplacements, ([k, v]) => [k, [...v]]),
    ),
    agentContentReplacements: new Map(
      Array.from(fold.agentContentReplacements, ([k, v]) => [k, [...v]]),
    ),
    contextCollapseCommits: [...fold.contextCollapseCommits],
    contextCollapseSnapshot: fold.contextCollapseSnapshot,
    turnEnds: new Map(
      Array.from(fold.turnEnds, ([k, v]) => [k, { ...v, trailing: [...v.trailing] }]),
    ),
    turnsOpen: new Map(fold.turnsOpen),
  }
}

function emptyPublicFold(): Omit<TranscriptFoldState, 'progressBridge'> {
  const { progressBridge: _, ...rest } = emptyFoldState()
  return rest
}

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean; throwOnError?: boolean },
): Promise<TranscriptLoadResult> {
  let fold: Omit<TranscriptFoldState, 'progressBridge'>
  try {
    const view = await readTranscript(filePath, {
      policy: opts?.keepAllLeaves ? 'all' : 'resume',
    })
    fold = cloneFold(view.fold)
  } catch (error) {
    if (isENOENT(error)) {
      fold = emptyPublicFold()
    } else if (opts?.throwOnError === true) {
      throw error
    } else {
      logError(
        new Error(
          `transcript load failed for ${filePath}; continuing with partial state: ${String(error)}`,
        ),
      )
      fold = emptyPublicFold()
    }
  }
  const leafUuids = computeResumeLeaves(fold.messages)
  return { ...fold, leafUuids }
}

export function sessionFilePath(sessionId: UUID): string {
  const dir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(dir, `${sessionId}.jsonl`)
}

export async function loadSessionFile(sessionId: UUID): Promise<TranscriptLoadResult> {
  return loadTranscriptFile(sessionFilePath(sessionId))
}
