import { existsSync } from 'node:fs'

export interface GoalStatement {
  endState: string
  constraints: string[]
}

export type GoalFeasibility = 'attainable' | 'already-met' | 'unattainable-now'

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

export function goalContract(
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
): GoalContract {
  const text = condition.trim()
  if (/\bno observable\b|\bwithout (any )?observable\b|\bcannot be (checked|observed|verified)\b/i.test(text)) {
    return { feasibility: 'unattainable-now', evidence: 'the goal declares itself unobservable' }
  }
  if (/simultaneously[^.]*\b(enabled and disabled|disabled and enabled|on and off|true and false|present and absent)\b/i.test(text)) {
    return { feasibility: 'unattainable-now', evidence: 'the goal demands mutually exclusive states at once' }
  }
  const fileExists = /\bthe file\s+(\S+)\s+exists\b/i.exec(text)
  if (fileExists?.[1] && probes.fileExists(fileExists[1])) {
    return { feasibility: 'already-met', evidence: `${fileExists[1]} exists` }
  }
  return { feasibility: 'attainable' }
}
