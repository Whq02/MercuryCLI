import type { UUID } from 'crypto'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { logError } from '../log.js'
import { emptyFoldState, type TranscriptFoldState } from './fold.js'
import { getProjectDir } from './paths.js'
import { createTranscriptRows } from './rowGraph.js'
import { computeResumeLeaves, readTranscript } from './transcriptReader.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export { applyTranscriptEntry, emptyFoldState, type TranscriptFoldState } from './fold.js'
export {
  _resetTranscriptLoadDegradationForTesting,
  pruneRecordBranchesBeforeParse,
  subscribeTranscriptLoadDegradation,
  transcriptLoadDegradation,
  type TranscriptLoadDegradation,
} from './transcriptReader.js'

export type TranscriptLoadResult = Unbuilt

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean; throwOnError?: boolean },
): Promise<TranscriptLoadResult> {
  return notBuilt('src/utils/sessionStorage/loading.ts:24')
}

export function sessionFilePath(sessionId: UUID): string {
  return notBuilt('src/utils/sessionStorage/loading.ts:82')
}

export async function loadSessionFile(sessionId: UUID): Promise<TranscriptLoadResult> {
  return loadTranscriptFile(sessionFilePath(sessionId))
}
