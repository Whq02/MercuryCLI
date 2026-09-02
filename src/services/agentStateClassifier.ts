import { APIUserAbortError } from './api/sdkErrors.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from '../utils/messages.js'
import { sessionSmallFastModel } from '../utils/model/providerFrontier.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import {
  type AgentState,
  type AgentStateVerdict,
  classifyAgentStateHeuristic,
  clampDetail,
  tempoForState,
} from './agentStateHeuristic.js'
import { routedCallModelSettled } from './providers/callModelRouter.js'


export {
  type AgentState,
  type AgentTempo,
  type AgentStateVerdict,
  agentStateClassifierEnabled,
  classifyAgentStateHeuristic,
} from './agentStateHeuristic.js'

const CLASSIFY_TAIL_CHARS = 2000

const CLASSIFIER_SYSTEM_PROMPT = `You classify the current state of a coding agent from the tail of its latest message. Respond with ONLY a JSON object, no prose, no markdown fences:
{"state":"working|blocked|done|failed","detail":"<=12 word summary of what it is doing or waiting on","needs":"<=12 words, only if state is blocked: what the user must provide"}
- "blocked": the agent asked the user a question or is waiting for input/a decision.
- "failed": the agent hit an error it could not resolve.
- "done": the agent finished the task and is idle.
- "working": the agent is mid-task.`

function extractVerdictJson(raw: string): {
  state?: string
  detail?: string
  needs?: string
} | null {
  try {
    const open = raw.indexOf('{')
    const close = raw.lastIndexOf('}')
    if (open === -1 || close === -1 || close < open) return null
    const parsed = JSON.parse(raw.slice(open, close + 1))
    return typeof parsed === 'object' && parsed ? parsed : null
  } catch {
    return null
  }
}

function asAgentState(s: string | undefined): AgentState | null {
  return s === 'working' || s === 'blocked' || s === 'done' || s === 'failed'
    ? s
    : null
}

export async function classifyAgentState(
  _messages: readonly Message[],
  assistantText: string,
  signal: AbortSignal,
): Promise<AgentStateVerdict | null> {
  const heuristic = classifyAgentStateHeuristic(assistantText)
  if (!heuristic) return null

  const llmEnabled = flagEnv('MERCURY_AGENT_CLASSIFIER_LLM') === '1'
  if (!llmEnabled || heuristic.source === 'preclassify') {
    return heuristic
  }

  try {
    const tail = assistantText.slice(-CLASSIFY_TAIL_CHARS)
    const query = createUserMessage({
      content: `Latest agent message tail:\n${tail}`,
    })
    const response = await routedCallModelSettled({
      messages: [query],
      systemPrompt: asSystemPrompt([CLASSIFIER_SYSTEM_PROMPT]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: sessionSmallFastModel(),
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'agent_classifier',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      return { ...heuristic, source: 'apiError' }
    }

    const parsed = extractVerdictJson(getAssistantMessageText(response) ?? '')
    const state = asAgentState(parsed?.state)
    if (!parsed || !state) return heuristic

    const refined: AgentStateVerdict = {
      state,
      tempo: tempoForState(state),
      detail: parsed.detail ? clampDetail(parsed.detail) : heuristic.detail,
      needs:
        state === 'blocked'
          ? clampDetail(parsed.needs || heuristic.needs || '')
          : undefined,
      source: 'llm',
    }
    return refined
  } catch (err) {
    if (err instanceof APIUserAbortError || signal.aborted) return null
    logForDebugging(`[agentStateClassifier] classification failed: ${err}`)
    return heuristic
  }
}


const verdictBySession = new Map<string, { verdict: AgentStateVerdict; at: number }>()

export function recordAgentStateVerdict(
  sessionId: string,
  verdict: AgentStateVerdict,
): void {
  verdictBySession.set(sessionId, { verdict, at: Date.now() })
}

export function getAgentStateVerdict(
  sessionId: string,
): { verdict: AgentStateVerdict; at: number } | null {
  return verdictBySession.get(sessionId) ?? null
}

export function clearAgentStateVerdict(sessionId: string): void {
  verdictBySession.delete(sessionId)
}
