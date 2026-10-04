import { EMPTY_STREAM_END_MARKER, retrySeconds } from '../api/recoveryBudget.js'
import { jitterRetryDelay } from '../api/retryJitter.js'
import { createSystemAPIErrorMessage } from '../../utils/messages/systemMessages.js'
import type { SystemAPIErrorMessage } from '../../types/message.js'
import { BUSY_RETRY_RUNGS_MS, busyRetryScale } from './busyRetry.js'

export const EMPTY_STREAM_TRIES = 3

const EMPTY_STREAM_CODES: ReadonlySet<string> = new Set(['no-finish', 'no-terminal-event', 'no-body', 'read-failed'])

export function isEmptyStreamFault(fault: { code: string; retryable: boolean; status?: number; inStream?: true }): boolean {
  return fault.retryable && fault.status === undefined && fault.inStream !== true && EMPTY_STREAM_CODES.has(fault.code)
}

export function emptyStreamRetryWaitMs(scale: number = busyRetryScale()): number {
  const rungMs = Math.max(1, Math.round(BUSY_RETRY_RUNGS_MS[0]! * scale))
  const floorMs = Math.max(1, Math.ceil(rungMs * 0.75))
  return Math.min(Math.max(floorMs, Math.round(jitterRetryDelay(rungMs, 'symmetric'))), Math.ceil(rungMs * 1.25))
}

export function emptyStreamEndWords(provider: string, detail: string): string {
  return `${provider} ${EMPTY_STREAM_END_MARKER} (${detail})`
}

export function emptyStreamRetryNotice(args: { provider: string; detail: string; cause?: unknown; attempt: number; waitMs: number }): SystemAPIErrorMessage {
  const error = new Error(emptyStreamEndWords(args.provider, args.detail))
  if (args.cause instanceof Error) Object.assign(error, { cause: args.cause })
  return createSystemAPIErrorMessage(error, args.waitMs, args.attempt, EMPTY_STREAM_TRIES)
}

export function emptyStreamSpentWords(provider: string, elapsedMs: number, tries: number = EMPTY_STREAM_TRIES): string {
  return `${provider} ${EMPTY_STREAM_END_MARKER} ${tries} times in a row over ${retrySeconds(elapsedMs)}`
}
