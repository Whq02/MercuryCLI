import { z } from 'zod/v4'

import { getSessionId } from '../../bootstrap/state.js'
import { askAdvisor } from '../../services/advisor/askAdvisor.js'
import { advisorEnabled } from '../../services/advisor/advisorSettings.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ASK_ADVISOR_MAX_RESULT_CHARS, ASK_ADVISOR_SEARCH_HINT, ASK_ADVISOR_TOOL_NAME } from './constants.js'
import { ASK_ADVISOR_DESCRIPTION, ASK_ADVISOR_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    question: z.string().min(1).describe('The one question for the advisor, with the facts it turns on: what you tried, what you saw, what you expected.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export interface AskAdvisorOutput {
  status: 'ok' | 'refused'
  text: string
  model?: string
}

export function askAdvisorAgentId(context: Pick<ToolUseContext, 'agentId'>): string {
  return context.agentId !== undefined && context.agentId !== '' ? String(context.agentId) : String(getSessionId())
}

export function askAdvisorRefusedText(reason: string): string {
  return `The advisor did not answer: ${reason}. Decide with what you have and say so.`
}

export async function askAdvisorCall(question: string, context: ToolUseContext): Promise<AskAdvisorOutput> {
  const result = await askAdvisor(askAdvisorAgentId(context), question, context.messages, { signal: context.abortController.signal })
  if (!result.ok) return { status: 'refused', text: askAdvisorRefusedText(result.reason) }
  return { status: 'ok', text: result.reply, model: result.model }
}

export const AskAdvisorTool = buildTool({
  name: ASK_ADVISOR_TOOL_NAME,
  searchHint: ASK_ADVISOR_SEARCH_HINT,
  shouldDefer: true,
  maxResultSizeChars: ASK_ADVISOR_MAX_RESULT_CHARS,
  capability: {
    intents: [
      'ask a second model for advice when stuck',
      'get another reading of the conversation before committing to a road',
      'check what you may be missing against a model that has read the whole thread',
    ],
    units: ['resource-inspection'],
    class: 'observation',
    cancellation: 'cooperative',
    latency: 'interactive',
    conditions: ['Advisor on in /config with a model pinned in /submodels; the advisor keeps its own memory beside the transcript'],
    proof: 'scripts/advisor/run-all.sh',
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    return advisorEnabled()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isOpenWorld() {
    return true
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return ASK_ADVISOR_DESCRIPTION
  },
  async prompt() {
    return ASK_ADVISOR_PROMPT
  },
  userFacingName() {
    return ASK_ADVISOR_TOOL_NAME
  },
  getActivityDescription(input) {
    return typeof input?.question === 'string' && input.question !== '' ? `Asking the advisor: ${input.question.slice(0, 80)}` : 'Asking the advisor'
  },
  renderToolUseMessage(input) {
    return typeof input?.question === 'string' ? input.question : ''
  },
  renderToolResultMessage(output: AskAdvisorOutput | undefined) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  extractSearchText(output: AskAdvisorOutput) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  mapToolResultToToolResultBlockParam(output: AskAdvisorOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.text,
    }
  },
  async call(input, context: ToolUseContext) {
    return { data: await askAdvisorCall(input.question, context) }
  },
} satisfies ToolDef<InputSchema, AskAdvisorOutput>)
