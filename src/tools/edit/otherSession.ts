import { getSessionId } from '../../boot/process-state/processState.js'
import { liveSessions } from '../../sessions/mneme/ledger.js'
import { mnemeProjectKey } from '../../sessions/mneme/paths.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../kit/names/fileEdit.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const UNREAD_EXISTING_FILE_NOTE = "it exists and was not read in this session, so it may be another session's work"

export function otherLiveSessionsClause(): string {
  let others: { sessionId: string; startedAt: string }[]
  try {
    const own = String(getSessionId())
    others = liveSessions(mnemeProjectKey()).filter(session => session.sessionId !== own)
  } catch (error) {
    passedOver(error)
    return ''
  }
  if (others.length === 0) return ''
  const named = others.map(session => `${session.sessionId.slice(0, 8)} since ${session.startedAt === '' ? 'an unrecorded time' : session.startedAt}`)
  return others.length === 1 ? ` Another session of this project is live: ${named[0]}.` : ` Other sessions of this project are live: ${named.join(', ')}.`
}

export function modifiedSinceReadMessage(): string {
  return `${FILE_UNEXPECTEDLY_MODIFIED_ERROR}${otherLiveSessionsClause()}`
}

export function unreadExistingWriteMessage(): string {
  return `Read the file before overwriting it — ${UNREAD_EXISTING_FILE_NOTE}; a prior read of the current content is required.${otherLiveSessionsClause()}`
}
