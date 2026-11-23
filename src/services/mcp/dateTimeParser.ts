import { queryUtility } from '../providers/anthropic/streamCore.js'
import { logError } from '../../utils/log.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
const ISO_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T|$)/
const LEADING_YEAR_PATTERN = /^\d{4}/
const PARSE_FAILURE_MESSAGE = 'Could not parse a date/time from that input'
const PARSE_ERROR_MESSAGE = 'Date parsing failed — enter the value in ISO 8601 format'
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

type DateTimeParseResult = { success: true; value: string } | { success: false; error: string }

function formatTimezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absOffset / 60)).padStart(2, '0')
  const minutes = String(absOffset % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

export function looksLikeISO8601(input: string): boolean {
  return ISO_PREFIX_PATTERN.test(input.trim())
}

export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  const now = new Date()
  const utcNow = now.toISOString()
  const tzOffset = formatTimezoneOffset(now)
  const weekday = WEEKDAYS[now.getDay()] ?? 'Sunday'
  const precision = format === 'date' ? 'date (YYYY-MM-DD)' : `date-time (YYYY-MM-DDTHH:MM:SS${tzOffset})`

  try {
    const response = await queryUtility({
      systemPrompt: asSystemPrompt([
        `Convert the user's date/time input into an ISO 8601 ${precision} string. ` +
          `Current UTC time: ${utcNow}. Local UTC offset: ${tzOffset}. Today is ${weekday}. ` +
          'Reply with ONLY the ISO 8601 value, or INVALID if the input cannot be parsed.',
      ]),
      userPrompt: input,
      signal,
      options: {
        querySource: 'mcp_datetime_parse',
        enablePromptCaching: false,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        mcpTools: [],
      },
    })
    const candidate = extractTextContent(response.message.content, '\n').trim()
    if (candidate === '' || candidate === 'INVALID' || !LEADING_YEAR_PATTERN.test(candidate)) {
      return { success: false, error: PARSE_FAILURE_MESSAGE }
    }
    return { success: true, value: candidate }
  } catch (error) {
    logError(error)
    return { success: false, error: PARSE_ERROR_MESSAGE }
  }
}
