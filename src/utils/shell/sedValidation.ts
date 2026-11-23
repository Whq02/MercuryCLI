import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'
import {
  splitCommand,
  preparedSecurityParse,
} from '../permissions/decision/commandAnalysis.js'
import { passedOver } from '../passedOver.js'

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

const PRINT_MODE_LONG_FLAGS = new Set([
  '-n',
  '--quiet',
  '--silent',
  '-E',
  '--regexp-extended',
  '-r',
  '-z',
  '--zero-terminated',
  '--posix',
])

const PRINT_MODE_SHORT_CHARS = 'nErz'

const SUB_MODE_BASE_LONG_FLAGS = new Set([
  '-E',
  '--regexp-extended',
  '-r',
  '--posix',
])

const SUB_MODE_WRITE_LONG_FLAGS = new Set([
  '-E',
  '--regexp-extended',
  '-r',
  '--posix',
  '-i',
  '--in-place',
])

function isAllowedFlag(flag: string, allowedLong: ReadonlySet<string>, allowedShortChars: string): boolean {
  if (allowedLong.has(flag)) return true
  if (/^-[a-zA-Z]+$/.test(flag)) {
    for (let i = 1; i < flag.length; i++) {
      if (!allowedShortChars.includes(flag[i]!)) return false
    }
    return true
  }
  return false
}

function isStrictSlashSubstitution(expression: string): boolean {
  const trimmed = expression.trim()
  if (!trimmed.startsWith('s/')) return false
  if (trimmed.includes(';')) return false
  let slashCount = 0
  let flagsStart = -1
  for (let i = 2; i < trimmed.length; i++) {
    if (trimmed[i] === '\\') {
      i++
      continue
    }
    if (trimmed[i] === '/') {
      slashCount++
      if (slashCount === 2) {
        flagsStart = i + 1
        break
      }
    }
  }
  if (slashCount !== 2 || flagsStart === -1) return false
  const flags = trimmed.slice(flagsStart)
  if (!/^[gpiImM1-9]*$/.test(flags)) return false
  const digits = flags.match(/[1-9]/g)
  return (digits?.length ?? 0) <= 1
}

function hasDangerousSedExpression(expression: string): boolean {
  if (/[^\x01-\x7f]/.test(expression)) return true
  if (/[{}\n]/.test(expression)) return true
  if (/(?:^|[^s])#/.test(expression)) return true
  const trimmed = expression.trim()
  if (/^[!,]/.test(trimmed)) return true
  if (/[\/\d$]!/.test(trimmed)) return true
  if (/[\d,$]\s*~\s*\d/.test(trimmed)) return true
  if (/,\s*[+-]/.test(trimmed)) return true
  if (/^s\\/.test(trimmed)) return true
  if (/\\[|#%@]/.test(trimmed)) return true
  if (/\\\/\s*[wW]/.test(trimmed)) return true
  const wellFormedSub = isWellFormedSubstitutionWithoutWriteFlags(trimmed)
  if (!wellFormedSub && /\/[^/\n]*\/\s+[wWeE]/.test(trimmed)) return true
  if (trimmed.startsWith('s/') && !isStrictSlashSubstitution(trimmed)) return true
  if (/[wWeE]$/.test(trimmed) && !wellFormedSub) return true
  if (WRITE_COMMAND_RE.test(trimmed)) return true
  if (EXECUTE_COMMAND_RE.test(trimmed)) return true
  if (SUBSTITUTION_WRITE_FLAG_RE.test(trimmed)) return true
  if (/^y/.test(trimmed) && /[wWeE]/.test(trimmed)) return true
  return false
}

export function sedCommandIsAllowedByAllowlist(command: string, options?: { allowFileWrites?: boolean }): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false
  if (!/^sed\s/.test(command)) return false
  if (/\s-[a-zA-Z]*(?:e[wWe]|w[eE])/.test(command)) {
    passedOver(new Error('sed: dangerous combined flags'))
    return false
  }

  let tokens: string[]
  try {
    const parsed = sedWords(command)
    if (!parsed.success) {
      passedOver(new Error('sed: unparseable'))
      return false
    }
    tokens = parsed.tokens
  } catch (error) {
    passedOver(error)
    return false
  }

  const flags: string[] = []
  const expressions: string[] = []
  let hasExpressionFlag = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '-e' || token === '--expression') {
      const expr = tokens[i + 1]
      if (expr === undefined) return false
      flags.push(token)
      expressions.push(expr)
      hasExpressionFlag = true
      i++
      continue
    }
    if (token.startsWith('--expression=')) {
      flags.push(token)
      expressions.push(token.slice('--expression='.length))
      hasExpressionFlag = true
      continue
    }
    if (token.startsWith('-e=')) {
      flags.push(token)
      expressions.push(token.slice('-e='.length))
      hasExpressionFlag = true
      continue
    }
    if (token === '--') {
      if (!hasExpressionFlag && expressions.length === 0 && tokens[i + 1] !== undefined) {
        expressions.push(tokens[i + 1]!)
      }
      break
    }
    if (token.startsWith('-')) {
      flags.push(token)
      continue
    }
    if (!hasExpressionFlag && expressions.length === 0) {
      expressions.push(token)
    }
  }

  if (expressions.length === 0) return false
  if (expressions.some(hasDangerousSedExpression)) return false

  const hasQuietFlag = flags.some(
    flag =>
      flag === '-n' ||
      flag === '--quiet' ||
      flag === '--silent' ||
      (/^-[a-zA-Z]+$/.test(flag) && flag.includes('n')),
  )
  if (hasQuietFlag && flags.every(flag => isAllowedFlag(flag, PRINT_MODE_LONG_FLAGS, PRINT_MODE_SHORT_CHARS))) {
    const pieces = expressions.flatMap(expr => expr.split(';'))
    if (pieces.length > 0 && pieces.every(piece => isPrintCommand(piece))) {
      return true
    }
  }

  if (!allowFileWrites && hasFileArgs(command)) return false
  const allowedSubLong = allowFileWrites ? SUB_MODE_WRITE_LONG_FLAGS : SUB_MODE_BASE_LONG_FLAGS
  const allowedSubShort = allowFileWrites ? 'Eri' : 'Er'
  if (
    expressions.length === 1 &&
    flags.every(flag => isAllowedFlag(flag, allowedSubLong, allowedSubShort)) &&
    isStrictSlashSubstitution(expressions[0]!)
  ) {
    return true
  }

  return false
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
  const allowFileWrites = context.mode === 'implement'
  const subcommands = splitCommand(input.command)
  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    const firstToken = trimmed.split(/\s+/)[0]
    if (firstToken !== 'sed') continue
    if (!sedCommandIsAllowedByAllowlist(trimmed, { allowFileWrites })) {
      return {
        behavior: 'ask',
        message: 'This sed command needs approval because it contains potentially dangerous operations.',
        decisionReason: {
          type: 'other',
          reason: 'The command contains sed operations that require explicit approval, such as write or execute commands.',
        },
      }
    }
  }
  return {
    behavior: 'passthrough',
    message: 'No sed constraint applies.',
  }
}
