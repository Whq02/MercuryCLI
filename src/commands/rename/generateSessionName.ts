import { querySmallFast } from '../../services/providers/anthropic/streamCore.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../utils/messages.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

const NAME_OUTPUT_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
}

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
  if (conversationText === '') return null
  try {
    const options: Parameters<typeof querySmallFast>[0]['options'] = {
      querySource: 'rename_generate_name',
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      agents: [],
      mcpTools: [],
    }
    const response = await querySmallFast({
      systemPrompt: asSystemPrompt(NAME_SYSTEM_PROMPT),
      userPrompt: conversationText,
      outputFormat: NAME_OUTPUT_FORMAT,
      signal,
      options,
    })
    const text = extractTextContent(response.message.content, '\n')
    const parsed = safeParseJSON(text, false)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      typeof (parsed as { name: unknown }).name === 'string'
    ) {
      return (parsed as { name: string }).name
    }
    return null
  } catch (thrown) {
    logForDebugging(`generateSessionName failed: ${String(thrown)}`)
    return null
  }
}
