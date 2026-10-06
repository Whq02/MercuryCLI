import { sessionIdOfListing } from './sessionStorage.js'
import type { SessionListing } from '../types/logs.js'

export function filterResumableSessions(
  logs: SessionListing[],
  currentSessionId: string,
): SessionListing[] {
  return logs.filter(
    log => !log.isSidechain && sessionIdOfListing(log) !== currentSessionId,
  )
}
