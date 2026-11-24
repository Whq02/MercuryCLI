import { getListingDisplayTitle } from '../../platform/logs/errorLog.js'
import { enrichSessionListings, sessionIdOfListing } from './sessionListings.js'
import type { SessionListing } from './transcriptEntries.js'

const SUBSTANTIVE_FILE_SIZE = 4096

const PLACEHOLDER_PROMPTS = new Set(['(session)', 'No prompt'])

function isCommandOnlyPrompt(fp: string): boolean {
  const s = fp.trim()
  if (!s) return false
  if (
    s.startsWith('<command-name>') ||
    s.startsWith('<command-message>') ||
    s.startsWith('<local-command-caveat>') ||
    s.startsWith('<local-command-stdout>')
  ) {
    return true
  }
  return s.startsWith('/')
}

function isSubstantiveSession(log: SessionListing): boolean {
  if (log.customTitle && log.customTitle.trim()) return true

  const fp = (log.firstPrompt ?? '').trim()

  if (fp && !PLACEHOLDER_PROMPTS.has(fp) && !isCommandOnlyPrompt(fp)) {
    return true
  }

  return (log.fileSize ?? 0) >= SUBSTANTIVE_FILE_SIZE
}

export function filterResumableSessions(
  logs: SessionListing[],
  currentSessionId: string,
): SessionListing[] {
  return logs.filter(
    log => !log.isSidechain && sessionIdOfListing(log) !== currentSessionId,
  )
}

export function listedSessionsOf(logs: SessionListing[], currentSessionId: string): SessionListing[] {
  return filterResumableSessions(logs, currentSessionId).filter(isSubstantiveSession)
}

export function listedSessionName(log: SessionListing, renamed = ''): string | null {
  const title = renamed.trim() || (log.customTitle ?? '').trim()
  if (title.length > 0) return title
  const prompt = getListingDisplayTitle({ ...log, agentName: undefined, customTitle: undefined, summary: undefined }, '')
  if (prompt.length > 0 && prompt !== log.sessionId?.slice(0, 8)) return prompt
  const fallback = getListingDisplayTitle({ ...log, agentName: undefined, customTitle: undefined }, '')
  return fallback.length > 0 ? fallback : null
}

export async function readListedSessions(lite: SessionListing[], count: number): Promise<SessionListing[]> {
  const listed: SessionListing[] = []
  let next = 0
  while (listed.length < count && next < lite.length) {
    const batch = await enrichSessionListings(lite, next, count - listed.length)
    next = batch.nextIndex
    listed.push(...listedSessionsOf(batch.logs, ''))
  }
  return listed
}
