import type { PermissionMode } from '../../types/permissions.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { formatLimit, minutesKnobToMs } from '../deadline.js'
import { DENIAL_WORKAROUND_GUIDANCE } from '../messages/rejectionText.js'

export const FLOW_ASK_LIMIT_MINUTES = 10
export const SOVEREIGN_ASK_LIMIT_MINUTES = 3
export const CREWMATE_ASK_LIMIT_MINUTES = 10

export interface AskClockSubject {
  mode: PermissionMode | string | undefined
  crewmate: boolean
}

export function askLimitMinutes(subject: AskClockSubject): number {
  if (subject.mode === 'flow') return FLOW_ASK_LIMIT_MINUTES
  if (subject.mode === 'sovereign') return SOVEREIGN_ASK_LIMIT_MINUTES
  return subject.crewmate ? CREWMATE_ASK_LIMIT_MINUTES : 0
}

export function askLimitMs(subject: AskClockSubject): number {
  const minutes = askLimitMinutes(subject)
  if (minutes === 0) return 0
  return minutesKnobToMs(flagEnv('MERCURY_PERMISSION_ASK_EXPIRY_MINUTES'), minutes)
}

const ASK_EXPIRED_CAUSE_LEAD = 'expired unanswered after '

export function askExpiredCause(limitMs: number): string {
  return `${ASK_EXPIRED_CAUSE_LEAD}${formatLimit(limitMs)}`
}

export function isAskExpiredCause(cause: string): boolean {
  return cause.startsWith(ASK_EXPIRED_CAUSE_LEAD)
}

export function unansweredAskRefusal(toolName: string, limitMs: number): string {
  return (
    `Permission to use ${toolName} has been denied: nobody answered the permission ask within ${formatLimit(limitMs)}, so it expired and was refused; the action was not run. ` +
    `Work that does not depend on this action can continue. ${DENIAL_WORKAROUND_GUIDANCE}`
  )
}
