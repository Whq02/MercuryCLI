import type { UUID } from 'node:crypto'
import { getProjectRoot } from '../../boot/process-state/processState.js'
import { conversationIdHere } from './focusedConnector.js'
import { listedSessionsOf } from '../../sessions/transcripts/listedSessions.js'
import { isProjectSession } from '../../screen/session-chooser/sessionFilter.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { isSessionCleared } from '../../sessions/transcripts/clearedSessions.js'
import { validateUuid } from '../../platform/primitives/uuid.js'
import {
  sessionIdOfListing,
  isLiteListing,
  listSessionsAcrossProjects,
  fillSessionListing,
} from '../../sessions/transcripts/sessionStorage.js'
import type { ResumeEntrypoint } from '../../commands/catalogue/commands.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'

type SessionFlipOutcome =
  | { flipped: true }
  | { flipped: false; note?: string }

async function resolveSessionFlipTarget(
  wanted: string,
): Promise<{ target: SessionListing; sessionId: UUID } | { target: null; note?: string }> {
  const all = await listSessionsAcrossProjects()  
  const resumable = listedSessionsOf(all, conversationIdHere())
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
  } catch (error) {
    return { flipped: false, note: `Could not flip to that session (${errorMessage(error)}) — /sessions reaches the full history.` }
  }
}
