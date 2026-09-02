import { flagEnv } from '../substrate/flagRegistry.js'
// ============================================================================
// services/agentStateHeuristic.ts — the pure, zero-token classification core
// for the per-turn agent-state classifier. Kept import-light (no model/SDK
// deps) so it is independently testable and so the heuristic tier never pulls
// in the query stack.
// ============================================================================


export type AgentState = 'working' | 'blocked' | 'done' | 'failed'
export type AgentTempo = 'active' | 'idle' | 'blocked'

/**
 * Whether the per-turn agent-state classifier is enabled.
 *
 * WIRED LIVE for Mercury: the zero-token heuristic tier ships ON
 * for the Mercury build — opt out `MERCURY_AGENT_CLASSIFIER=0`. An explicit `=1`
 * also enables it. The fast-model refinement tier stays
 * SEPARATELY opt-in (`MERCURY_AGENT_CLASSIFIER_LLM` — it has per-turn token cost).
 * One source of truth for the producer hook and the snapshot reader; lives in
 * this import-light module so it is testable without the query stack.
 */
export function agentStateClassifierEnabled(): boolean {
  const v = flagEnv('MERCURY_AGENT_CLASSIFIER')
  if (v === '0') return false
  return v === '1' || true
}

export type AgentStateVerdict = {
  state: AgentState
  tempo: AgentTempo
  /** Short (≤120 char) human line — what the agent is doing / waiting on. */
  detail: string
  /** When blocked: a short note on what's needed from the user. */
  needs?: string
  source: 'preclassify' | 'heuristic' | 'llm' | 'apiError'
}

// state → tempo. done is idle (ok, waiting); blocked/failed need attention.
export function tempoForState(state: AgentState): AgentTempo {
  switch (state) {
    case 'working':
      return 'active'
    case 'blocked':
    case 'failed':
      return 'blocked'
    case 'done':
      return 'idle'
  }
}

export function clampDetail(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine
}

/** Last non-empty line of the text, for the detail line. */
function lastMeaningfulLine(text: string): string {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  return lines.length ? lines[lines.length - 1]! : ''
}

const FAILED_RE =
  /\b(error|exception|traceback|failed to|couldn't|could not|cannot|can't|unable to|i'm sorry|i was unable|ran into|blocked by an error)\b/i
const BLOCKED_RE =
  /(\?\s*$)|\b(let me know|which (one|would|do)|should i|do you want|would you like|please (confirm|clarify|provide|let me know)|waiting for|could you|can you (confirm|clarify|provide)|need(s)? your|awaiting)\b/i
const DONE_RE =
  /\b(done|completed|finished|all set|all done|that's (it|done)|here'?s the|i'?ve (added|created|fixed|updated|implemented|completed|finished|done)|successfully)\b/i
// Fix-language NEGATES an error word: "fixed the error", "resolved the exception",
// "the test no longer fails" are NOT failures. Guards the most common false-positive.
const FIXED_RE =
  /\b(fixed|resolved|corrected|repaired|patched|no longer|now (works|passes|passing)|sorted out)\b/i

function failedVerdict(detail: string, source: AgentStateVerdict['source']): AgentStateVerdict {
  return { state: 'failed', tempo: tempoForState('failed'), detail: clampDetail(detail), needs: 'review the error and decide how to proceed', source }
}
function blockedVerdict(detail: string, source: AgentStateVerdict['source']): AgentStateVerdict {
  return { state: 'blocked', tempo: tempoForState('blocked'), detail: clampDetail(detail), needs: 'answer the question / provide input', source }
}
function doneVerdict(detail: string, source: AgentStateVerdict['source']): AgentStateVerdict {
  return { state: 'done', tempo: tempoForState('done'), detail: clampDetail(detail), source }
}

/**
 * Zero-token classification of the agent's state from the latest assistant text.
 *
 * RECENCY-WEIGHTED: the LAST meaningful line is the operative signal, checked
 * before the 600-char closing window. This fixes two verified false-positives the
 * old first-match-anywhere precedence produced:
 *   - "Fixed the error. All tests pass. Done." → done (was failed: "error" anywhere)
 *   - "I could not find the file. Which path should I use?" → blocked (was failed)
 * A fix-language negation guard (FIXED_RE) stops "fixed the error" tripping the
 * failure check. Returns null only for empty text.
 *  - preclassify: a decisive signal in the LAST line (high confidence).
 *  - heuristic: a weaker pattern match across the closing window (fallback).
 */
export function classifyAgentStateHeuristic(
  text: string,
): AgentStateVerdict | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const last = lastMeaningfulLine(trimmed)
  const tail = trimmed.slice(-600)

  // last-line signals (recency wins). A failure word negated by fix-language is
  // not a failure ("fixed the error").
  const lastQuestion = /\?\s*$/.test(last) || BLOCKED_RE.test(last)
  const lastDone = DONE_RE.test(last)
  const lastFailed = FAILED_RE.test(last) && !FIXED_RE.test(last)

  // 1) A trailing question / explicit ask is the strongest end-of-turn signal —
  //    it wins even over an earlier error word (the ask is what needs answering).
  if (lastQuestion) return blockedVerdict(last, 'preclassify')
  // 2) The last line declares done and is not itself a failure report → done,
  //    even if an error word appears earlier in the turn ("fixed the error … done").
  if (lastDone && !lastFailed) return doneVerdict(last, 'preclassify')
  // 3) The last line reports a genuine (non-fixed) failure → failed.
  if (lastFailed) return failedVerdict(last, 'preclassify')

  // 4) Fallback to the closing window when the last line was inconclusive. A
  //    non-negated failure in the window outweighs a blocked/done further back.
  if (FAILED_RE.test(tail) && !FIXED_RE.test(tail)) return failedVerdict(last || tail, 'heuristic')
  if (BLOCKED_RE.test(tail)) return blockedVerdict(last || tail, 'heuristic')
  if (DONE_RE.test(tail)) return doneVerdict(last || tail, 'heuristic')

  // 5) The agent produced text but isn't clearly done/blocked/failed.
  return { state: 'working', tempo: tempoForState('working'), detail: clampDetail(last || tail), source: 'heuristic' }
}
