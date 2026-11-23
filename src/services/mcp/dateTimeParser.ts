import { queryUtility } from '../providers/anthropic/streamCore.js'
import { logError } from '../../utils/log.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const PARSE_FAILURE_MESSAGE = 'Could not parse a date/time from that input'

type DateTimeParseResult = { success: true; value: string } | { success: false; error: string }

function formatTimezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0')
  const minutes = String(absOffset % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

function formatLocalTimestamp(date: Date, tzOffset: string): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${tzOffset}`
}

export function looksLikeISO8601(input: string): boolean {
  const trimmed = input.trim()
  return ISO_DATE_PATTERN.test(trimmed) || ISO_DATE_TIME_PATTERN.test(trimmed)
}

export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { success: false, error: PARSE_FAILURE_MESSAGE }
  }
  if (looksLikeISO8601(trimmed)) {
    return { success: true, value: trimmed }
  }
  const now = new Date()
  const tzOffset = formatTimezoneOffset(now)
  const localNow = formatLocalTimestamp(now, tzOffset)
  const targetFormat = format === 'date' ? 'YYYY-MM-DD' : `YYYY-MM-DDTHH:MM:SS${tzOffset}`
  try {
    const response = await queryUtility({
      systemPrompt: asSystemPrompt([
        `Convert the user's natural language date/time expression into an ISO-8601 ${format} string (${targetFormat}). ` +
          `The current local date and time is ${localNow} (UTC offset ${tzOffset}). ` +
          'Reply with ONLY the formatted ISO-8601 string, or INVALID if the input cannot be parsed as a date or time.',
      ]),
      userPrompt: trimmed,
      signal,
      options: {
        querySource: 'mcp_datetime_parse',
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        mcpTools: [],
        maxOutputTokensOverride: 64,
      },
    })
    if (response.isApiErrorMessage) {
      return { success: false, error: PARSE_FAILURE_MESSAGE }
    }
    const candidate = extractTextContent(response.message.content).trim()
    if (format === 'date') {
      if (ISO_DATE_PATTERN.test(candidate)) {
        return { success: true, value: candidate }
      }
      if (ISO_DATE_TIME_PATTERN.test(candidate)) {
        return { success: true, value: candidate.slice(0, 10) }
      }
    } else if (ISO_DATE_TIME_PATTERN.test(candidate)) {
      return { success: true, value: candidate }
    }
    return { success: false, error: PARSE_FAILURE_MESSAGE }
  } catch (error) {
    if (!signal.aborted) {
      logError(error)
    }
    return { success: false, error: PARSE_FAILURE_MESSAGE }
  }
}
