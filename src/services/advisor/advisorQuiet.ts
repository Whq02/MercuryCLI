import { randomUUID } from 'crypto'
import type { SystemAdvisorQuietMessage } from '../../types/message.js'
import type { AdvisorOrigin } from '../../utils/messages/noticeRows.js'
import { ADVISOR_EMPTY_TWICE_REASON } from './advisorCall.js'

export const ADVISOR_QUIET_SUBTYPE = 'advisor_quiet'
export const ADVISOR_QUIET_HEAD = 'had nothing to say this round'
export const ADVISOR_QUIET_EMPTY_TAIL = 'answered with no text, twice'
export const ADVISOR_QUIET_REASON_CLIP = 160

export interface AdvisorQuiet {
  origin: AdvisorOrigin
  reason: string
  empty: boolean
}

export function advisorQuietWords(quiet: AdvisorQuiet): string {
  if (quiet.empty || quiet.reason === ADVISOR_EMPTY_TWICE_REASON) return `${ADVISOR_QUIET_HEAD} — ${ADVISOR_QUIET_EMPTY_TAIL}`
  const flat = quiet.reason.replace(/\s+/g, ' ').trim()
  const clipped = flat.length > ADVISOR_QUIET_REASON_CLIP ? `${flat.slice(0, ADVISOR_QUIET_REASON_CLIP)}…` : flat
  return clipped === '' ? ADVISOR_QUIET_HEAD : `${ADVISOR_QUIET_HEAD} — ${clipped}`
}

export function createAdvisorQuietMessage(quiet: AdvisorQuiet): SystemAdvisorQuietMessage {
  return {
    type: 'system',
    subtype: ADVISOR_QUIET_SUBTYPE,
    content: advisorQuietWords(quiet),
    origin: quiet.origin,
    level: 'info',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function isAdvisorQuietMessage(message: unknown): message is SystemAdvisorQuietMessage {
  if (typeof message !== 'object' || message === null) return false
  const m = message as { type?: unknown; subtype?: unknown }
  return m.type === 'system' && m.subtype === ADVISOR_QUIET_SUBTYPE
}
