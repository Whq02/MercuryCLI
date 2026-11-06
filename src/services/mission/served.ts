import { compileGoal, goalCriteria } from './goal.js'
import { MISSION_MET_SENTINEL } from './sentinel.js'

export const MISSION_SECTION_HEADING = '# Mission'
export const MISSION_STATUS_HEAD = 'Mission status —'
export const MISSION_HOLD_HEAD = 'Mission not completed:'

export interface ServedMission {
  condition: string
  setAt: number
}

interface MissionStatusFacts {
  iterations: number
  verdict?: { kind: string; reason: string }
  paused?: { why: string }
}

export function missionSectionKey(mission: ServedMission | undefined): string {
  return mission === undefined ? 'off' : `${mission.setAt}:${mission.condition}`
}

export function missionSection(mission: ServedMission | undefined): string | null {
  if (mission === undefined) return null
  const goal = compileGoal(mission.condition)
  const criteria = goalCriteria(goal)
  return [
    MISSION_SECTION_HEADING,
    'The operator set a mission for this session. It is in force until it is met or the operator clears it; nothing else ends it.',
    '',
    `Goal: ${goal.endState}`,
    ...(goal.constraints.length > 0 ? [`Constraints: ${goal.constraints.join('; ')}`] : []),
    'Criteria — every one must hold before the mission is met:',
    ...criteria.map((criterion, index) => `  ${index + 1}. ${criterion}`),
    '',
    'Rules:',
    `- Work toward the mission every turn. A turn that ends before it is met comes back as "${MISSION_HOLD_HEAD} <goal> — <what is open>. Continue."; carry on from where you were.`,
    '- The operator may pause or divert you; do what they ask, then return to the mission.',
    '- Never drop it on your own. When a message would abandon it, or it cannot be reached as stated, say so and ask the operator to run /mission clear; until they do, it stands.',
    `- Close it only when every criterion holds: end that turn with one line per criterion, numbered as above, each naming the evidence that shows it holds, then a final line that is exactly ${MISSION_MET_SENTINEL}. A judge reads that close against the turn's evidence; a bare ${MISSION_MET_SENTINEL} or a skipped criterion is not a close, and the turn comes back.`,
    '- Unsure what it means, or blocked: end the turn with one question to the operator; the mission pauses until they answer and resumes with their next message. Three turns in a row without a tool call pause it the same way.',
    '- /mission clear, typed by the operator, ends it; /mission <words> replaces it.',
  ].join('\n')
}

export function missionStatusLine(mission: MissionStatusFacts): string {
  const verdict = mission.verdict === undefined ? 'none yet' : `${mission.verdict.kind} (${mission.verdict.reason})`
  const state = mission.paused === undefined ? 'armed' : `paused — ${mission.paused.why}`
  return `${MISSION_STATUS_HEAD} checks ${mission.iterations} · last verdict ${verdict} · ${state}`
}
