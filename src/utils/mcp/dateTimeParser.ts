import { querySmallFast } from '../../services/providers/anthropic/streamCore.js'
import { logError } from '../log.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../systemPromptType.js'

/**
 * Natural-language date/time to ISO 8601 via a small fast model. The
 * caller re-validates the returned value against its schema.
 */

export type DateTimeParseResult = { success: true; value: string } | { success: false; error: string }

/** Four digits, hyphen, two, hyphen, two, then `T` or end — used to decide whether natural-language parsing is worth attempting. */
export function looksLikeISO8601(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(input.trim())
}

const UNPARSEABLE_MESSAGE = 'Could not parse a date/time from that input'

function localOffsetString(now: Date): string {
  // The JavaScript convention is inverted: getTimezoneOffset() is minutes
  // BEHIND UTC.
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  try {
    const now = new Date()
    const offset = localOffsetString(now)
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })

    const systemPrompt = [
      'You are a date/time parser. Convert natural-language date/time input into ISO 8601. ' +
        'Respond with ONLY the formatted string — no explanation. ' +
        'When the input is ambiguous, prefer future dates over past dates. ' +
        'A time without a date uses today\'s date. A date without a time omits the time component. ' +
        'If the input is unparseable or incomplete, respond with exactly the token INVALID.',
      'Invalid examples: "March" (partial date), "42" (a lone number), "asdfgh" (gibberish).',
      'Valid examples: "tomorrow at 3pm", "next Monday", "in two weeks", "June 5th".',
    ]
    const expectedFormat =
      format === 'date'
        ? 'a day-precision date in YYYY-MM-DD form'
        : `a full date-time with the timezone offset ${offset}`
    const userPrompt =
      `Current date/time (UTC): ${now.toISOString()}\n` +
      `Local timezone offset: ${offset}\n` +
      `Current weekday: ${weekday}\n` +
      `Input: "${input}"\n` +
      `Expected output: ${expectedFormat}.\n` +
      'Return only the formatted string, or INVALID.'

    const response = await querySmallFast({
      systemPrompt: asSystemPrompt(systemPrompt),
      userPrompt,
      signal,
      options: {
        querySource: 'mcp_datetime_parse',
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        mcpTools: [],
        disablePromptCaching: true,
      } as unknown as Parameters<typeof querySmallFast>[0]['options'],
    })

    const text = extractTextContent(response.message.content, '\n').trim()
    if (text === '' || text === 'INVALID') {
      return { success: false, error: UNPARSEABLE_MESSAGE }
    }
    // Sanity: the response must begin with a four-digit year. The value is
    // otherwise returned WITHOUT further validation — the caller
    // re-validates against the schema.
    if (!/^\d{4}/.test(text)) {
      return { success: false, error: UNPARSEABLE_MESSAGE }
    }
    return { success: true, value: text }
  } catch (error) {
    // Underlying details never reach the user.
    logError(error)
    return { success: false, error: 'Date parsing failed — enter the value in ISO 8601 format' }
  }
}
