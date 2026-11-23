import { sessionIdOfListing } from '../../sessions/transcripts/sessionStorage.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'

export function filterResumableSessions(
  logs: SessionListing[],
  currentSessionId: string,
): SessionListing[] {
  return logs.filter(
    log => !log.isSidechain && sessionIdOfListing(log) !== currentSessionId,
  )
}
