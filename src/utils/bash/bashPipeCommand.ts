import { quote as minimalQuote, type ControlOperator, type ParseEntry } from 'shell-quote'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from './shellQuote.js'

const CONTROL_STRUCTURE_RE = /\b(?:for|while|until|if|case|select)\s/

const DESCRIPTORS: ReadonlySet<string> = new Set(['0', '1', '2'])

function joinLineContinuations(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      let run = 0
      let j = i
      while (j < text.length && text[j] === '\\') {
        run++
        j++
      }
      if (text[j] === '\n' && run % 2 === 1) {
        out += '\\'.repeat(run - 1)
        i = j
        continue
      }
      out += '\\'.repeat(run)
      i = j - 1
      continue
    }
    out += text[i]
  }
  return out
}

function singleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

function operatorText(entry: ParseEntry): string | null {
  if (typeof entry === 'object' && entry !== null && 'op' in entry) {
    return (entry as { op: ControlOperator['op'] | 'glob' }).op
  }
  return null
}

function preserveVariables(key: string): string {
  return `$${key}`
}

function requiresFallback(original: string, joined: string): {
  fallback: boolean
  tokens?: ParseEntry[]
} {
  if (original.includes('`')) return { fallback: true }
  if (original.includes('$(')) return { fallback: true }
  if (/\$[A-Za-z_{]/.test(original)) return { fallback: true }
  if (CONTROL_STRUCTURE_RE.test(original)) return { fallback: true }
  if (joined.includes('\n')) return { fallback: true }
  if (hasShellQuoteSingleQuoteBug(joined)) return { fallback: true }

  const parseResult = tryParseShellCommand(joined, preserveVariables)
  if (!parseResult.success) return { fallback: true }
  if (hasMalformedTokens(joined, parseResult.tokens)) return { fallback: true }

  const tokens = parseResult.tokens
  const firstPipe = tokens.findIndex(t => operatorText(t) === '|')
  if (firstPipe <= 0) return { fallback: true }

  return { fallback: false, tokens }
}

export function rearrangePipeCommand(command: string): string {
  const joined = joinLineContinuations(command)
  const decision = requiresFallback(command, joined)

  if (decision.fallback || !decision.tokens) {
    return `${singleQuote(command)} < /dev/null`
  }

  const tokens = decision.tokens
  const firstPipe = tokens.findIndex(t => operatorText(t) === '|')

  const before = rebuildTokens(tokens.slice(0, firstPipe))
  const after = rebuildTokens(tokens.slice(firstPipe))
  const rebuilt = `${before} < /dev/null ${after}`.replace(/\s+/g, ' ').trim()
  return singleQuote(rebuilt)
}

function rebuildTokens(tokens: ParseEntry[]): string {
  const out: string[] = []
  let assignmentsAllowed = true
  let sawCommandWord = false

  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as ParseEntry

    if (typeof entry === 'object' && entry !== null && 'comment' in entry) {
      out.push(`#${(entry as { comment: string }).comment}`)
      continue
    }

    const op = operatorText(entry)
    if (op === 'glob') {
      out.push((entry as { pattern: string }).pattern)
      sawCommandWord = true
      continue
    }
    if (op !== null) {
      if (op === '&&' || op === '||' || op === ';') {
        assignmentsAllowed = true
        sawCommandWord = false
      }
      out.push(op)
      continue
    }

    const text = entry as string

    const opNext = tokens[i + 1]
    if (DESCRIPTORS.has(text) && opNext !== undefined && typeof opNext === 'object') {
      const nextOp = operatorText(opNext)
      const third = tokens[i + 2]
      if ((nextOp === '>&' || nextOp === '>' || nextOp === '>>') && third !== undefined) {
        if (typeof third === 'string' && (DESCRIPTORS.has(third) || third.startsWith('&') || third === '/dev/null')) {
          out.push(`${text}${nextOp}${third}`)
          i += 2
          continue
        }
      }
    }

    if (assignmentsAllowed && !sawCommandWord) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(text)
      if (match) {
        out.push(`${match[1]}${singleQuote(match[2] as string)}`)
        continue
      }
    }

    out.push(minimalQuote([text]))
    sawCommandWord = true
    assignmentsAllowed = false
  }

  return out.join(' ')
}
