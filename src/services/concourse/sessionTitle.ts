import { z } from 'zod/v4'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { queryUtility } from '../providers/anthropic/streamCore.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { extractTextContent } from '../messages.js'
import { safeParseJSON } from '../../utils/json.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { notBuilt } from '../../pi/holes.js'


const DESCRIPTION_BUDGET = 1000

export function extractConversationText(messages: Message[]): string {
  return notBuilt('src/services/concourse/sessionTitle.ts:15')
}

const TITLE_SYSTEM_PROMPT = [
  'Write a concise title for this coding session: three to seven words, sentence case, capturing the main topic or goal. ' +
    'It must be clear enough to recognise in a list of sessions. Capitalise only the first word and proper nouns. ' +
    'Respond with JSON containing a single "title" field.',
  'Good examples: "Fix flaky auth integration tests", "Refactor billing webhook retries", "Add CSV export to reports".',
  'Bad examples: "Coding session" (too vague), "Fixing the bug where the login page throws a 500 error when the session cookie expires" (too long), "Fix Flaky Auth Integration Tests" (wrongly cased).',
]

export async function generateSessionTitle(description: string, signal: AbortSignal): Promise<string | null> {
  return notBuilt('src/services/concourse/sessionTitle.ts:53')
}
