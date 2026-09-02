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

// ============================================================================
// services/agentStateClassifier.ts — per-turn agent-state classification.
// ----------------------------------------------------------------------------
// Derives a compact {state, tempo, detail, needs} verdict from the tail of an
// agent's latest assistant text, so display surfaces (deck / fleet / frame)
// can show a content-derived "needs-attention" signal that process- and
// session-level derivations cannot see (those know whether a process is
// alive, not whether its last message was a question).
//
// Two tiers:
//   1. The zero-token heuristic (agentStateHeuristic.ts) always runs. It ships
//      on by default; the per-turn trigger gates on agentStateClassifierEnabled
//      (opt out with MERCURY_AGENT_CLASSIFIER=0).
//   2. A small/fast-model refinement behind MERCURY_AGENT_CLASSIFIER_LLM=1,
//      off unless asked for because it spends tokens on every turn. Whatever
//      goes wrong in this tier degrades to the heuristic verdict — the model
//      can only ever sharpen the answer, never replace it with nothing.
// ============================================================================

export {
  type AgentState,
  type AgentTempo,
  type AgentStateVerdict,
  agentStateClassifierEnabled,
  classifyAgentStateHeuristic,
} from './agentStateHeuristic.js'

// How much of the assistant text's tail the model tier reads (chars).
const CLASSIFY_TAIL_CHARS = 2000

const CLASSIFIER_SYSTEM_PROMPT = `You classify the current state of a coding agent from the tail of its latest message. Respond with ONLY a JSON object, no prose, no markdown fences:
{"state":"working|blocked|done|failed","detail":"<=12 word summary of what it is doing or waiting on","needs":"<=12 words, only if state is blocked: what the user must provide"}
- "blocked": the agent asked the user a question or is waiting for input/a decision.
- "failed": the agent hit an error it could not resolve.
- "done": the agent finished the task and is idle.
- "working": the agent is mid-task.`

/** Pull the first {...} span out of a model reply and parse it; null on any
 *  shape failure. Tolerant of prose or fences around the object. */
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

/** Narrow an arbitrary string to the closed AgentState vocabulary. */
function asAgentState(s: string | undefined): AgentState | null {
  return s === 'working' || s === 'blocked' || s === 'done' || s === 'failed'
    ? s
    : null
}

/**
 * Classify the agent's state from its latest assistant text. The zero-token
 * heuristic always runs; when MERCURY_AGENT_CLASSIFIER_LLM=1 AND the heuristic
 * came from its lower-confidence path (not an explicit preclassify marker),
 * the small/fast model refines it. Every failure mode of the model tier —
 * API error, unparseable reply, thrown error — degrades to the heuristic
 * verdict; only a user abort returns null.
 */
export async function classifyAgentState(
  _messages: readonly Message[],
  assistantText: string,
  signal: AbortSignal,
): Promise<AgentStateVerdict | null> {
  const heuristic = classifyAgentStateHeuristic(assistantText)
  if (!heuristic) return null

  const llmEnabled = flagEnv('MERCURY_AGENT_CLASSIFIER_LLM') === '1'
  // A preclassify-sourced verdict is already high-confidence — spending a
  // model call on it would buy nothing.
  if (!llmEnabled || heuristic.source === 'preclassify') {
    return heuristic
  }

  try {
    const tail = assistantText.slice(-CLASSIFY_TAIL_CHARS)
    const query = createUserMessage({
      content: `Latest agent message tail:\n${tail}`,
    })
    // The refine pass rides the SESSION FAMILY's small-fast tier through
    // the routed seam (trust-combo census) — the model id
    // decides the wire, so the opt-in classifier works on every family the
    // session can ride, and every failure mode still degrades to the
    // heuristic verdict.
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

// ---- verdict store, one slot per session (snapshot surfaces read it) -------

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
