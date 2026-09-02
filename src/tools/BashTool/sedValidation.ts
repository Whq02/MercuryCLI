import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  splitCommand_DEPRECATED,
  tryParseShellCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'

function tokeniseSedArgs(command: string): { tokens: Array<string | null>; ok: boolean } {
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return { tokens: [], ok: false }
  const tokens = parse.tokens.map(token => (typeof token === 'string' ? token : GLOB_OR_OP))
  return { tokens, ok: true }
}

const GLOB_OR_OP: null = null

export function hasFileArgs(command: string): boolean {
  if (!/^sed\s/.test(command)) return false
  let parseOk = true
  let glob = false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return true
  const tokens = parse.tokens.map(token => {
    if (typeof token === 'string') return token
    if (isGlobToken(token)) glob = true
    return null
  })
  if (!parseOk) return true
  if (glob) return true

  let expressionFlagSeen = false
  let nonFlagCount = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === null) continue
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

export function extractSedExpressions(command: string): string[] {
  if (!/^sed\s/.test(command)) return []
  const argText = command.replace(/^sed\s+/, '')
  if (/-e\s*[wWe]/.test(argText) || /-w\s*[eE]/.test(argText)) {
    throw new Error('sed: dangerous combined flags')
  }
  const parse = tryParseShellCommand(argText)
  if (!parse.success) throw new Error('sed: unparseable')
  const tokens = parse.tokens.map(token => (typeof token === 'string' ? token : null))

  const expressions: string[] = []
  let expressionFlagSeen = false
  let standaloneCaptured = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === null) continue
    if (token === '-e' || token === '--expression') {
      const next = tokens[i + 1]
      if (next !== undefined && next !== null) {
        expressions.push(next)
        i++
        expressionFlagSeen = true
      } else if (next === null) {
        expressionFlagSeen = true
        i++
      }
      continue
    }
    if (/^(?:--expression=|-e=)/.test(token)) {
      expressions.push(token.replace(/^(?:--expression=|-e=)/, ''))
      expressionFlagSeen = true
      continue
    }
    if (token.startsWith('-')) continue
    if (!expressionFlagSeen && !standaloneCaptured) {
      expressions.push(token)
      standaloneCaptured = true
      break
    }
    break
  }
  return expressions
}

export function isPrintCommand(cmd: string): boolean {
  return /^\s*(?:\d+(?:,\d+)?)?p\s*$/.test(cmd)
}

export function isLinePrintingCommand(command: string, expressions: string[]): boolean {
  if (!/^sed\s/.test(command)) return false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return false
  const printFlags = new Set(['-n', '--quiet', '--silent', '-E', '--regexp-extended', '-r', '-z', '--zero-terminated', '--posix'])
  const shortFlagLetters = new Set(['n', 'E', 'r', 'z'])
  let quietPresent = false
  for (const token of parse.tokens) {
    if (typeof token !== 'string') continue
    if (!token.startsWith('-') || token === '--') continue
    if (printFlags.has(token)) {
      if (token === '-n' || token === '--quiet' || token === '--silent') quietPresent = true
      continue
    }
    if (/^-[a-zA-Z]{2,}$/.test(token)) {
      const letters = token.slice(1).split('')
      if (!letters.every(l => shortFlagLetters.has(l))) return false
      if (letters.includes('n')) quietPresent = true
      continue
    }
    return false
  }
  if (!quietPresent) return false
  if (expressions.length === 0) return false
  for (const expression of expressions) {
    const pieces = expression.split(';')
    for (const piece of pieces) {
      if (!isPrintCommand(piece)) return false
    }
  }
  return true
}

function isSubstitutionCommand(command: string, expressions: string[], allowFileWrites: boolean): boolean {
  if (!/^sed\s/.test(command)) return false
  if (!allowFileWrites && hasFileArgs(command)) return false
  const parse = tryParseShellCommand(command.replace(/^sed\s+/, ''))
  if (!parse.success) return false
  const flags = new Set(['-E', '--regexp-extended', '-r', '--posix'])
  const writeFlags = new Set(['-i', '--in-place'])
  const shortFlagLetters = new Set(['E', 'r', ...(allowFileWrites ? ['i'] : [])])
  for (const token of parse.tokens) {
    if (typeof token !== 'string') continue
    if (!token.startsWith('-') || token === '--') continue
    if (flags.has(token)) continue
    if (allowFileWrites && writeFlags.has(token)) continue
    if (/^-[a-zA-Z]{2,}$/.test(token) && token.slice(1).split('').every(l => shortFlagLetters.has(l))) continue
    return false
  }
  if (expressions.length !== 1) return false
  const expression = (expressions[0] as string).trim()
  if (!expression.startsWith('s/')) return false
  let slashes = 0
  for (let i = 2; i < expression.length; i++) {
    if (expression[i] === '\\') {
      i++
      continue
    }
    if (expression[i] === '/') slashes++
  }
  if (slashes !== 2) return false
  const lastSlash = expression.lastIndexOf('/')
  const trailing = expression.slice(lastSlash + 1)
  let digits = 0
  for (const ch of trailing) {
    if ('gpiImM'.includes(ch)) continue
    if (/[1-9]/.test(ch)) {
      digits++
      if (digits > 1) return false
      continue
    }
    return false
  }
  return true
}

export function sedCommandIsAllowedByAllowlist(command: string, options?: { allowFileWrites?: boolean }): boolean {
  const allowFileWrites = options?.allowFileWrites === true
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch {
    return false
  }

  let matched: 1 | 2 | null = null
  if (!allowFileWrites) {
    if (isLinePrintingCommand(command, expressions)) matched = 1
    else if (isSubstitutionCommand(command, expressions, false)) matched = 2
  } else {
    if (isSubstitutionCommand(command, expressions, true)) matched = 2
  }
  if (matched === null) return false
  if (matched === 2 && expressions.some(e => e.includes(';'))) return false
  if (expressions.some(isDangerousExpression)) return false
  return true
}


function isDangerousExpression(expression: string): boolean {
  for (const ch of expression) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x0001 || code > 0x007f) return true
  }
  if (expression.includes('{') || expression.includes('}')) return true
  if (expression.includes('\n')) return true
  const firstHash = expression.indexOf('#')
  if (firstHash !== -1 && expression[firstHash - 1] !== 's') return true
  if (expression.startsWith('!')) return true
  if (/[/\d$]!/.test(expression)) return true
  if (/[\d,$]\s*~\s*\d/.test(expression)) return true
  if (expression.startsWith(',')) return true
  if (/,\s*[+-]/.test(expression)) return true
  if (/^s\\/.test(expression)) return true
  if (/\\[|#%@]/.test(expression)) return true
  if (/\\\/[\s\S]*[wW]/.test(expression)) return true
  if (/\/[^/]*\s+[wWeE]/.test(expression)) return true
  if (expression.startsWith('s/') && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(expression)) return true
  if (/^s.[\s\S]*[wWeE]$/.test(expression) && !isWellFormedSubstitutionWithoutWriteFlags(expression)) return true
  if (WRITE_COMMAND_RE.test(expression)) return true
  if (EXECUTE_COMMAND_RE.test(expression)) return true
  if (SUBSTITUTION_WRITE_FLAG_RE.test(expression)) return true
  if (/y[^\\\n]/.test(expression) && /[wWeE]/.test(expression)) return true
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
  const subcommands = splitCommand_DEPRECATED(input.command)
  for (const raw of subcommands) {
    const subcommand = raw.trim()
    if (subcommand.split(/\s+/)[0] !== 'sed') continue
    if (!sedCommandIsAllowedByAllowlist(subcommand, { allowFileWrites })) {
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
  return { behavior: 'passthrough', message: 'No sed constraint applies.' }
}

function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}
