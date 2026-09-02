import { existsSync } from 'node:fs'
import type { Message } from '../../types/message.js'
import type { SetAppState } from '../messageQueueManager.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../../services/run/continuationLatch.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import {
  readMissionCard,
  writeMissionCard,
  type MissionCardState,
} from '../../services/mission/missionCard.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'


export const MISSION_CONDITION_MAX_LENGTH = 4000

const DEFAULT_MISSION_MAX_BLOCKS = 12

export const MISSION_MET_SENTINEL = '<<<GOAL-MET>>>'

export const MISSION_DIRECTIVE_HEADER = 'A standing goal is now active for this session:'

export type MissionFeasibility =
  | 'attainable'
  | 'unknown-needs-check'
  | 'already-met'
  | 'needs-operator'
  | 'unattainable-now'

export interface MissionContract {
  outcome: string
  feasibility: MissionFeasibility
  evidence?: string
}

export function compileMissionContract(
  condition: string,
  probes: { fileExists: (p: string) => boolean } = {
    fileExists: p => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    },
  },
): MissionContract {
  const text = condition.trim()
  if (/\bno observable\b|\bwithout (any )?observable\b|\bcannot be (checked|observed|verified)\b/i.test(text)) {
    return { outcome: text, feasibility: 'unattainable-now', evidence: 'the condition declares itself unobservable' }
  }
  if (/simultaneously[^.]*\b(enabled and disabled|disabled and enabled|on and off|true and false|present and absent)\b/i.test(text)) {
    return { outcome: text, feasibility: 'unattainable-now', evidence: 'the condition demands mutually exclusive states at once' }
  }
  const fileExists = /\bthe file\s+(\S+)\s+exists\b/i.exec(text)
  if (fileExists?.[1] && probes.fileExists(fileExists[1])) {
    return { outcome: text, feasibility: 'already-met', evidence: `${fileExists[1]} exists` }
  }
  return { outcome: text, feasibility: 'attainable' }
}

export interface ActiveMission {
  condition: string
  iterations: number
  lastReason?: string
  met?: boolean
  gaveUp?: boolean
  setAt: number
  hookId: string
  contract?: MissionContract
  feasibilityBlocked?: boolean
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

function persistCard(sessionId: string, mission: ActiveMission, state: MissionCardState): void {
  writeMissionCard({
    schema: 1,
    sessionId,
    goal: mission.condition,
    state,
    nextStep:
      state === 'met'
        ? null
        : state === 'cleared'
          ? null
          : (mission.lastReason ??
            `keep working toward the goal; end a turn with the ${MISSION_MET_SENTINEL} line once it is genuinely met`),
    iterations: mission.iterations,
    setAt: new Date(mission.setAt).toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

export function isMissionClearKeyword(text: string): boolean {
  return CLEAR_WORDS.has(text.trim().toLowerCase())
}

export function getActiveMission(sessionId: string = getSessionId()): ActiveMission | undefined {
  return missionsBySession.get(sessionId)
}

export function buildMissionDirective(condition: string): string {
  return [
    MISSION_DIRECTIVE_HEADER,
    ``,
    `    ${condition}`,
    ``,
    `Acknowledge the mission in one line, then immediately start (or continue)`,
    `working toward it. Do not stop until the condition is genuinely met — a`,
    `Stop hook will keep re-prompting you until it is.`,
    ``,
    `When — and only when — the condition is genuinely and fully met, end that`,
    `turn with a single final line containing exactly:`,
    ``,
    `    ${MISSION_MET_SENTINEL}`,
    ``,
    `Do not emit that line prematurely, and do not tell the user to clear the`,
    `mission — emitting the line is how you signal completion.`,
    ``,
    `If the condition reads as a progress snapshot (a plan, an "in flight"`,
    `status, a worklist), it is met when the work it directs is complete —`,
    `being PAST the described state counts as met, not unmet.`,
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

export function setActiveMission(
  setAppState: SetAppState,
  condition: string,
  options?: { maxBlocks?: number; sessionId?: string },
): string {
  const sessionId = options?.sessionId ?? getSessionId()
  const maxBlocks = options?.maxBlocks ?? DEFAULT_MISSION_MAX_BLOCKS

  const prior = missionsBySession.get(sessionId)
  if (prior) {
    removeFunctionHook(setAppState, sessionId, 'Stop', prior.hookId)
    missionsBySession.delete(sessionId)
  }

  const setAt = Date.now()
  const contract = compileMissionContract(condition)
  const record: ActiveMission = {
    condition,
    iterations: 0,
    setAt,
    hookId: '',
    contract,
    ...(contract.feasibility === 'already-met' ? { met: true, lastReason: `already met at compile: ${contract.evidence}` } : {}),
  }

  const hookId = addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    messages => {
      const mission = missionsBySession.get(sessionId)
      if (!mission || mission.condition !== condition) return true
      if (mission.met) return true
      if (sawMissionMetSentinel(messages)) {
        mission.met = true
        persistCard(sessionId, mission, 'met')
        return true
      }
      if (mission.contract?.feasibility === 'unattainable-now') {
        if (mission.feasibilityBlocked) {
          mission.gaveUp = true
          mission.lastReason = `feasibility terminal: ${mission.contract.evidence} — disarmed after the one bounded feasibility check`
          persistCard(sessionId, mission, 'stood-down')
          return true
        }
        mission.feasibilityBlocked = true
        mission.iterations += 1
        mission.lastReason = `feasibility check issued: ${mission.contract.evidence}`
        persistCard(sessionId, mission, 'armed')
        return false
      }
      if (mission.iterations >= maxBlocks) {
        mission.gaveUp = true
        mission.lastReason = `block cap (${maxBlocks}) reached — hook disarmed without the mission being met`
        persistCard(sessionId, mission, 'stood-down')
        logForDebugging(
          `[mission] block cap (${maxBlocks}) reached for "${condition}" — allowing stop`,
        )
        return true
      }
      const claimed = claimContinuation(
        processMainOwner(),
        turnBoundaryIndex(messages),
        messages.length,
      )
      if (!claimed) {
        mission.lastReason = 'another hook claimed this stop attempt — mission defers one round'
        persistCard(sessionId, mission, 'armed')
        return true
      }
      mission.iterations += 1
      mission.lastReason = `Mission not yet met (check ${mission.iterations})`
      persistCard(sessionId, mission, 'armed')
      return false
    },
    `The standing mission for this session is not yet met: ${condition}\nKeep working toward it. When it is genuinely met, end your turn with a final line containing exactly ${MISSION_MET_SENTINEL}. A snapshot-style condition (a plan or in-flight status) counts as met once the work it directs is complete — being past the described state is completion, not a mismatch.`,
    { timeout: 5000, id: `mission-${sessionId}-${setAt}` },
  )

  record.hookId = hookId
  missionsBySession.set(sessionId, record)
  persistCard(sessionId, record, record.met ? 'met' : 'armed')
  logForDebugging(`[mission] installed standing mission for session ${sessionId}`)
  return buildMissionDirective(condition)
}

export function clearActiveMission(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): string | null {
  const mission = missionsBySession.get(sessionId)
  if (!mission) return null
  removeFunctionHook(setAppState, sessionId, 'Stop', mission.hookId)
  missionsBySession.delete(sessionId)
  persistCard(sessionId, mission, 'cleared')
  logForDebugging(`[mission] cleared standing mission for session ${sessionId}`)
  return mission.condition
}

export function rearmMissionFromCard(
  setAppState: SetAppState,
  target: string | { cardSessionId?: string; armSessionId?: string } = {},
): boolean {
  const normalized = typeof target === 'string' ? { cardSessionId: target, armSessionId: target } : target
  const cardSessionId = normalized.cardSessionId ?? getSessionId()
  const armSessionId = normalized.armSessionId ?? getSessionId()
  if (missionsBySession.has(armSessionId)) return false
  const card = readMissionCard(cardSessionId)
  if (!card || card.state !== 'armed') return false
  setActiveMission(setAppState, card.goal, { sessionId: armSessionId })
  const mission = missionsBySession.get(armSessionId)
  if (mission) {
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
