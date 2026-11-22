import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'
import {
  splitCommand,
  preparedSecurityParse,
} from '../permissions/decision/commandAnalysis.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'

function sedWords(command: string): { success: boolean; tokens: string[] } {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return { success: false, tokens: [] }
  const simple = parsed.commands[0]!
  if (simple.argv[0] !== 'sed' || simple.envVars.length) return { success: false, tokens: [] }
  return { success: true, tokens: simple.argv.slice(1) }
}

function hasFileArgs(command: string): boolean {
  if (!/^sed\s/.test(command)) return false
  const parse = sedWords(command)
  if (!parse.success) return true
  const tokens = parse.tokens

  let expressionFlagSeen = false
  let nonFlagCount = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-e' || token === '--expression') {
      if (tokens[i + 1] !== undefined) {
        i++
        expressionFlagSeen = true
      }
      continue
    }
    if (/^(?:--expression=|-e=)/.test(token)) {
      expressionFlagSeen = true
      continue
    }
    if (token.startsWith('-')) continue
    if (expressionFlagSeen) return true
    nonFlagCount++
    if (nonFlagCount >= 2) return true
  }
  return false
}

function isPrintCommand(cmd: string): boolean {
  return /^\s*(?:\d+(?:,\d+)?)?p\s*$/.test(cmd)
}

export function sedCommandIsAllowedByAllowlist(command: string, options?: { allowFileWrites?: boolean }): boolean {
  return notBuilt('src/utils/shell/sedValidation.ts:170')
}

function isWellFormedSubstitutionWithoutWriteFlags(expression: string): boolean {
  if (expression.length < 4 || expression[0] !== 's') return false
  const delimiter = expression[1] as string
  if (delimiter === '\\' || delimiter === '\n') return false
  let count = 0
  let flagsStart = -1
  for (let i = 1; i < expression.length; i++) {
    if (expression[i] === '\\') {
      i++
      continue
    }
    if (expression[i] === delimiter) {
      count++
      if (count === 3) {
        flagsStart = i + 1
        break
      }
    }
  }
  if (flagsStart === -1) return false
  return !/[wWeE]/.test(expression.slice(flagsStart))
}

const ADDR = String.raw`(?:\d+|\$|\/[^/\n]*\/[IMim]*|\d+,\d+|\d+,\$|\/[^/\n]*\/,\/[^/\n]*\/)`
const WRITE_COMMAND_RE = new RegExp(String.raw`(?:^|${ADDR})\s*[wW]\s+\S`)
const EXECUTE_COMMAND_RE = new RegExp(String.raw`^e|${ADDR}\s*e(?![a-zA-Z])`)
const SUBSTITUTION_WRITE_FLAG_RE = /s([^\\\n])(?:\\.|(?!\1)[^\\\n])*\1(?:\\.|(?!\1)[^\\\n])*\1[gpiImM0-9]*[wWeE]/


export function checkSedConstraints(input: { command: string }, context: ToolPermissionContext): PermissionResult {
  return notBuilt('src/utils/shell/sedValidation.ts:246')
}
