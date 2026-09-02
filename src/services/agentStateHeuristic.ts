import { flagEnv } from '../substrate/flagRegistry.js'


export type AgentState = 'working' | 'blocked' | 'done' | 'failed'
export type AgentTempo = 'active' | 'idle' | 'blocked'

export function agentStateClassifierEnabled(): boolean {
  const v = flagEnv('MERCURY_AGENT_CLASSIFIER')
  if (v === '0') return false
  return v === '1' || true
}

export type AgentStateVerdict = {
  state: AgentState
  tempo: AgentTempo
  detail: string
  needs?: string
  source: 'preclassify' | 'heuristic' | 'llm' | 'apiError'
}

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

export function classifyAgentStateHeuristic(
  text: string,
): AgentStateVerdict | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const last = lastMeaningfulLine(trimmed)
  const tail = trimmed.slice(-600)

  const lastQuestion = /\?\s*$/.test(last) || BLOCKED_RE.test(last)
  const lastDone = DONE_RE.test(last)
  const lastFailed = FAILED_RE.test(last) && !FIXED_RE.test(last)

  if (lastQuestion) return blockedVerdict(last, 'preclassify')
  if (lastDone && !lastFailed) return doneVerdict(last, 'preclassify')
  if (lastFailed) return failedVerdict(last, 'preclassify')

  if (FAILED_RE.test(tail) && !FIXED_RE.test(tail)) return failedVerdict(last || tail, 'heuristic')
  if (BLOCKED_RE.test(tail)) return blockedVerdict(last || tail, 'heuristic')
  if (DONE_RE.test(tail)) return doneVerdict(last || tail, 'heuristic')

  return { state: 'working', tempo: tempoForState('working'), detail: clampDetail(last || tail), source: 'heuristic' }
}
