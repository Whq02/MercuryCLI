import { queryUtility } from '../../models/roads/anthropic/streamCore.js'
import { logError } from '../../platform/logs/errorLog.js'
import { extractTextContent } from '../../engine/messages/messages.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
const ISO_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T|$)/
const LEADING_YEAR_PATTERN = /^\d{4}/
const PARSE_FAILURE_MESSAGE = 'Could not parse a date/time from that input'
const PARSE_ERROR_MESSAGE = 'Date parsing failed — enter the value in ISO 8601 format'

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
  const offset = formatTimezoneOffset(now)
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const expected = format === 'date' ? 'a day-precision date in YYYY-MM-DD form' : `a full date-time with the timezone offset ${offset}`

  try {
    const response = await queryUtility({
      systemPrompt: asSystemPrompt([
        'You are a date/time parser. Convert natural-language date/time input into ISO 8601. ' +
          'Respond with ONLY the formatted string — no explanation. ' +
          'When the input is ambiguous, prefer future dates over past dates. ' +
          "A time without a date uses today's date. A date without a time omits the time component. " +
          'If the input is unparseable or incomplete, respond with exactly the token INVALID.',
        'Invalid examples: "March" (partial date), "42" (a lone number), "asdfgh" (gibberish).',
        'Valid examples: "tomorrow at 3pm", "next Monday", "in two weeks", "June 5th".',
      ]),
      userPrompt:
        `Current date/time (UTC): ${now.toISOString()}\n` +
        `Local timezone offset: ${offset}\n` +
        `Current weekday: ${weekday}\n` +
        `Input: "${input}"\n` +
        `Expected output: ${expected}.\n` +
        'Return only the formatted string, or INVALID.',
      signal,
      options: {
        querySource: 'mcp_datetime_parse',
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        mcpTools: [],
        enablePromptCaching: false,
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
