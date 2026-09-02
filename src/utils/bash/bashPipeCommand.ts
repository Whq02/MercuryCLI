/**
 * Rewrite a piped command so a stdin redirect lands on the first pipeline
 * stage rather than on the `eval` wrapper the executor uses.
 *
 * The executor runs commands through `eval`, so a stdin redirect appended to
 * the whole thing applies to `eval` (hence to the last pipeline stage). This
 * function moves the redirect to the first command. The output is always a
 * single-quoted program suitable as an `eval` argument.
 */
import { quote as minimalQuote, type ControlOperator, type ParseEntry } from 'shell-quote'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from './shellQuote.js'

/** Control structures that force the whole-command fallback. Contract data. */
const CONTROL_STRUCTURE_RE = /\b(?:for|while|until|if|case|select)\s/

/** Recognised descriptors for the redirect-group re-emission. */
const DESCRIPTORS: ReadonlySet<string> = new Set(['0', '1', '2'])

/** Join line continuations (odd backslash run before a bare newline only). */
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

/**
 * Single-quote a string by closing the quote, emitting a literal quote
 * inside double quotes, and reopening — NOT via the library quoter. The
 * library falls back to a double-quoted rendering that backslash-escapes
 * `!`, so a `jq`/`awk` inequality (`!=`) would reach the shell as `\!=` and
 * fail to parse.
 */
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

/** Whether the command must take the whole-command fallback form. */
function requiresFallback(original: string, joined: string): {
  fallback: boolean
  tokens?: ParseEntry[]
} {
  if (original.includes('`')) return { fallback: true }
  if (original.includes('$(')) return { fallback: true }
  // A variable reference: `$` then a letter, underscore or `{`.
  if (/\$[A-Za-z_{]/.test(original)) return { fallback: true }
  if (CONTROL_STRUCTURE_RE.test(original)) return { fallback: true }
  if (joined.includes('\n')) return { fallback: true }
  if (hasShellQuoteSingleQuoteBug(joined)) return { fallback: true }

  const parseResult = tryParseShellCommand(joined, preserveVariables)
  if (!parseResult.success) return { fallback: true }
  if (hasMalformedTokens(joined, parseResult.tokens)) return { fallback: true }

  const tokens = parseResult.tokens
  const firstPipe = tokens.findIndex(t => operatorText(t) === '|')
  if (firstPipe <= 0) return { fallback: true } // no pipe, or the pipe is first

  return { fallback: false, tokens }
}

/**
 * Rearrange a piped command so ` < /dev/null` applies to the first stage.
 */
export function rearrangePipeCommand(command: string): string {
  const joined = joinLineContinuations(command)
  const decision = requiresFallback(command, joined)

  if (decision.fallback || !decision.tokens) {
    // Fallback: quote the ORIGINAL and append the redirect OUTSIDE the
    // quotes, so it is eval's own redirect (`eval 'cmd' < /dev/null`).
    return `${singleQuote(command)} < /dev/null`
  }

  const tokens = decision.tokens
  const firstPipe = tokens.findIndex(t => operatorText(t) === '|')

  const before = rebuildTokens(tokens.slice(0, firstPipe))
  const after = rebuildTokens(tokens.slice(firstPipe))
  const rebuilt = `${before} < /dev/null ${after}`.replace(/\s+/g, ' ').trim()
  return singleQuote(rebuilt)
}

/**
 * Rebuild a token run: descriptor redirect groups re-emitted as one token;
 * leading environment assignments keep `NAME=` unquoted and quote only the
 * value (recognised before the first non-assignment string token of a
 * command, reset after `&&`/`||`/`;`); glob tokens unquoted; all other
 * operators verbatim; all other strings quoted.
 */
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
      out.push((entry as { pattern: string }).pattern) // unquoted so the shell expands it
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

    // Descriptor redirect group: a 0/1/2 string, an operator, and a third
    // token within range → one re-emitted token.
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

    // Leading environment assignment: keep NAME= unquoted, quote the value.
    if (assignmentsAllowed && !sawCommandWord) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(text)
      if (match) {
        out.push(`${match[1]}${singleQuote(match[2] as string)}`)
        continue
      }
    }

    // Ordinary string tokens use the LIBRARY's minimal quoter, so a token that
    // needs no quoting (a bare command name, a simple argument) is emitted
    // UNQUOTED. Quoting a command name with single quotes would suppress
    // alias/function/keyword resolution, silently breaking the operator's shell
    // aliases. (The whole-program wrap and the fallback still use the manual
    // close/reopen single-quote to protect a `!` inside a jq/awk filter.)
    out.push(minimalQuote([text]))
    sawCommandWord = true
    assignmentsAllowed = false
  }

  return out.join(' ')
}
