import { z } from 'zod/v4'

import { getSessionId } from '../../bootstrap/state.js'
import { askAdvisor } from '../../services/advisor/askAdvisor.js'
import { advisorEnabled } from '../../services/advisor/advisorSettings.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ASK_ADVISOR_MAX_RESULT_CHARS, ASK_ADVISOR_SEARCH_HINT, ASK_ADVISOR_TOOL_NAME } from './constants.js'
import { ASK_ADVISOR_DESCRIPTION, ASK_ADVISOR_PROMPT } from './prompt.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    question: z.string().min(1).describe('The one question for the advisor, with the facts it turns on: what you tried, what you saw, what you expected.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

interface AskAdvisorOutput {
  status: 'ok' | 'refused'
  text: string
  model?: string
}

export function askAdvisorAgentId(context: Pick<ToolUseContext, 'agentId'>): string {
  return context.agentId !== undefined && context.agentId !== '' ? String(context.agentId) : String(getSessionId())
}

function askAdvisorRefusedText(reason: string): string {
  return `The advisor did not answer: ${reason}. Decide with what you have and say so.`
}

async function askAdvisorCall(question: string, context: ToolUseContext): Promise<AskAdvisorOutput> {
  const seat = context.agentKind ?? (context.agentId ? 'crewmate' : 'main')
  const result = await askAdvisor(askAdvisorAgentId(context), question, context.messages, { seat, signal: context.abortController.signal })
  if (!result.ok) return { status: 'refused', text: askAdvisorRefusedText(result.reason) }
  return { status: 'ok', text: result.reply, model: result.model }
}

export const AskAdvisorTool: Unbuilt = unbuilt('src/tools/AskAdvisorTool/AskAdvisorTool.ts:39')
