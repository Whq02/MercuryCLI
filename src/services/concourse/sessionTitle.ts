import { z } from 'zod/v4'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { queryUtility } from '../providers/anthropic/streamCore.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { extractTextContent } from '../messages.js'
import { safeParseJSON } from '../../utils/json.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'


const DESCRIPTION_BUDGET = 1000

export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    if (message.type === 'user') {
      if (message.isMeta) continue
      if (message.origin && message.origin.kind !== 'human') continue
    }
    const content = message.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      const text = extractTextContent(content, '\n')
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n')
  return joined.length > DESCRIPTION_BUDGET ? joined.slice(-DESCRIPTION_BUDGET) : joined
}

const TITLE_SYSTEM_PROMPT = [
  'Write a concise title for this coding session: three to seven words, sentence case, capturing the main topic or goal. ' +
    'It must be clear enough to recognise in a list of sessions. Capitalise only the first word and proper nouns. ' +
    'Respond with JSON containing a single "title" field.',
  'Good examples: "Fix flaky auth integration tests", "Refactor billing webhook retries", "Add CSV export to reports".',
  'Bad examples: "Coding session" (too vague), "Fixing the bug where the login page throws a 500 error when the session cookie expires" (too long), "Fix Flaky Auth Integration Tests" (wrongly cased).',
]

const TITLE_RESPONSE_SCHEMA = z.strictObject({
  title: z.string(),
})

const TITLE_OUTPUT_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const },
    },
    required: ['title'],
    additionalProperties: false,
  },
}

export async function generateSessionTitle(description: string, signal: AbortSignal): Promise<string | null> {
  if (description.trim() === '') return null
  try {
    const response = await queryUtility({
      systemPrompt: asSystemPrompt(TITLE_SYSTEM_PROMPT),
      userPrompt: description,
      outputFormat: TITLE_OUTPUT_FORMAT,
      signal,
      options: {
        querySource: 'generate_session_title',
        isNonInteractiveSession: getIsNonInteractiveSession(),
        hasAppendSystemPrompt: false,
        agents: [],
        mcpTools: [],
      },
    })
    const text = extractTextContent(response.message.content, '\n')
    const parsed = safeParseJSON(text, false)
    const validated = TITLE_RESPONSE_SCHEMA.safeParse(parsed)
    if (!validated.success) return null
    const sanitized = partiallySanitizeUnicode(validated.data.title).trim()
    return sanitized === '' ? null : sanitized
  } catch (error) {
    logForDebugging(`generateSessionTitle failed: ${String(error)}`)
    return null
  }
}
