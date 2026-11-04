import { jevSystemOne } from '../jev/jevClient.js'
import { JEV_TIMEOUT_MS, type JevChoiceQuestion } from '../jev/jevContract.js'
import { jevKeyPresence, resolveJevApiKey } from '../jev/jevKey.js'
import { noteJevAttempt, noteJevWireFailure, settleJevCall } from '../jev/jevLedger.js'
import { readJevSettings } from '../jev/jevSetting.js'
import { jevStatus } from '../jev/jevStatus.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { type GoalStatement, goalWords } from './goal.js'

export const GOAL_VERDICT_FLOOR = 0.6
export const GOAL_STALL_CHECKS = 3
export const GOAL_CHECK_TIMEOUT_MS = JEV_TIMEOUT_MS + 5_000

export type GoalVerdictKind = 'met' | 'open' | 'ambiguous' | 'unattainable'
export type GoalJudgeRoad = 'jev' | 'claim' | 'compile'

export interface GoalEvidence {
  closing: string
  claimedMet: boolean
  asksOperator: boolean
  toolCalls: number
  verification: { state: string; detail: string } | null
  progress: 'advanced' | 'stalled'
  stalledChecks: number
  checks: number
}

export interface GoalVerdict {
  kind: GoalVerdictKind
  confidence: number
  reason: string
  road: GoalJudgeRoad
}

export type GoalJudge = (goal: GoalStatement, evidence: GoalEvidence, signal?: AbortSignal) => Promise<GoalVerdict | null>

const GOAL_QUESTION: JevChoiceQuestion = {
  type: 'choice',
  instructions:
    '`goal` is the end state a session was asked to reach, with its constraints. `closing` is what the assistant said as its turn ended, `claimed_met` whether it closed on the completion line, `verification` the record of checks run on the working tree, `progress` whether the turn did anything (a tool call, a change to the tree, a new check), `checks` how many turn ends this goal has been judged at. Judge the goal from the evidence, not from the claim alone.',
  criteria: {
    met: 'the evidence shows the end state holds within the constraints',
    open: 'the end state does not hold yet, and the work can go on from here',
    ambiguous: 'the goal admits more than one reading, or names no state the evidence could show, so whether it is met cannot be judged',
    unattainable: "the end state cannot be reached from here without the operator: a contradiction, something outside the session's reach, or turns that change nothing",
  },
}

function jevAgent(): { id: string; subagent: boolean } | undefined {
  const context = getAgentContext()
  return context === undefined ? undefined : { id: context.agentId, subagent: true }
}

export function goalJudgeOpen(): boolean {
  const settings = readJevSettings()
  if (!settings.enabled || !jevKeyPresence(process.env, settings.road).present) return false
  const agent = jevAgent()
  if (agent !== undefined && !settings.subagents) return false
  return jevStatus(agent, Date.now(), settings).kind === 'ready'
}

function verificationWords(evidence: GoalEvidence): string {
  return evidence.verification === null ? 'no verification record' : `${evidence.verification.state} — ${evidence.verification.detail}`
}

function progressWords(evidence: GoalEvidence): string {
  const tools = `${evidence.toolCalls} tool call(s) this turn`
  if (evidence.progress === 'advanced') return `advanced: the tree changed or a check ran since the last judgement (${tools})`
  return `stalled for ${evidence.stalledChecks} check(s): no change to the tree and no new verification record (${tools}; reading alone is not progress)`
}

export const judgeWithJev: GoalJudge = async (goal, evidence, signal) => {
  const settings = readJevSettings()
  const road = settings.road
  const key = resolveJevApiKey(process.env, road)
  if (key === undefined) return null
  const agent = jevAgent()
  const at = Date.now()
  if (jevStatus(agent, at, settings).kind !== 'ready') return null
  noteJevAttempt(at, agent?.id, road)
  const state = {
    goal: goalWords(goal),
    closing: evidence.closing,
    claimed_met: evidence.claimedMet ? 'yes' : 'no',
    verification: verificationWords(evidence),
    progress: progressWords(evidence),
    checks: String(evidence.checks),
  }
  const outcome = await jevSystemOne({ state, questions: { goal: GOAL_QUESTION } }, key.key, { road, ...(signal ? { signal } : {}) })
  const now = Date.now()
  if (!outcome.ok) {
    noteJevWireFailure(outcome.failure, now, Math.random, road)
    logForDebugging(`[mission] Jev gave no verdict — ${outcome.failure.kind}: ${outcome.failure.detail}`)
    return null
  }
  settleJevCall(outcome.response.usage, outcome.response.model, now, road, outcome.requestId)
  const answer = outcome.response.answers.goal
  if (answer?.type !== 'choice') return null
  const p = answer.probabilities[answer.choice] ?? 0
  const kind: GoalVerdictKind = answer.choice === 'met' || answer.choice === 'ambiguous' || answer.choice === 'unattainable' ? answer.choice : 'open'
  const held = p >= GOAL_VERDICT_FLOOR ? kind : 'open'
  return {
    kind: held,
    confidence: p,
    reason: held === kind ? `Jev read the goal as ${kind} (p=${p.toFixed(2)})` : `Jev leaned ${kind} at p=${p.toFixed(2)}, under the ${GOAL_VERDICT_FLOOR} floor, so the goal stays open`,
    road: 'jev',
  }
}

export function judgeByClaim(evidence: GoalEvidence): GoalVerdict {
  if (evidence.claimedMet) {
    return { kind: 'met', confidence: 1, reason: 'the turn closed on the completion line; no judge road is open, so the claim stands', road: 'claim' }
  }
  return { kind: 'open', confidence: 1, reason: 'the turn ended without the completion line', road: 'claim' }
}

export function stalledVerdict(evidence: GoalEvidence): GoalVerdict {
  return {
    kind: 'unattainable',
    confidence: 1,
    reason: `${evidence.stalledChecks} checks in a row changed nothing: no change to the tree and no new verification record (reading alone is not progress)`,
    road: 'claim',
  }
}

export async function judgeGoal(
  goal: GoalStatement,
  evidence: GoalEvidence,
  io: { judge?: GoalJudge | null; signal?: AbortSignal } = {},
): Promise<GoalVerdict> {
  if (evidence.asksOperator) {
    return { kind: 'ambiguous', confidence: 1, reason: 'the turn ended with a question to the operator', road: 'claim' }
  }
  const judge = io.judge === undefined ? (goalJudgeOpen() ? judgeWithJev : null) : io.judge
  let answered: GoalVerdict | null = null
  if (judge !== null) {
    try {
      answered = await judge(goal, evidence, io.signal)
    } catch (error) {
      logForDebugging(`[mission] the goal judge failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (answered !== null && answered.kind !== 'open') return answered
  if (answered === null && evidence.claimedMet) return judgeByClaim(evidence)
  if (evidence.stalledChecks >= GOAL_STALL_CHECKS) return stalledVerdict(evidence)
  return answered ?? judgeByClaim(evidence)
}
