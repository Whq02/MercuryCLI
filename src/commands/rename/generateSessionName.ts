import { queryUtility } from '../../services/providers/anthropic/streamCore.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../services/messages.js'
import { extractConversationText } from '../../services/concourse/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { notBuilt } from '../../pi/holes.js'

const NAME_SYSTEM_PROMPT = [
  'Generate a short kebab-case name for this coding session: 2-4 words, lower-cased, joined by hyphens, capturing the main topic or goal.',
  'Good examples: "fix-auth-tests", "billing-webhook-retries", "csv-export-reports".',
  'Bad examples: "Coding Session" (not kebab-case), "fix-the-bug-where-the-login-page-throws" (too long).',
  'Respond with JSON containing a single "name" field.',
]

export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
): Promise<string | null> {
  return notBuilt('src/commands/rename/generateSessionName.ts:26')
}
