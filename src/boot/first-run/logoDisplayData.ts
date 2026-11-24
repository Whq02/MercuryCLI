import { getSessionId } from '../process-state/processState.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { listProjectSessions } from '../../sessions/transcripts/sessionStorage.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const RECENT_ACTIVITY_LOAD_LIMIT = 10
const RECENT_ACTIVITY_KEEP = 3
const NO_PROMPT_PLACEHOLDER = 'No prompt'
const APOLOGY_MARKER = 'I apologize'

let recentActivityPromise: Promise<SessionListing[]> | null = null

function meaningful(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== NO_PROMPT_PLACEHOLDER
}

export function getRecentActivity(): Promise<SessionListing[]> {
  if (recentActivityPromise) return recentActivityPromise
  recentActivityPromise = (async () => {
    try {
      const logs = await listProjectSessions(RECENT_ACTIVITY_LOAD_LIMIT)
      const currentSession = getSessionId()
      const kept = logs
        .filter(log => !log.isSidechain)
        .filter(log => log.sessionId !== currentSession)
        .filter(log => !(log.summary ?? '').includes(APOLOGY_MARKER))
        .filter(log => meaningful(log.summary) || meaningful(log.firstPrompt))
        .slice(0, RECENT_ACTIVITY_KEEP)
      return kept
    } catch (error) {
      passedOver(error)
      return []
    }
  })()
  return recentActivityPromise
}
