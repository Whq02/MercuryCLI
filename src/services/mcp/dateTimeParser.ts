import { queryUtility } from '../providers/anthropic/streamCore.js'
import { logError } from '../../utils/log.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { notBuilt } from '../../pi/holes.js'


type DateTimeParseResult = { success: true; value: string } | { success: false; error: string }

export function looksLikeISO8601(input: string): boolean {
  return notBuilt('src/services/mcp/dateTimeParser.ts:9')
}

export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  return notBuilt('src/services/mcp/dateTimeParser.ts:24')
}
