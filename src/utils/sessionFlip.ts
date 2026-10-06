import type { UUID } from 'node:crypto'
import { getProjectRoot } from '../bootstrap/state.js'
import { conversationIdHere } from '../services/engine-connector/focusedConnector.js'
import { filterResumableSessions } from './sessionResumeFilter.js'
import { isProjectSession, isSubstantiveSession } from './sessionFilter.js'
import { isSessionCleared } from './sessionStorage/clearedSessions.js'
import { validateUuid } from './uuid.js'
import {
  sessionIdOfListing,
  isLiteListing,
  listSessionsAcrossProjects,
  fillSessionListing,
} from './sessionStorage.js'
import type { ResumeEntrypoint } from '../commands.js'
import type { SessionListing } from '../types/logs.js'

export type SessionFlipOutcome =
  | { flipped: true }
  | { flipped: false; note?: string }

export async function resolveSessionFlipTarget(
  wanted: string,
): Promise<{ target: SessionListing; sessionId: UUID } | { target: null; note?: string }> {
  const all = await listSessionsAcrossProjects()  
  const resumable = filterResumableSessions(all, conversationIdHere())
    .filter(isSubstantiveSession)
    .filter(l => isProjectSession(l, getProjectRoot() || ''))
    .filter(l => !isSessionCleared(sessionIdOfListing(l)))
  resumable.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
  )
  if (wanted && !resumable.some(l => sessionIdOfListing(l) === wanted)) {
    return {
      target: null,
      note: `Session ${wanted.slice(0, 8)}… is no longer in this project's flip ring (cleared, removed, or another project's). /sessions reaches the full history.`,
    }
  }
  const target = wanted
    ? resumable.find(l => sessionIdOfListing(l) === wanted)
    : resumable[0]
  if (!target) {
    return { target: null, note: 'No other session to flip to — this is the only one.' }
  }
  const rawId = sessionIdOfListing(target)
  if (!rawId) return { target: null }
  const sessionId = validateUuid(rawId)
  if (!sessionId) return { target: null }
  return { target, sessionId }
}

export async function flipToSession(
  resume: (
    sessionId: UUID,
    log: SessionListing,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>,
  wanted = '',
): Promise<SessionFlipOutcome> {
  try {
    const resolved = await resolveSessionFlipTarget(wanted)
    if (resolved.target === null) {
      return { flipped: false, note: resolved.note }
    }
    const fullLog = isLiteListing(resolved.target)
      ? await fillSessionListing(resolved.target)
      : resolved.target
    await resume(resolved.sessionId, fullLog, 'slash_command_picker')
    return { flipped: true }
  } catch {
    return { flipped: false }
  }
}
