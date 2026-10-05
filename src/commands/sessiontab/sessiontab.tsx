import { getProjectRoot } from '../../bootstrap/state.js'
import { conversationIdHere } from '../../services/engine-connector/focusedConnector.js'
import { filterResumableSessions } from '../resume/resume.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { isProjectSession, isSubstantiveSession } from '../../utils/sessionFilter.js'
import { isSessionCleared } from '../../utils/sessionStorage/clearedSessions.js'
import {
  sessionIdOfListing,
  isLiteListing,
  listSessionsAcrossProjects,
  fillSessionListing,
} from '../../utils/sessionStorage.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const live = context.resume
  if (!live) {
    onDone(undefined, { display: 'skip' })
    return null
  }
  try {
    const all = await listSessionsAcrossProjects()
    const resumable = filterResumableSessions(all, conversationIdHere())
      .filter(isSubstantiveSession)
      .filter(l => isProjectSession(l, getProjectRoot() || ''))
      .filter(l => !isSessionCleared(sessionIdOfListing(l)))
    resumable.sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    )
    const wanted = (args ?? '').trim()
    if (wanted && !resumable.some(l => sessionIdOfListing(l) === wanted)) {
      onDone(
        `Session ${wanted.slice(0, 8)}… is no longer in this project's flip ring (cleared, removed, or another project's). /resume reaches the full history.`,
        { display: 'system' },
      )
      return null
    }
    const target = wanted
      ? resumable.find(l => sessionIdOfListing(l) === wanted)
      : resumable[0]
    if (!target) {
      onDone('No other session to flip to — this is the only one.', {
        display: 'system',
      })
      return null
    }
    const sessionId = sessionIdOfListing(target)
    if (!sessionId) {
      onDone(undefined, { display: 'skip' })
      return null
    }
    const fullLog = isLiteListing(target) ? await fillSessionListing(target) : target
    await context.resume!(sessionId, fullLog, 'slash_command_picker')
    onDone(undefined, { display: 'skip' })
  } catch {
    onDone(undefined, { display: 'skip' })
  }
  return null
}
