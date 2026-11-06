import { MISSION_MET_SENTINEL } from './sentinel.js'

export interface GoalStatement {
  endState: string
  constraints: string[]
}

export type GoalFeasibility = 'attainable' | 'unattainable-now'

export interface GoalContract {
  feasibility: GoalFeasibility
  evidence?: string
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
const EVIDENCE_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu
const EVIDENCE_WORDS_FLOOR = 2

function evidenceWordCount(words: string, criterion: string): number {
  let rest = words.trim()
  if (rest.toLowerCase().startsWith(criterion.toLowerCase())) rest = rest.slice(criterion.length)
  rest = rest.replace(/^[\s—–:;,.-]+/, '')
  return (rest.match(EVIDENCE_TOKEN) ?? []).length
}

export function readItemisedClose(closing: string, goal: GoalStatement): CloseReading {
  const lines = closing.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines[lines.length - 1] !== MISSION_MET_SENTINEL) return { met: false, reason: 'the turn ended without the completion line' }
  const criteria = goalCriteria(goal)
  const found = new Map<number, string>()
  for (const line of lines.slice(0, -1)) {
    const match = CRITERION_LINE.exec(line)
    if (match === null) continue
    const n = Number(match[1])
    if (n >= 1 && n <= criteria.length && !found.has(n)) found.set(n, match[2] ?? '')
  }
  if (found.size === 0) return { met: false, reason: 'the completion line stands alone: no criterion lines precede it' }
  for (let n = 1; n <= criteria.length; n++) {
    const words = found.get(n)
    if (words === undefined) return { met: false, reason: `criterion ${n} has no line in the close (${criteria[n - 1]})` }
    if (evidenceWordCount(words, criteria[n - 1]!) < EVIDENCE_WORDS_FLOOR) return { met: false, reason: `criterion ${n} names no evidence (${criteria[n - 1]})` }
  }
  return { met: true }
}

export function goalContract(condition: string): GoalContract {
  const text = condition.trim()
  if (/\bno observable\b|\bwithout (any )?observable\b|\bcannot be (checked|observed|verified)\b/i.test(text)) {
    return { feasibility: 'unattainable-now', evidence: 'the goal declares itself unobservable' }
  }
  if (/simultaneously[^.]*\b(enabled and disabled|disabled and enabled|on and off|true and false|present and absent)\b/i.test(text)) {
    return { feasibility: 'unattainable-now', evidence: 'the goal demands mutually exclusive states at once' }
  }
  return { feasibility: 'attainable' }
}
