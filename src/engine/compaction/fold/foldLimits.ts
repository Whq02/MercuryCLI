import { formatTokens } from '../../../platform/text/format.js'

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25000

export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.'
export const NO_MESSAGES_TO_COMPACT = 'No messages to compact.'
export const NOTHING_TO_COMPACT_KEY = 'Nothing to compact: '
const NOTHING_TO_COMPACT_YET_KEY = 'Nothing to compact yet: '

export type NothingToCompactReason =
  | 'already-folded'
  | 'too-few-messages'
  | 'recent-turns-kept'
  | 'would-not-shrink'

export function isNothingToCompactMessage(message: string): boolean {
  return (
    message.startsWith(NOTHING_TO_COMPACT_KEY) ||
    message.startsWith(NOTHING_TO_COMPACT_YET_KEY) ||
    message === NO_MESSAGES_TO_COMPACT ||
    message === ERROR_MESSAGE_NOT_ENOUGH_MESSAGES
  )
}

export function nothingToCompactLine(contextTokens: number, reason: NothingToCompactReason | boolean = 'already-folded'): string {
  const resolved: NothingToCompactReason =
    reason === true ? 'already-folded' : reason === false ? 'too-few-messages' : reason
  const tokens = formatTokens(contextTokens)
  switch (resolved) {
    case 'already-folded':
      return `${NOTHING_TO_COMPACT_KEY}the last fold already holds this conversation (${tokens} tokens)`
    case 'too-few-messages':
      return `${NOTHING_TO_COMPACT_YET_KEY}too few messages to fold (${tokens} tokens).`
    case 'recent-turns-kept':
      return `${NOTHING_TO_COMPACT_YET_KEY}the recent turns are kept whole and hold most of the ${tokens} tokens.`
    case 'would-not-shrink':
      return `${NOTHING_TO_COMPACT_YET_KEY}a summary would not shrink the ${tokens} tokens.`
  }
}

export const ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD = 'Compaction cannot bring the context under its threshold'
export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'This conversation could not be compacted: too much context. Start fresh with /clear, or choose a larger context window and run /compact again.'
export const ERROR_MESSAGE_USER_ABORT = 'Compaction cancelled.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction interrupted before a summary arrived. Try /compact again.'

export const PTL_RETRY_LIMIT = 3
export const NO_SUMMARY_RETRY_LIMIT = 2
export const SUMMARISER_WINDOW_SHARE = 0.85
export const SUMMARISER_BUDGET_FLOOR_TOKENS = 2000
export const SHAPED_RESULTS_KEEP_TOKENS = 50000
export const SHAPED_RESULT_PREVIEW_CHARS = 2000
export const SPLIT_STAND_IN_FLOOR_TOKENS = 500
export const SPLIT_STAND_IN_LANDING_SHARE = 4
export const PROVIDER_FINISH_FAULT_PREFIX = 'finish:'
export const PROVIDER_TERMINATION_NOTE = /^\[[a-z0-9_-]+\] the provider ended this response\b/i
export const ERROR_MESSAGE_NO_SUMMARY = 'The summariser produced no summary'
export const PROSE_SKIPPED_KEY = 'The prose summary was skipped'
export const PART_SUMMARY_MARKER = '[earlier turns folded into this summary for the compaction]'
export const PART_TEXT_CHUNK_CHARS = 40_000
export const PART_TEXT_CHUNK_FLOOR_CHARS = 2_000
export const MODEL_REFUSAL_STOP_KEY = 'stop_reason: refusal'
export const PTL_TRUNCATION_MARKER = '[earlier turns folded for the compaction retry]'
export const LEGACY_PTL_TRUNCATION_MARKER = '[earlier conversation truncated for compaction retry]'
export const KEEPALIVE_INTERVAL_MS = 30_000
export const DEGRADED_SUMMARY_LENGTH = 80
