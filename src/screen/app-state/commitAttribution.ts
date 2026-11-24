import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { FileAttributionState } from '../../sessions/transcripts/transcriptEntries.js'

type SessionBaseline = {
  contentHash: string
  mtime: number
}

export type AttributionState = {
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, SessionBaseline>
  surface: string
  startingHeadSha: string | null
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

function getClientSurface(): string {
  const value = flagEnv('MERCURY_ENTRYPOINT')
  return value === undefined ? 'cli' : value
}

export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(), sessionBaselines: new Map(), surface: getClientSurface(), startingHeadSha: null,
    promptCount: 0, promptCountAtLastCommit: 0, permissionPromptCount: 0, permissionPromptCountAtLastCommit: 0,
    escapeCount: 0, escapeCountAtLastCommit: 0,
  }
}
