import type { PermissionRuleValue } from '../../types/permissions.js'
import { permissionRuleValueFromString } from '../permissions/permissionRuleParser.js'

type MatcherShape = 'everything' | 'names' | 'rules' | 'regex'

const TOOL_NAME = /^[a-zA-Z0-9_]+$/
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep'])

type RuleArgument = 'command' | 'path'

export function ruleArgumentOf(toolName: string): RuleArgument | null {
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  if (PATH_TOOLS.has(toolName)) return 'path'
  return null
}

const RULE_ARGUMENT_WORDS = `the command of ${[...COMMAND_TOOLS].join(' and ')} and the path of ${[...PATH_TOOLS].slice(0, -1).join(', ')} and ${[...PATH_TOOLS].slice(-1)[0]}`

function splitClauses(matcher: string): string[] {
  const clauses: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < matcher.length; i++) {
    const ch = matcher[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === '|' && depth === 0) {
      clauses.push(matcher.slice(start, i))
      start = i + 1
    }
  }
  clauses.push(matcher.slice(start))
  return clauses
}

export function ruleClausesOf(matcher: string): PermissionRuleValue[] | null {
  if (!matcher.includes('(')) return null
  const clauses = splitClauses(matcher).map(clause => permissionRuleValueFromString(clause))
  return clauses.every(clause => TOOL_NAME.test(clause.toolName)) ? clauses : null
}

export function matcherShape(matcher: string | undefined): MatcherShape {
  if (!matcher || matcher === '*') return 'everything'
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) return 'names'
  if (ruleClausesOf(matcher) !== null) return 'rules'
  return 'regex'
}

export function matcherCompiles(matcher: string | undefined): boolean {
  if (matcherShape(matcher) !== 'regex') return true
  try {
    new RegExp(matcher as string)
    return true
  } catch {
    return false
  }
}

export function matcherArgumentFault(matcher: string | undefined): string | null {
  if (matcher === undefined) return null
  const clauses = ruleClausesOf(matcher)
  if (clauses === null) return null
  for (const clause of clauses) {
    if (clause.ruleContent === undefined || ruleArgumentOf(clause.toolName) !== null) continue
    return `match reads ${RULE_ARGUMENT_WORDS}, not the arguments of ${clause.toolName}: ${JSON.stringify(matcher)}`
  }
  return null
}
