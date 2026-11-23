import { queryUtility } from '../../services/providers/anthropic/streamCore.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../services/messages.js'
import { extractConversationText } from '../../services/concourse/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

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
  const conversationText = extractConversationText(messages)
  if (!conversationText) return null
  try {
    const response = await queryUtility({
      systemPrompt: asSystemPrompt(NAME_SYSTEM_PROMPT),
      userPrompt: conversationText,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'rename_generate_name',
        isNonInteractiveSession: true,
        agents: [],
        mcpTools: [],
        hasAppendSystemPrompt: false,
      },
    })
    const text = extractTextContent(response.message.content).trim()
    const parsed = safeParseJSON(text, false)
    if (parsed !== null && typeof parsed === 'object') {
      const rawName = (parsed as { name?: unknown }).name
      if (typeof rawName === 'string') {
        const trimmed = rawName.trim()
        return trimmed.length > 0 ? trimmed : null
      }
    }
    return null
  } catch (error) {
    logForDebugging(
      `generateSessionName failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
