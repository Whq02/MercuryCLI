import { MISSION_MET_SENTINEL } from './sentinel.js'

export interface GoalStatement {
  endState: string
  constraints: string[]
}

const SEGMENT_BREAK = /\s*(?:\n|;|\s[—–]\s|\s--\s)\s*/
const TRAILING_CONSTRAINT = /,\s+((?:without|while|never|but|keeping|only|not)\b.*)$/i

export function compileGoal(condition: string): GoalStatement {
  const segments = condition
    .trim()
    .split(SEGMENT_BREAK)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
  let endState = segments[0] ?? condition.trim()
  const constraints = segments.slice(1)
  const trailing = TRAILING_CONSTRAINT.exec(endState)
  if (trailing?.[1] !== undefined) {
    endState = endState.slice(0, trailing.index).trim()
    constraints.unshift(trailing[1].trim())
  }
  return { endState, constraints }
}

export function goalWords(goal: GoalStatement): string {
  const lines = [`Goal: ${goal.endState}`]
  if (goal.constraints.length > 0) lines.push(`Constraints: ${goal.constraints.join('; ')}`)
  return lines.join('\n')
}

export function goalCriteria(goal: GoalStatement): string[] {
  return [goal.endState, ...goal.constraints]
}

export type CloseReading = { met: true } | { met: false; reason: string }

const CRITERION_LINE = /^\s*(\d+)\s*[.):\]-]\s*(.*)$/

export function readItemisedClose(closing: string, goal: GoalStatement): CloseReading {
  const lines = closing.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines[lines.length - 1] !== MISSION_MET_SENTINEL) return { met: false, reason: 'the turn ended without the completion line' }
  const criteria = goalCriteria(goal)
  const found = new Map<number, string>()
  for (const line of lines.slice(0, -1)) {
    const match = CRITERION_LINE.exec(line)
    if (match === null) continue
    const n = Number(match[1])
    const words = (match[2] ?? '').trim()
    if (n >= 1 && n <= criteria.length && words !== '' && !found.has(n)) found.set(n, words)
  }
  if (found.size === 0) return { met: false, reason: 'the completion line stands alone: no criterion lines precede it' }
  for (let n = 1; n <= criteria.length; n++) {
    if (!found.has(n)) return { met: false, reason: `criterion ${n} has no line in the close (${criteria[n - 1]})` }
  }
  return { met: true }
}
