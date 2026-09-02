// ============================================================================
//  src/constants/common.ts — local-date helpers with a date-override env and
//  a session-memoized date.
// ============================================================================
import { memoize } from 'lodash-es'

/**
 * The local calendar date as `YYYY-MM-DD`, zero-padded. (No test-override
 * env exists.)
 */
export function getLocalISODate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The local date, memoized for the process. Prompt-cache stability: the
 * bare/simple path rebuilds the system prompt per request and would
 * otherwise bust the cached prefix at midnight. A stale date after midnight
 * is preferred over a whole-conversation cache bust; the date-change
 * attachment appends the new date at the tail.
 */
export const getSessionStartDate = memoize(getLocalISODate)

/**
 * The current local month name and year in US English (for example
 * "February 2026"). Used in tool prompts because it changes monthly rather
 * than daily, minimizing cache invalidation.
 */
export function getLocalMonthYear(): string {
  const date = new Date()
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
