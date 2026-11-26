import { getListingDisplayTitle } from '../../platform/logs/errorLog.js'
import { enrichSessionListings, sessionIdOfListing } from './sessionListings.js'
import { compareSessionRecency, RECENCY_CLOCK_SLACK_MS } from './sessionIndex.js'
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

function compareStampDesc(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta
  return b.localeCompare(a)
}

function compareListedSessions(a: SessionListing, b: SessionListing): number {
  return (
    compareSessionRecency(
      { lastUsedMs: a.lastUsedAt ?? null, mtimeMs: a.modified.getTime(), sessionId: a.sessionId },
      { lastUsedMs: b.lastUsedAt ?? null, mtimeMs: b.modified.getTime(), sessionId: b.sessionId },
    ) || compareStampDesc(a.date, b.date)
  )
}

const RESTAMP_BURST_CAP = 32
const RESTAMP_SCAN_GUARD = RESTAMP_BURST_CAP * 8

export async function readListedSessions(lite: SessionListing[], count: number): Promise<SessionListing[]> {
  if (count <= 0) return []
  const listed: SessionListing[] = []
  let next = 0
  while (listed.length < count && next < lite.length) {
    const batch = await enrichSessionListings(lite, next, count - listed.length)
    next = batch.nextIndex
    listed.push(...listedSessionsOf(batch.logs, ''))
  }
  let extraKept = 0
  let scanned = 0
  while (listed.length >= count && next < lite.length && extraKept < RESTAMP_BURST_CAP && scanned < RESTAMP_SCAN_GUARD) {
    listed.sort(compareListedSessions)
    const boundary = listed[count - 1]!
    const threshold = boundary.lastUsedAt ?? null
    const candidateMtime = lite[next]!.modified.getTime()
    if (threshold !== null && candidateMtime + RECENCY_CLOCK_SLACK_MS < threshold && candidateMtime !== boundary.modified.getTime()) break
    const batch = await enrichSessionListings(lite, next, 1)
    next = batch.nextIndex
    scanned++
    const kept = listedSessionsOf(batch.logs, '')
    extraKept += kept.length
    listed.push(...kept)
  }
  listed.sort(compareListedSessions)
  return listed.slice(0, count)
}
