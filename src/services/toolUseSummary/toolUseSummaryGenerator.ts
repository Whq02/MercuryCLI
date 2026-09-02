/**
 * Generate a short past-tense label describing what a batch of tool calls
 * accomplished, for compact progress display in embedding clients.
 *
 * The whole body sits inside the failure handler, so a serialization or query
 * error is caught the same way; failures are non-fatal and yield nothing.
 */
import { querySmallFast } from '../providers/anthropic/index.js'
import { E_TOOL_USE_SUMMARY_GENERATION_FAILED } from '../../constants/errorIds.js'
import { logError } from '../../utils/log.js'
import { toError } from '../../utils/errors.js'
import { extractTextContent } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

const INPUT_OUTPUT_LIMIT = 300
const INTENT_LIMIT = 200

export type GenerateToolUseSummaryParams = {
  tools: Array<{ name: string; input: unknown; output: unknown }>
  signal: AbortSignal
  isNonInteractiveSession: boolean
  lastAssistantText?: string
}

/** JSON-serialize and truncate to 300 chars, the final three replaced by an
 *  ellipsis when over the limit; a serialization failure yields a fixed
 *  placeholder. */
function renderValue(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable value]'
  }
  if (serialized.length <= INPUT_OUTPUT_LIMIT) return serialized
  return `${serialized.slice(0, INPUT_OUTPUT_LIMIT - 3)}...`
}

const SYSTEM_PROMPT = `You label a batch of tool calls with one short past-tense summary.

The label lands as a single row in a mobile client and is visually cut off around thirty characters, so aim for the register of a commit subject line, not a sentence.

Lead with a past-tense verb and the most identifying noun. When the line runs long, drop articles, connecting words, and lengthy location detail first.

Examples:
Fixed login redirect loop
Added pagination to search
Renamed helper across repo
Ran test suite, all green`

/** Never throws. */
export async function generateToolUseSummary(
  params: GenerateToolUseSummaryParams,
): Promise<string | null> {
  const { tools, signal, isNonInteractiveSession, lastAssistantText } = params
  if (tools.length === 0) return null

  try {
    const blocks = tools
      .map(
        tool =>
          `<tool name="${tool.name}">\ninput: ${renderValue(tool.input)}\noutput: ${renderValue(tool.output)}\n</tool>`,
      )
      .join('\n')

    let userPrompt = ''
    if (lastAssistantText !== undefined && lastAssistantText !== '') {
      const intent = lastAssistantText.slice(0, INTENT_LIMIT)
      userPrompt += `The user's intent, taken from the assistant's last message: ${intent}\n\n`
    }
    userPrompt += `Summarize what these tool calls accomplished:\n${blocks}\n\nReturn only the label.`

    const result = await querySmallFast({
      systemPrompt: asSystemPrompt([SYSTEM_PROMPT]),
      userPrompt,
      signal,
      options: {
        querySource: 'tool_use_summary_generation',
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: true,
      },
    })

    const text = extractTextContent(result.message.content).trim()
    return text === '' ? null : text
  } catch (error) {
    // cause.errorId is what the error logger reads — an interface fact.
    const normalized = toError(error)
    ;(normalized as { cause?: unknown }).cause = {
      errorId: E_TOOL_USE_SUMMARY_GENERATION_FAILED,
    }
    logError(normalized)
    return null
  }
}
