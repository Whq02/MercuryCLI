import { buildTool, type ToolDef } from '../../Tool.js'
import { jevSystemOne } from '../../services/jev/jevClient.js'
import type { JevStatus } from '../../services/jev/jevContract.js'
import { jevKeyPresence, resolveJevApiKey } from '../../services/jev/jevKey.js'
import { noteJevAttempt, noteJevWireFailure, settleJevCall, takeJevNotice } from '../../services/jev/jevLedger.js'
import { readJevSettings } from '../../services/jev/jevSetting.js'
import { type JevAgentIdentity, jevStatus } from '../../services/jev/jevStatus.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { JEV_EVAL_MAX_RESULT_CHARS, JEV_EVAL_TOOL_NAME } from './constants.js'
import { assembleJevEvalRequest } from './jevEvalRequest.js'
import {
  jevEvalAbortedText,
  jevEvalAnsweredText,
  jevEvalBadRequestText,
  jevEvalFailureText,
  jevEvalRefusedText,
  jevEvalUnavailableText,
} from './jevEvalResult.js'
import { type JevEvalInput, type JevEvalInputSchema, jevEvalInputSchema } from './jevEvalSchema.js'
import { JEV_EVAL_DESCRIPTION, JEV_EVAL_PROMPT, JEV_EVAL_SEARCH_HINT } from './prompt.js'

export interface JevEvalOutput {
  status: string
  text: string
}

export function jevAgentIdentity(): JevAgentIdentity | undefined {
  const context = getAgentContext()
  return context === undefined ? undefined : { id: context.agentId, subagent: true }
}

export function jevEvalEnabled(): boolean {
  const settings = readJevSettings()
  if (!settings.enabled) return false
  if (!jevKeyPresence().present) return false
  return settings.subagents || jevAgentIdentity() === undefined
}

function unavailable(status: JevStatus): JevEvalOutput {
  return { status: status.kind, text: jevEvalUnavailableText(status, takeJevNotice(status.kind)) }
}

export async function jevEvalCall(input: JevEvalInput, signal?: AbortSignal): Promise<JevEvalOutput> {
  const agent = jevAgentIdentity()
  const before = jevStatus(agent, Date.now())
  if (before.kind !== 'ready') return unavailable(before)
  const assembled = assembleJevEvalRequest(input)
  if (!assembled.ok) return { status: 'refused', text: jevEvalRefusedText(assembled.reason) }
  const key = resolveJevApiKey()
  if (key === undefined) return unavailable(jevStatus(agent, Date.now()))
  noteJevAttempt(Date.now(), agent?.id)
  const outcome = await jevSystemOne(assembled.request, key.key, signal ? { signal } : {})
  const now = Date.now()
  if (outcome.ok) {
    const charge = settleJevCall(outcome.response.usage, outcome.response.model, now)
    return { status: 'ok', text: jevEvalAnsweredText(outcome.response, charge, assembled.order) }
  }
  noteJevWireFailure(outcome.failure, now)
  if (outcome.failure.kind === 'bad-request') return { status: 'bad-request', text: jevEvalBadRequestText(outcome.failure) }
  if (outcome.failure.kind === 'aborted') return { status: 'aborted', text: jevEvalAbortedText() }
  const after = jevStatus(agent, now)
  if (after.kind === 'ready') return { status: outcome.failure.kind, text: jevEvalFailureText(outcome.failure) }
  return unavailable(after)
}

export const JevEvalTool = buildTool({
  name: JEV_EVAL_TOOL_NAME,
  searchHint: JEV_EVAL_SEARCH_HINT,
  shouldDefer: false,
  maxResultSizeChars: JEV_EVAL_MAX_RESULT_CHARS,
  capability: {
    intents: [
      'rank hypotheses against the evidence with a second opinion',
      'get a probability on a yes/no judgement',
      'make a qualitative call after the numbers are measured',
      'check a proposal against recorded rulings',
    ],
    units: ['web-access'],
    class: 'observation',
    cancellation: 'cooperative',
    latency: 'interactive',
    conditions: ['the JEV switch on with a TypeSafe API key stored through /jev; a sub-agent only when the sub-agents setting is on'],
    proof: 'scripts/jev/run-all.sh',
  },
  get inputSchema(): JevEvalInputSchema {
    return jevEvalInputSchema()
  },
  isEnabled() {
    return jevEvalEnabled()
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
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return JEV_EVAL_DESCRIPTION
  },
  async prompt() {
    return JEV_EVAL_PROMPT
  },
  userFacingName() {
    return JEV_EVAL_TOOL_NAME
  },
  getActivityDescription(input) {
    return typeof input?.goal === 'string' && input.goal !== '' ? `JevEval: ${input.goal}` : 'JevEval'
  },
  renderToolUseMessage(input) {
    return typeof input?.goal === 'string' ? input.goal : ''
  },
  renderToolResultMessage(output: JevEvalOutput | undefined) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  mapToolResultToToolResultBlockParam(output: JevEvalOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.text,
    }
  },
  async call(input, context) {
    return { data: await jevEvalCall(input, context.abortController.signal) }
  },
} satisfies ToolDef<JevEvalInputSchema, JevEvalOutput>)
