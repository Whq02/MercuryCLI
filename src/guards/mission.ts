import type { Message } from '../types/message.js'
import {
  conversationIdHere,
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js'
import { logForDebugging } from '../utils/debug.js'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../services/run/continuationLatch.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { compileGoal, goalContract, goalWords, type GoalContract, type GoalStatement } from '../services/mission/goal.js'
import {
  GOAL_CHECK_TIMEOUT_MS,
  judgeGoal,
  type GoalEvidence,
  type GoalJudge,
  type GoalVerdict,
} from '../services/mission/goalJudge.js'
import {
  readMissionCard,
  writeMissionCard,
  type MissionCardState,
} from '../services/mission/missionCard.js'
import { getCwd } from '../utils/cwd.js'
import { verificationSummary } from '../utils/verification/verificationState.js'
import { MISSION_MET_SENTINEL } from '../services/mission/sentinel.js'
import { engageTurnGuard, disengageTurnGuard, type TurnNote } from './guards.js'


export const MISSION_CONDITION_MAX_LENGTH = 4000

const GOAL_CLOSING_CLIP = 4000

export { MISSION_MET_SENTINEL, withoutMissionMetSentinel } from '../services/mission/sentinel.js'

export const MISSION_DIRECTIVE_HEADER = 'A standing goal is now active for this session:'

export interface ActiveMission {
  condition: string
  goal: GoalStatement
  contract: GoalContract
  iterations: number
  stalledChecks: number
  lastReason?: string
  met?: boolean
  needsOperator?: boolean
  asking?: boolean
  verdict?: GoalVerdict
  setAt: number
  hookId: string
  lastSeen: { mutationAt: number | null; evidenceSeq: number | null }
  lastAttempt?: string
}

const CLEAR_WORDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

const missionsBySession = new Map<string, ActiveMission>()

const missionListeners = new Set<() => void>()
let missionVersion = 0

function notifyMissionChange(): void {
  missionVersion += 1
  for (const listener of missionListeners) {
    try {
      listener()
    } catch (e) {
      logForDebugging(`[mission] listener threw (ignored): ${e}`)
    }
  }
}

export function subscribeActiveMission(listener: () => void): () => void {
  missionListeners.add(listener)
  return () => {
    missionListeners.delete(listener)
  }
}

export function getActiveMissionVersion(): number {
  return missionVersion
}

function persistCard(sessionId: string, mission: ActiveMission, state: MissionCardState): void {
  const standing = readMissionCard(sessionId)
  if (standing !== null && standing.state === 'armed' && standing.goal !== mission.condition && Date.parse(standing.setAt) > mission.setAt) {
    logForDebugging(`[mission] the card for session ${sessionId} already names a newer goal; the ${state} state of the older one is not written over it`)
    return
  }
  writeMissionCard({
    schema: 1,
    sessionId,
    goal: mission.condition,
    state,
    nextStep:
      state === 'met' || state === 'cleared'
        ? null
        : (mission.lastReason ??
          `keep working toward the goal; end a turn with the ${MISSION_MET_SENTINEL} line once its end state holds`),
    iterations: mission.iterations,
    setAt: new Date(mission.setAt).toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

export function isMissionClearKeyword(text: string): boolean {
  return CLEAR_WORDS.has(text.trim().toLowerCase())
}

export function getActiveMission(sessionId: string = conversationIdHere()): ActiveMission | undefined {
  return missionsBySession.get(sessionId)
}

function indented(words: string): string {
  return words
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')
}

export function buildMissionDirective(condition: string): string {
  return [
    MISSION_DIRECTIVE_HEADER,
    ``,
    indented(goalWords(compileGoal(condition))),
    ``,
    `Work toward it. At each turn's end the goal check judges the end state`,
    `against the evidence: your closing words, the verification record, what`,
    `the turn changed. When the end state holds, end the turn with a final`,
    `line containing exactly:`,
    ``,
    `    ${MISSION_MET_SENTINEL}`,
    ``,
    `A goal that reads as a progress snapshot (a plan, an in-flight status) is`,
    `met once the work it describes is done. When the goal is ambiguous or`,
    `cannot be reached, end the turn with one question to the operator`,
    `instead; the goal then ends with their answer pending.`,
  ].join('\n')
}

function holdWords(mission: ActiveMission, verdict: GoalVerdict): string {
  return [
    `The goal for this session is not yet met (check ${mission.iterations}): ${mission.goal.endState}`,
    ...(mission.goal.constraints.length > 0 ? [`Constraints: ${mission.goal.constraints.join('; ')}`] : []),
    `The check read it as open: ${verdict.reason}.`,
    `Keep working toward it. When the end state holds (a goal that reads as a progress snapshot is met once the work it describes is done), end the turn with the line ${MISSION_MET_SENTINEL}; when the goal is ambiguous or out of reach, end the turn with one question to the operator instead.`,
  ].join('\n')
}

function askWords(mission: ActiveMission, verdict: GoalVerdict): string {
  return [
    `The goal for this session reads as ${verdict.kind}: ${verdict.reason}.`,
    goalWords(mission.goal),
    `End this turn with one question to the operator — what would settle the goal, or whether to stand it down — and do no more work on it until they answer; the goal ends with that question pending.`,
  ].join('\n')
}

function textOf(m: Message): string {
  if (m.type !== 'user' && m.type !== 'assistant') return ''
  const content = m.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text + '\n'
  }
  return out
}

function endsOnSentinel(text: string): boolean {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line === MISSION_MET_SENTINEL
  }
  return false
}

export function sawMissionMetSentinel(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const text = textOf(m)
    if (m.type === 'assistant' && endsOnSentinel(text)) return true
    if (text.includes(MISSION_DIRECTIVE_HEADER)) break
    if (m.type === 'user') break
  }
  return false
}

function closingText(messages: Message[]): string {
  const loose = messages as ReadonlyArray<Message & { toolUseResult?: unknown }>
  for (let i = loose.length - 1; i >= 0; i--) {
    const m = loose[i]!
    const text = textOf(m).trim()
    if (m.type === 'user' && !m.toolUseResult) break
    if (text.includes(MISSION_DIRECTIVE_HEADER)) break
    if (m.type !== 'assistant' || text === '') continue
    return text.length > GOAL_CLOSING_CLIP ? text.slice(-GOAL_CLOSING_CLIP) : text
  }
  return ''
}

function closingQuestion(closing: string): string {
  const lines = closing.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines[lines.length - 1] ?? closing
}

export function closingAsksOperator(closing: string): boolean {
  return /[?？]['"”’)*_~\]]*\s*$/.test(closingQuestion(closing))
}

function toolCallsThisTurn(messages: Message[]): number {
  const loose = messages as ReadonlyArray<{ type?: string; toolUseResult?: unknown; message?: { content?: unknown } }>
  let count = 0
  for (let i = loose.length - 1; i >= 0; i--) {
    const m = loose[i]!
    if (m.type === 'user' && !m.toolUseResult) break
    if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
    for (const block of m.message.content as Array<{ type?: string }>) if (block?.type === 'tool_use') count += 1
  }
  return count
}

function readSeen(): { verification: GoalEvidence['verification']; seen: ActiveMission['lastSeen'] } {
  try {
    const summary = verificationSummary(getCwd(), { skipDigest: true })
    return {
      verification: { state: summary.state, detail: summary.detail },
      seen: { mutationAt: summary.lastMutationAt, evidenceSeq: summary.lastEvidence?.seq ?? null },
    }
  } catch (error) {
    logForDebugging(`[mission] the verification record could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return { verification: null, seen: { mutationAt: null, evidenceSeq: null } }
  }
}

function gatherGoalEvidence(messages: Message[], mission: ActiveMission): GoalEvidence {
  const closing = closingText(messages)
  const claimedMet = sawMissionMetSentinel(messages)
  const toolCalls = toolCallsThisTurn(messages)
  const { verification, seen } = readSeen()
  const attempt = `${turnBoundaryIndex(messages)}:${messages.length}`
  if (mission.lastAttempt !== attempt) {
    const moved = seen.mutationAt !== mission.lastSeen.mutationAt || seen.evidenceSeq !== mission.lastSeen.evidenceSeq
    mission.lastSeen = seen
    mission.lastAttempt = attempt
    mission.stalledChecks = moved ? 0 : mission.stalledChecks + 1
  }
  return {
    closing,
    claimedMet,
    asksOperator: !claimedMet && closingAsksOperator(closing),
    toolCalls,
    verification,
    progress: mission.stalledChecks === 0 ? 'advanced' : 'stalled',
    stalledChecks: mission.stalledChecks,
    checks: mission.iterations,
  }
}

function settleNeedsOperator(sessionId: string, mission: ActiveMission, question: string): void {
  mission.needsOperator = true
  mission.asking = false
  mission.lastReason = `needs the operator — ${question}`
  persistCard(sessionId, mission, 'needs-operator')
  logForDebugging(`[mission] the goal for session ${sessionId} ends with a question to the operator: ${question}`)
  notifyMissionChange()
}

function needsOperatorNote(mission: ActiveMission): TurnNote {
  return { level: 'warning', text: `goal ${mission.lastReason ?? 'needs the operator'}. Answer it, or set the goal again with /goal.` }
}

let armedAtLanding: { sessionId: string } | null = null
let seatWatch: (() => void) | null = null

function dropSeatWatch(): void {
  armedAtLanding = null
  if (seatWatch !== null) {
    seatWatch()
    seatWatch = null
  }
}

function followSeatAtAdmission(): void {
  const pending = armedAtLanding
  if (pending === null) return
  if (!hasFocusedSession()) {
    if (!landingInFlight()) dropSeatWatch()
    return
  }
  const hostedId = getFocusedSessionConnector().sessionId()
  if (hostedId === '' || hostedId === pending.sessionId) return
  dropSeatWatch()
  const prior = missionsBySession.get(pending.sessionId)
  if (prior === undefined) return
  disengageTurnGuard(pending.sessionId, prior.hookId)
  missionsBySession.delete(pending.sessionId)
  setActiveMission(prior.condition, { sessionId: hostedId })
  const moved = missionsBySession.get(hostedId)
  if (moved !== undefined) {
    moved.iterations = prior.iterations
    moved.lastReason = `armed while the chat was landing; follows the seat ${hostedId}`
    persistCard(hostedId, moved, 'armed')
  }
  const card = readMissionCard(pending.sessionId)
  if (card !== null && card.state === 'armed') {
    writeMissionCard({
      ...card,
      state: 'continued',
      nextStep: `continued in session ${hostedId}`,
      updatedAt: new Date().toISOString(),
    })
  }
  logForDebugging(`[mission] the mission armed while the chat was landing follows the seat (${pending.sessionId} → ${hostedId})`)
  notifyMissionChange()
}

export function setActiveMission(
  condition: string,
  options?: { sessionId?: string; judge?: GoalJudge | null },
): string {
  const sessionId = options?.sessionId ?? conversationIdHere()

  const prior = missionsBySession.get(sessionId)
  if (prior) {
    disengageTurnGuard(sessionId, prior.hookId)
    missionsBySession.delete(sessionId)
  }

  const setAt = Date.now()
  const contract = goalContract(condition)
  const record: ActiveMission = {
    condition,
    goal: compileGoal(condition),
    contract,
    iterations: 0,
    stalledChecks: 0,
    setAt,
    hookId: '',
    lastSeen: readSeen().seen,
    ...(contract.feasibility === 'already-met' ? { met: true, lastReason: `already met at compile: ${contract.evidence}` } : {}),
  }

  const hookId = `mission-${sessionId}-${setAt}`
  engageTurnGuard(sessionId, {
    id: hookId,
    timeoutMs: GOAL_CHECK_TIMEOUT_MS,
    judge: async ({ messages }, signal) => {
      const mission = missionsBySession.get(sessionId)
      if (!mission || mission.condition !== condition) return { hold: false }
      if (mission.met || mission.needsOperator) return { hold: false }
      const evidence = gatherGoalEvidence(messages, mission)
      if (mission.asking) {
        settleNeedsOperator(sessionId, mission, evidence.asksOperator ? closingQuestion(evidence.closing) : (mission.verdict?.reason ?? 'the goal needs the operator'))
        return { hold: false, note: needsOperatorNote(mission) }
      }
      const verdict: GoalVerdict =
        mission.contract.feasibility === 'unattainable-now'
          ? { kind: 'unattainable', confidence: 1, reason: mission.contract.evidence ?? 'the goal cannot be reached as stated', road: 'compile' }
          : await judgeGoal(mission.goal, evidence, { ...(options?.judge === undefined ? {} : { judge: options.judge }), signal })
      mission.verdict = verdict
      if (verdict.kind === 'met') {
        mission.met = true
        mission.lastReason = `met — ${verdict.reason}`
        persistCard(sessionId, mission, 'met')
        notifyMissionChange()
        return { hold: false, note: { level: 'suggestion', text: `goal met — ${verdict.reason}. The standing goal ends here; /goal <words> starts another.` } }
      }
      if (evidence.asksOperator) {
        settleNeedsOperator(sessionId, mission, closingQuestion(evidence.closing))
        return { hold: false, note: needsOperatorNote(mission) }
      }
      const claimed = claimContinuation(
        processMainOwner(),
        turnBoundaryIndex(messages),
        messages.length,
      )
      if (!claimed) {
        mission.lastReason = 'another hook claimed this stop attempt — the goal defers one round'
        persistCard(sessionId, mission, 'armed')
        return { hold: false }
      }
      mission.iterations += 1
      if (verdict.kind === 'open') {
        mission.lastReason = `Goal not yet met (check ${mission.iterations}) — ${verdict.reason}`
        persistCard(sessionId, mission, 'armed')
        return { hold: true, words: holdWords(mission, verdict) }
      }
      mission.asking = true
      mission.lastReason = `${verdict.kind} — ${verdict.reason}; asking the operator`
      persistCard(sessionId, mission, 'armed')
      return { hold: true, words: askWords(mission, verdict), note: { level: 'warning', text: `goal reads as ${verdict.kind} — ${verdict.reason}. It ends with one question to you; answer it, or set the goal again with /goal.` } }
    },
  })

  record.hookId = hookId
  missionsBySession.set(sessionId, record)
  persistCard(sessionId, record, record.met ? 'met' : 'armed')
  logForDebugging(`[mission] installed standing mission for session ${sessionId}`)
  notifyMissionChange()
  if (options?.sessionId === undefined && landingInFlight() && !hasFocusedSession()) {
    armedAtLanding = { sessionId }
    if (seatWatch === null) seatWatch = subscribeFocusedSessionConnector(followSeatAtAdmission)
  }
  return buildMissionDirective(condition)
}

export function clearActiveMission(
  sessionId: string = conversationIdHere(),
): string | null {
  const mission = missionsBySession.get(sessionId)
  if (!mission) return null
  if (armedAtLanding?.sessionId === sessionId) dropSeatWatch()
  disengageTurnGuard(sessionId, mission.hookId)
  missionsBySession.delete(sessionId)
  persistCard(sessionId, mission, 'cleared')
  logForDebugging(`[mission] cleared standing mission for session ${sessionId}`)
  notifyMissionChange()
  return mission.condition
}

export function syncMissionFromCard(sessionId: string): void {
  const card = readMissionCard(sessionId)
  const live = missionsBySession.get(sessionId)
  if (card?.state === 'armed') {
    if (live !== undefined && (live.condition !== card.goal || live.met === true || live.needsOperator === true)) {
      disengageTurnGuard(sessionId, live.hookId)
      missionsBySession.delete(sessionId)
      logForDebugging(`[mission] the armed card names a new goal for session ${sessionId}; the settled one is released`)
    }
    if (!missionsBySession.has(sessionId)) rearmMissionFromCard({ cardSessionId: sessionId, armSessionId: sessionId })
    return
  }
  if (live !== undefined && card !== null) {
    disengageTurnGuard(sessionId, live.hookId)
    missionsBySession.delete(sessionId)
    logForDebugging(`[mission] released the standing mission for session ${sessionId} (the card reads ${card.state})`)
    notifyMissionChange()
  }
}

export function rearmMissionFromCard(
  target: string | { cardSessionId?: string; armSessionId?: string } = {},
): boolean {
  const normalized = typeof target === 'string' ? { cardSessionId: target, armSessionId: target } : target
  const cardSessionId = normalized.cardSessionId ?? conversationIdHere()
  const armSessionId = normalized.armSessionId ?? conversationIdHere()
  if (missionsBySession.has(armSessionId)) return false
  const card = readMissionCard(cardSessionId)
  if (!card || card.state !== 'armed') return false
  setActiveMission(card.goal, { sessionId: armSessionId })
  const mission = missionsBySession.get(armSessionId)
  if (mission) {
    const armedAt = Date.parse(card.setAt)
    if (Number.isFinite(armedAt)) mission.setAt = armedAt
    mission.lastReason = `re-armed on resume (the previous run closed at check ${card.iterations})`
    persistCard(armSessionId, mission, 'armed')
  }
  if (cardSessionId !== armSessionId) {
    writeMissionCard({
      ...card,
      state: 'continued',
      nextStep: `continued in session ${armSessionId}`,
      updatedAt: new Date().toISOString(),
    })
  }
  logForDebugging(
    `[mission] re-armed from card (card session ${cardSessionId} → live session ${armSessionId})`,
  )
  return true
}
