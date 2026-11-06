import { createHash } from 'node:crypto'
import type { Message } from '../types/message.js'
import {
  conversationIdHere,
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js'
import { enqueuePendingNotification } from '../input-core/command-queue.js'
import { logForDebugging } from '../utils/debug.js'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../services/run/continuationLatch.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { declareLawfulPrefixChange } from '../services/providers/lawfulPrefixChange.js'
import { compileGoal, goalWords, readItemisedClose, type GoalStatement } from '../services/mission/goal.js'
import {
  GOAL_CHECK_TIMEOUT_MS,
  judgeGoal,
  type GoalEvidence,
  type GoalJudge,
  type GoalVerdict,
} from '../services/mission/goalJudge.js'
import {
  missionCardStands,
  readMissionCard,
  writeMissionCard,
  type MissionCard,
  type MissionCardState,
  type MissionOutcome,
} from '../services/mission/missionCard.js'
import { MISSION_HOLD_HEAD, missionStatusLine, type ServedMission } from '../services/mission/served.js'
import { getCwd } from '../utils/cwd.js'
import { formatDuration } from '../utils/format.js'
import { plural } from '../utils/stringUtils.js'
import { verificationSummary } from '../utils/verification/verificationState.js'
import { escapeXml } from '../utils/xml.js'
import { MISSION_MET_SENTINEL } from '../services/mission/sentinel.js'
import { engageTurnGuard, disengageTurnGuard, type TurnNote } from './guards.js'


export const MISSION_CONDITION_MAX_LENGTH = 4000
export const MISSION_IDLE_TURNS = 3

const GOAL_CLOSING_CLIP = 4000

export { MISSION_MET_SENTINEL, withoutMissionMetSentinel } from '../services/mission/sentinel.js'
export { MISSION_HOLD_HEAD, MISSION_SECTION_HEADING, MISSION_STATUS_HEAD, missionSection, missionSectionKey, missionStatusLine } from '../services/mission/served.js'

export const MISSION_DIRECTIVE_HEADER = 'A standing goal is now active for this session:'
export const MISSION_COMPLETED_HEAD = 'Mission completed:'

export interface MissionPause {
  why: string
  boundary: string | null
}

export interface ActiveMission {
  condition: string
  goal: GoalStatement
  iterations: number
  idleTurns: number
  lastReason?: string
  met?: boolean
  closed?: 'met' | 'cleared'
  outcome?: MissionOutcome
  paused?: MissionPause
  verdict?: GoalVerdict
  setAt: number
  hookId: string
}

export type MissionCardView = Pick<MissionCard, 'goal' | 'state' | 'nextStep' | 'iterations' | 'setAt' | 'updatedAt'> & { outcome?: MissionOutcome }

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

function cardStateOf(mission: ActiveMission): MissionCardState {
  return mission.met ? 'met' : mission.paused !== undefined ? 'paused' : 'armed'
}

const cardMemo = new Map<string, MissionCard | null>()

function readCard(sessionId: string): MissionCard | null {
  const card = readMissionCard(sessionId)
  cardMemo.set(sessionId, card)
  return card
}

function writeCard(card: MissionCard): void {
  writeMissionCard(card)
  cardMemo.set(card.sessionId, card)
}

function persistCard(sessionId: string, mission: ActiveMission, state: MissionCardState): void {
  const standing = readCard(sessionId)
  const setAt = new Date(mission.setAt).toISOString()
  if (standing !== null && missionCardStands(standing.state) && Date.parse(standing.setAt) > mission.setAt) {
    logForDebugging(`[mission] the card for session ${sessionId} was armed after this record; the ${state} state of the older one is not written over it`)
    return
  }
  if (mission.closed !== undefined && mission.closed !== state) {
    logForDebugging(`[mission] the record for session ${sessionId} closed as ${mission.closed}; the ${state} state is not written over it`)
    return
  }
  const card: MissionCard = {
    schema: 1,
    sessionId,
    goal: mission.condition,
    state,
    nextStep:
      state === 'met' || state === 'cleared'
        ? null
        : (mission.lastReason ??
          `keep working toward the goal; end a turn with one evidence line per criterion and the ${MISSION_MET_SENTINEL} line once its end state holds`),
    iterations: mission.iterations,
    setAt,
    updatedAt: new Date().toISOString(),
    ...(mission.outcome !== undefined ? { outcome: mission.outcome } : {}),
  }
  writeCard(card)
}

export function isMissionClearKeyword(text: string): boolean {
  return CLEAR_WORDS.has(text.trim().toLowerCase())
}

export function getActiveMission(sessionId: string = conversationIdHere()): ActiveMission | undefined {
  return missionsBySession.get(sessionId)
}

export function servedMission(sessionId: string = conversationIdHere()): ServedMission | undefined {
  const mission = missionsBySession.get(sessionId)
  return mission === undefined || mission.met ? undefined : { condition: mission.condition, setAt: mission.setAt }
}

export function missionCardView(sessionId: string = conversationIdHere()): MissionCardView | null {
  const live = missionsBySession.get(sessionId)
  if (live !== undefined) {
    const state = cardStateOf(live)
    return {
      goal: live.condition,
      state,
      nextStep: state === 'met' ? null : (live.lastReason ?? null),
      iterations: live.iterations,
      setAt: new Date(live.setAt).toISOString(),
      updatedAt: new Date().toISOString(),
      ...(live.outcome !== undefined ? { outcome: live.outcome } : {}),
    }
  }
  const card = cardMemo.has(sessionId) ? cardMemo.get(sessionId) ?? null : readCard(sessionId)
  return card === null
    ? null
    : { goal: card.goal, state: card.state, nextStep: card.nextStep, iterations: card.iterations, setAt: card.setAt, updatedAt: card.updatedAt, ...(card.outcome !== undefined ? { outcome: card.outcome } : {}) }
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
    `Work toward it. At each turn's end a judge reads the end state against the`,
    `evidence: your closing words, the tool calls the turn made, the verification`,
    `record; the Mission section of your system prompt carries the criteria and`,
    `the rules. When every criterion holds, end the turn with one numbered line`,
    `per criterion naming its evidence, then a final line containing exactly:`,
    ``,
    `    ${MISSION_MET_SENTINEL}`,
    ``,
    `A goal that reads as a progress snapshot (a plan, an in-flight status) is met`,
    `once the work it describes is done; when it is ambiguous or out of reach, end`,
    `the turn with one question to the operator — the mission pauses until they answer.`,
  ].join('\n')
}

function holdWords(mission: ActiveMission, verdict: GoalVerdict): string {
  return `${MISSION_HOLD_HEAD} ${mission.condition} — ${verdict.reason}. Continue.`
}

export function missionCompletedLine(mission: Pick<ActiveMission, 'condition' | 'setAt'>, outcome: MissionOutcome): string {
  const elapsed = formatDuration(Math.max(0, Date.parse(outcome.metAt) - mission.setAt), { mostSignificantOnly: true })
  return `${MISSION_COMPLETED_HEAD} ${mission.condition} — ${outcome.reason} · ${outcome.turns} ${plural(outcome.turns, 'turn')} · ${elapsed}`
}

function announceMissionCompleted(sessionId: string, mission: ActiveMission, outcome: MissionOutcome): void {
  const line = missionCompletedLine(mission, outcome)
  const id = createHash('sha256').update(`mission:${sessionId}:${mission.setAt}`).digest('hex')
  const words = `<task-notification>\n<task-id>host-${id}</task-id>\n<status>completed</status>\n<summary>${escapeXml(line)}</summary>\n<result>${escapeXml(line)}</result>\n</task-notification>`
  try {
    enqueuePendingNotification({ value: words, mode: 'task-notification', priority: 'next' })
  } catch (error) {
    logForDebugging(`[mission] the completed row was not queued: ${error instanceof Error ? error.message : String(error)}`)
  }
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

function boundsToolWindow(row: Message & { toolUseResult?: unknown }): boolean {
  if (row.type !== 'user' || row.toolUseResult) return false
  if (!row.isMeta) return true
  return textOf(row).startsWith(MISSION_HOLD_HEAD)
}

export function toolCallsSinceLastStop(messages: Message[]): string[] {
  const names: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]! as Message & { toolUseResult?: unknown }
    if (boundsToolWindow(m)) break
    if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
    for (const block of m.message.content as Array<{ type?: string; name?: string }>) if (block?.type === 'tool_use') names.push(block.name ?? 'tool')
  }
  return names.reverse()
}

function operatorBoundary(messages: Message[]): string | null {
  const index = turnBoundaryIndex(messages)
  if (index === -1) return null
  const row = messages[index] as { uuid?: string; origin?: unknown }
  const mark = row.uuid ?? `#${index}`
  return row.origin === undefined ? mark : `carried:${mark}`
}

function operatorSpokeSince(messages: Message[], pause: MissionPause): boolean {
  const now = operatorBoundary(messages)
  return now !== null && !now.startsWith('carried:') && now !== pause.boundary
}

function readVerification(): GoalEvidence['verification'] {
  try {
    const summary = verificationSummary(getCwd(), { skipDigest: true })
    return { state: summary.state, detail: summary.detail }
  } catch (error) {
    logForDebugging(`[mission] the verification record could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function gatherGoalEvidence(messages: Message[], mission: ActiveMission): GoalEvidence {
  const closing = closingText(messages)
  const close = sawMissionMetSentinel(messages) ? readItemisedClose(closing, mission.goal) : null
  const toolNames = toolCallsSinceLastStop(messages)
  return {
    closing,
    claimedMet: close !== null && close.met,
    ...(close !== null && !close.met ? { claimDefect: close.reason } : {}),
    asksOperator: close === null && closingAsksOperator(closing),
    toolCalls: toolNames.length,
    toolNames,
    verification: readVerification(),
    checks: mission.iterations,
  }
}

function pauseMission(sessionId: string, mission: ActiveMission, why: string, messages: Message[]): void {
  mission.paused = { why, boundary: operatorBoundary(messages) }
  mission.idleTurns = 0
  mission.lastReason = `paused — ${why}`
  persistCard(sessionId, mission, 'paused')
  logForDebugging(`[mission] the mission for session ${sessionId} pauses: ${why}`)
  notifyMissionChange()
}

function pausedNote(mission: ActiveMission): TurnNote {
  return { level: 'warning', text: `mission paused — ${mission.paused?.why ?? 'waiting on you'} · your next message resumes it; /mission clear ends it` }
}

function idleNote(): TurnNote {
  return { level: 'warning', text: `mission paused after ${MISSION_IDLE_TURNS} turns without a tool call — your next message resumes it` }
}

function resumeMission(sessionId: string, mission: ActiveMission, why: string): void {
  delete mission.paused
  mission.idleTurns = 0
  mission.lastReason = `resumed — ${why}`
  persistCard(sessionId, mission, 'armed')
  logForDebugging(`[mission] the mission for session ${sessionId} resumes: ${why}`)
  notifyMissionChange()
}

export function resumeMissionOnOperatorInput(sessionId: string = conversationIdHere()): boolean {
  const mission = missionsBySession.get(sessionId)
  if (mission === undefined || mission.paused === undefined) return false
  resumeMission(sessionId, mission, 'the operator spoke')
  return true
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
  const card = readCard(pending.sessionId)
  if (card !== null && missionCardStands(card.state)) {
    writeCard({
      ...card,
      state: 'continued',
      nextStep: `continued in session ${hostedId}`,
      updatedAt: new Date().toISOString(),
    })
  }
  logForDebugging(`[mission] the mission armed while the chat was landing follows the seat (${pending.sessionId} → ${hostedId})`)
  notifyMissionChange()
}

function declarePrefixMove(reason: string): void {
  try {
    declareLawfulPrefixChange(String(processMainOwner()), reason)
  } catch (error) {
    logForDebugging(`[mission] the prefix move was not declared: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function setActiveMission(
  condition: string,
  options?: { sessionId?: string; judge?: GoalJudge | null; setAt?: number },
): string {
  const sessionId = options?.sessionId ?? conversationIdHere()

  const prior = missionsBySession.get(sessionId)
  if (prior) {
    disengageTurnGuard(sessionId, prior.hookId)
    missionsBySession.delete(sessionId)
  }

  const setAt = options?.setAt !== undefined && Number.isFinite(options.setAt) ? options.setAt : Date.now()
  const record: ActiveMission = {
    condition,
    goal: compileGoal(condition),
    iterations: 0,
    idleTurns: 0,
    setAt,
    hookId: '',
  }

  const hookId = `mission-${sessionId}-${setAt}`
  engageTurnGuard(sessionId, {
    id: hookId,
    timeoutMs: GOAL_CHECK_TIMEOUT_MS,
    judge: async ({ messages }, signal) => {
      const mission = missionsBySession.get(sessionId)
      if (!mission || mission.condition !== condition || mission.met) return { hold: false }
      if (mission.paused !== undefined) {
        if (!operatorSpokeSince(messages, mission.paused)) return { hold: false }
        resumeMission(sessionId, mission, 'the operator spoke')
      }
      const evidence = gatherGoalEvidence(messages, mission)
      const verdict = await judgeGoal(mission.goal, evidence, { ...(options?.judge === undefined ? {} : { judge: options.judge }), signal })
      if (missionsBySession.get(sessionId) !== mission) {
        logForDebugging(`[mission] the verdict for session ${sessionId} arrived after the record was replaced or cleared; it is discarded`)
        return { hold: false }
      }
      mission.verdict = verdict
      mission.iterations += 1
      if (verdict.kind === 'met') {
        const outcome: MissionOutcome = { reason: verdict.reason, metAt: new Date().toISOString(), turns: mission.iterations }
        mission.met = true
        mission.closed = 'met'
        mission.outcome = outcome
        mission.lastReason = `met — ${verdict.reason}`
        persistCard(sessionId, mission, 'met')
        announceMissionCompleted(sessionId, mission, outcome)
        notifyMissionChange()
        return { hold: false }
      }
      if (evidence.asksOperator) {
        pauseMission(sessionId, mission, `the model asked: "${closingQuestion(evidence.closing)}"`, messages)
        return { hold: false, note: pausedNote(mission) }
      }
      if (verdict.kind === 'impossible') {
        pauseMission(sessionId, mission, verdict.reason, messages)
        return { hold: false, note: pausedNote(mission) }
      }
      mission.idleTurns = evidence.toolCalls === 0 ? mission.idleTurns + 1 : 0
      if (mission.idleTurns >= MISSION_IDLE_TURNS) {
        pauseMission(sessionId, mission, `${MISSION_IDLE_TURNS} turns without a tool call`, messages)
        return { hold: false, note: idleNote() }
      }
      claimContinuation(processMainOwner(), turnBoundaryIndex(messages), messages.length)
      mission.lastReason = `not yet met (check ${mission.iterations}) — ${verdict.reason}`
      persistCard(sessionId, mission, 'armed')
      return { hold: true, words: holdWords(mission, verdict) }
    },
  })

  record.hookId = hookId
  missionsBySession.set(sessionId, record)
  persistCard(sessionId, record, 'armed')
  declarePrefixMove('a mission was set')
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
  mission.closed = 'cleared'
  persistCard(sessionId, mission, 'cleared')
  declarePrefixMove('the mission was cleared')
  logForDebugging(`[mission] cleared standing mission for session ${sessionId}`)
  notifyMissionChange()
  return mission.condition
}

export function activeMissionStatusLine(sessionId: string = conversationIdHere()): string | null {
  const mission = missionsBySession.get(sessionId)
  return mission === undefined || mission.met ? null : missionStatusLine(mission)
}

export function syncMissionFromCard(sessionId: string): void {
  const card = readCard(sessionId)
  const live = missionsBySession.get(sessionId)
  if (card !== null && missionCardStands(card.state)) {
    if (live !== undefined && (Date.parse(card.setAt) > live.setAt || live.condition !== card.goal || live.met === true)) {
      disengageTurnGuard(sessionId, live.hookId)
      missionsBySession.delete(sessionId)
      logForDebugging(`[mission] the card for session ${sessionId} was armed after the live record; the live one is released`)
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
  const card = readCard(cardSessionId)
  if (!card || !missionCardStands(card.state)) return false
  const armedAt = Date.parse(card.setAt)
  setActiveMission(card.goal, { sessionId: armSessionId, ...(Number.isFinite(armedAt) ? { setAt: armedAt } : {}) })
  const mission = missionsBySession.get(armSessionId)
  if (mission) {
    mission.iterations = card.iterations
    if (card.state === 'paused') {
      mission.paused = { why: card.nextStep?.replace(/^paused — /, '') ?? 'waiting on the operator', boundary: null }
      mission.lastReason = `re-armed on resume, still paused (the previous run closed at check ${card.iterations})`
      persistCard(armSessionId, mission, 'paused')
    } else {
      mission.lastReason = `re-armed on resume (the previous run closed at check ${card.iterations})`
      persistCard(armSessionId, mission, 'armed')
    }
  }
  if (cardSessionId !== armSessionId) {
    writeCard({
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
