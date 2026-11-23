import type { ParseEntry } from 'shell-quote'
import type { SuggestionItem } from '../../types/suggestions.js'
import { logForDebugging } from '../debug.js'
import { exec } from '../Shell.js'
import { completionDialect } from '../shell/shellRecord.js'
import { quote, tryParseShellCommand } from './shellQuote.js'

export type ShellCompletionType = 'command' | 'variable' | 'file'

const RESULT_CAP = 15
const COMPLETION_TIMEOUT_MS = 1000

const COMMAND_OPERATORS: ReadonlySet<string> = new Set(['|', '||', '&&', ';'])

type CompletionContext = { prefix: string; type: ShellCompletionType }

function findTokenBefore(tokens: ParseEntry[], lastToken: string): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === lastToken) {
      const prev = tokens[i - 1]
      if (prev !== undefined && typeof prev === 'object' && 'op' in prev) {
        return prev.op
      }
      return null
    }
  }
  return null
}

function classifyToken(token: string): ShellCompletionType {
  if (token.startsWith('$')) return 'variable'
  if (token.includes('/') || token.startsWith('~') || token.startsWith('.')) return 'file'
  return 'command'
}

function getCompletionContext(beforeCursor: string): CompletionContext {
  const varMatch = beforeCursor.match(/\$[A-Za-z_][A-Za-z0-9_]*$/)
  if (varMatch) {
    return { prefix: varMatch[0], type: 'variable' }
  }

  const parsed = tryParseShellCommand(beforeCursor)
  if (!parsed.success) {
    const parts = beforeCursor.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return { prefix: '', type: 'command' }
    const last = parts[parts.length - 1]!
    if (parts.length === 1) return { prefix: last, type: 'command' }
    return { prefix: last, type: classifyToken(last) }
  }

  const stringTokens = parsed.tokens.filter((token): token is string => typeof token === 'string')
  if (stringTokens.length === 0) return { prefix: '', type: 'command' }
  if (/\s$/.test(beforeCursor)) return { prefix: '', type: 'file' }

  const lastToken = stringTokens[stringTokens.length - 1]!
  let type = classifyToken(lastToken)
  if (type === 'command') {
    const prevOp = findTokenBefore(parsed.tokens, lastToken)
    const isCommandPosition =
      stringTokens.length === 1 || (prevOp !== null && COMMAND_OPERATORS.has(prevOp))
    if (!isCommandPosition) {
      type = 'file'
    }
  }
  return { prefix: lastToken, type }
}

function buildCompgenCommand(context: CompletionContext): string {
  if (context.type === 'variable') {
    const name = context.prefix.startsWith('$') ? context.prefix.slice(1) : context.prefix
    return `compgen -v -- ${quote([name])} 2>/dev/null`
  }
  if (context.type === 'file') {
    return `compgen -f -- ${quote([context.prefix])} 2>/dev/null | head -${RESULT_CAP} | while IFS= read -r f; do [ -d "$f" ] && printf '%s/\\n' "$f" || printf '%s \\n' "$f"; done`
  }
  return `compgen -c -- ${quote([context.prefix])} 2>/dev/null`
}

export async function getShellCompletions(
  input: string,
  cursorOffset: number,
  abortSignal: AbortSignal,
): Promise<SuggestionItem[]> {
  if (completionDialect() === null) return []
  try {
    const beforeCursor = input.slice(0, cursorOffset)
    const context = getCompletionContext(beforeCursor)
    if (context.prefix === '' && context.type !== 'file') return []

    const command = buildCompgenCommand(context)
    const handle = await exec(command, abortSignal, 'bash', { timeout: COMPLETION_TIMEOUT_MS })
    try {
      const result = await handle.result
      const lines = result.stdout
        .split('\n')
        .map(line => line.replace(/\r$/, ''))
        .filter(line => line.trim() !== '')
        .slice(0, RESULT_CAP)
      return lines.map(line => ({
        id: line,
        displayText: line,
        metadata: { completionType: context.type, input },
      }))
    } finally {
      handle.cleanup()
    }
  } catch (error) {
    logForDebugging(`Shell completion error: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}
