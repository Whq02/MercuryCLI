import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { jevSystemOne } from '../jev/jevClient.js'
import { JEV_TIMEOUT_MS, type JevChoiceQuestion } from '../jev/jevContract.js'
import { jevKeyPresence, resolveJevApiKey } from '../jev/jevKey.js'
import { noteJevAttempt, noteJevWireFailure, settleJevCall } from '../jev/jevLedger.js'
import { readJevSettings } from '../jev/jevSetting.js'
import { jevStatus } from '../jev/jevStatus.js'
import { routedCallModelSettled } from '../providers/callModelRouter.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { hasFirstPartyCredential } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { getEngineModel } from '../../utils/model/model.js'
import { utilityCallFor } from '../../utils/model/utilityModel.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { goalCriteria, goalWords, type GoalStatement } from './goal.js'
import { MISSION_MET_SENTINEL } from './sentinel.js'

export const GOAL_VERDICT_FLOOR = 0.6
export const MISSION_JUDGE_TIMEOUT_MS = 20_000
export const GOAL_CHECK_TIMEOUT_MS = MISSION_JUDGE_TIMEOUT_MS + JEV_TIMEOUT_MS + 5_000
export const MISSION_JUDGE_MARK = "You judge whether a session's standing mission is met"
const CLOSING_CLIP = 4000

export type GoalVerdictKind = 'met' | 'not yet' | 'impossible'
export type GoalJudgeRoad = 'model' | 'jev' | 'claim'
export const JUDGE_UNREADABLE = 'the judge gave no readable verdict'
export const JUDGE_UNREACHABLE = 'the judge could not be reached'

export interface GoalEvidence {
  closing: string
  claimedMet: boolean
  claimDefect?: string
  asksOperator: boolean
  toolCalls: number
  toolNames: string[]
  verification: { state: string; detail: string } | null
  checks: number
}

export function toolTally(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(', ')
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
    '`goal` is the end state a session was asked to reach, with its constraints. `closing` is what the assistant said as its turn ended, `claimed_met` whether it closed on the itemised completion (one line per criterion naming its evidence, then the completion line), `verification` the record of checks run on the working tree, `tools` the tool calls the turn made, `checks` how many turn ends this goal has been judged at. Judge the goal from the evidence, not from the claim alone.',
  criteria: {
    met: 'the evidence shows the end state holds within the constraints',
    open: 'the end state does not hold yet, and the work can go on from here',
    ambiguous: 'the goal admits more than one reading, or names no state the evidence could show, so whether it is met cannot be judged',
    unattainable: "the end state cannot be reached from here without the operator: a contradiction, or something outside the session's reach",
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

function toolWords(evidence: GoalEvidence): string {
  if (evidence.toolCalls === 0) return 'no tool call this turn'
  return `${evidence.toolCalls} tool call(s) this turn: ${toolTally(evidence.toolNames)}`
}

function clippedClosing(evidence: GoalEvidence): string {
  const closing = evidence.closing.trim()
  if (closing === '') return '(the turn ended without closing words)'
  return closing.length > CLOSING_CLIP ? closing.slice(-CLOSING_CLIP) : closing
}

export function judgePrompt(goal: GoalStatement, evidence: GoalEvidence): { system: string; user: string } {
  const criteria = goalCriteria(goal)
  return {
    system: [
      `${MISSION_JUDGE_MARK} from the evidence of one turn. Answer with one line of JSON and nothing else: {"verdict":"met"|"not yet"|"impossible","reason":"<one line>"}.`,
      `met: every criterion holds and the closing lines itemise the evidence for each, one numbered line per criterion, then the line ${MISSION_MET_SENTINEL}. impossible: the end state cannot be reached from here without the operator. Otherwise: not yet.`,
    ].join('\n'),
    user: [
      goalWords(goal),
      'Criteria:',
      ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
      '',
      `Closing words of the turn:`,
      clippedClosing(evidence),
      '',
      `Tools: ${toolWords(evidence)}`,
      `Verification record: ${verificationWords(evidence)}`,
      `Turn ends judged so far: ${evidence.checks}`,
      `Closing itemised as required: ${evidence.claimedMet ? 'yes' : `no (${evidence.claimDefect ?? 'no completion line'})`}`,
    ].join('\n'),
  }
}

export function readJudgeAnswer(text: string): { kind: GoalVerdictKind; reason: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const verdict = (parsed as { verdict?: unknown }).verdict
  const reason = (parsed as { reason?: unknown }).reason
  if (verdict !== 'met' && verdict !== 'not yet' && verdict !== 'impossible') return null
  if (typeof reason !== 'string' || reason.trim() === '' || reason.includes('\n')) return null
  return { kind: verdict, reason: reason.trim() }
}

export function verdictOfAnswer(text: string): GoalVerdict {
  const answer = readJudgeAnswer(text)
  if (answer === null) return { kind: 'not yet', confidence: 0, reason: JUDGE_UNREADABLE, road: 'model' }
  return { kind: answer.kind, confidence: 1, reason: answer.reason, road: 'model' }
}

export function modelRoadOpen(model: string): boolean {
  const route = declaredRouteOf(model)
  return route !== null && route !== 'anthropic' ? true : hasFirstPartyCredential()
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

export const judgeWithModel: GoalJudge = async (goal, evidence, signal) => {
  const call = utilityCallFor(getEngineModel(), { named: true })
  if (!modelRoadOpen(call.model)) return null
  const prompt = judgePrompt(goal, evidence)
  const combined = createCombinedAbortSignal(signal, { timeoutMs: MISSION_JUDGE_TIMEOUT_MS })
  try {
    const settled = await routedCallModelSettled({
      messages: [createUserMessage({ content: prompt.user })],
      systemPrompt: asSystemPrompt([prompt.system]),
      thinkingConfig: call.thinkingConfig,
      tools: [],
      signal: combined.signal,
      options: {
        model: call.model,
        ...(call.effortValue !== undefined ? { effortValue: call.effortValue } : {}),
        effortPinned: call.effortPinned,
        querySource: 'side_question',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
        skipCacheWrite: true,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      },
    })
    if (settled.isApiErrorMessage === true) {
      logForDebugging(`[mission] the judge call failed: ${assistantText(settled.message.content).slice(0, 200)}`)
      return { kind: 'not yet', confidence: 0, reason: JUDGE_UNREACHABLE, road: 'model' }
    }
    return verdictOfAnswer(assistantText(settled.message.content))
  } catch (error) {
    logForDebugging(`[mission] the judge call threw: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: 'not yet', confidence: 0, reason: JUDGE_UNREACHABLE, road: 'model' }
  } finally {
    combined.cleanup()
  }
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
    tools: toolWords(evidence),
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
  const choice = answer.choice === 'met' || answer.choice === 'ambiguous' || answer.choice === 'unattainable' ? answer.choice : 'open'
  const held = p >= GOAL_VERDICT_FLOOR ? choice : 'open'
  const kind: GoalVerdictKind = held === 'met' ? 'met' : held === 'open' ? 'not yet' : 'impossible'
  return {
    kind,
    confidence: p,
    reason: held === choice ? `Jev read the goal as ${choice} (p=${p.toFixed(2)})` : `Jev leaned ${choice} at p=${p.toFixed(2)}, under the ${GOAL_VERDICT_FLOOR} floor, so the goal stays open`,
    road: 'jev',
  }
}

export function judgeByClaim(evidence: GoalEvidence): GoalVerdict {
  if (evidence.claimedMet) {
    return { kind: 'met', confidence: 1, reason: 'the turn closed on the itemised completion; no judge could be called, so the claim is the verification', road: 'claim' }
  }
  return { kind: 'not yet', confidence: 1, reason: evidence.claimDefect ?? 'the turn ended without the completion line', road: 'claim' }
}

let helperForTesting: GoalJudge | null | undefined

export function _setMissionJudgeForTesting(judge: GoalJudge | null | undefined): void {
  helperForTesting = judge
}

export async function judgeGoal(
  goal: GoalStatement,
  evidence: GoalEvidence,
  io: { judge?: GoalJudge | null; signal?: AbortSignal } = {},
): Promise<GoalVerdict> {
  const helper = io.judge !== undefined ? io.judge : helperForTesting !== undefined ? helperForTesting : judgeWithModel
  let answered: GoalVerdict | null = null
  if (helper !== null) {
    try {
      answered = await helper(goal, evidence, io.signal)
    } catch (error) {
      logForDebugging(`[mission] the goal judge failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (goalJudgeOpen()) {
    try {
      const jev = await judgeWithJev(goal, evidence, io.signal)
      if (jev !== null) answered = jev
    } catch (error) {
      logForDebugging(`[mission] Jev failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const verdict = answered ?? judgeByClaim(evidence)
  if (verdict.kind === 'met' && !evidence.claimedMet) {
    return { kind: 'not yet', confidence: verdict.confidence, reason: `${evidence.claimDefect ?? 'the turn ended without the completion line'}; the judge read the goal as met, but the itemised close is the prerequisite`, road: verdict.road }
  }
  return verdict
}
