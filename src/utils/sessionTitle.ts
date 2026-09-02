import { z } from 'zod/v4'

import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { querySmallFast } from '../services/providers/anthropic/streamCore.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { extractTextContent } from './messages.js'
import { safeParseJSON } from './json.js'
import { asSystemPrompt } from './systemPromptType.js'

/**
 * A short session title from conversation text via the small/fast model.
 * Deliberately small import surface: the headless control-request handler
 * imports this and must stay clear of the UI, terminal-colour and
 * version-control chains the older title generators pull in.
 */

const DESCRIPTION_BUDGET = 1000

/**
 * User and assistant messages only; meta and non-human-origin messages
 * skipped; the LAST 1000 characters kept — a long conversation's end
 * describes the session better than its beginning.
 */
export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    if ((message as { isMeta?: boolean }).isMeta) continue
    const origin = (message as { origin?: { kind?: string } }).origin
    if (origin && origin.kind !== 'human') continue
    const content = message.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      const text = extractTextContent(content, '\n')
      if (text) parts.push(text)
    }
  }
  return parts.join('\n').slice(-DESCRIPTION_BUDGET)
}

const titleSchema = z.object({ title: z.string() }).strict()

/** The wire schema: an object with one required string property and no additional properties. */
const TITLE_OUTPUT_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
}

const TITLE_SYSTEM_PROMPT = [
  'Write a concise title for this coding session: three to seven words, sentence case, capturing the main topic or goal. ' +
    'It must be clear enough to recognise in a list of sessions. Capitalise only the first word and proper nouns. ' +
    'Respond with JSON containing a single "title" field.',
  'Good examples: "Fix flaky auth integration tests", "Refactor billing webhook retries", "Add CSV export to reports".',
  'Bad examples: "Coding session" (too vague), "Fixing the bug where the login page throws a 500 error when the session cookie expires" (too long), "Fix Flaky Auth Integration Tests" (wrongly cased).',
]

export async function generateSessionTitle(description: string, signal: AbortSignal): Promise<string | null> {
  if (description.trim() === '') return null
  try {
    const response = await querySmallFast({
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
      } as unknown as Parameters<typeof querySmallFast>[0]['options'],
    })
    const text = extractTextContent(response.message.content, '\n')
    const parsed = safeParseJSON(text, false)
    const validated = titleSchema.safeParse(parsed)
    if (!validated.success) return null
    const title = validated.data.title.trim()
    return title === '' ? null : title
  } catch (err) {
    logForDebugging(`generateSessionTitle failed: ${String(err)}`)
    return null
  }
}
