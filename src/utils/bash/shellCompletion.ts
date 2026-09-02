import type { ParseEntry } from 'shell-quote'
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { logForDebugging } from '../debug.js'
import { exec } from '../Shell.js'
import { quote, tryParseShellCommand } from './shellQuote.js'

export type ShellCompletionType = 'command' | 'variable' | 'file'

const RESULT_CAP = 15
const COMPLETION_TIMEOUT_MS = 1000

const COMMAND_OPERATORS: ReadonlySet<string> = new Set(['|', '||', '&&', ';'])

export function getShellType(): string {
  const shell = process.env.SHELL ?? ''
  if (shell.includes('zsh')) return 'zsh'
  if (shell.includes('bash')) return 'bash'
  if (shell.includes('fish')) return 'fish'
  return 'unknown'
}

type CompletionContext = { prefix: string; type: ShellCompletionType }

function typeByShape(token: string): ShellCompletionType {
  if (token.startsWith('$')) return 'variable'
  if (token.includes('/') || token.startsWith('~') || token.startsWith('.')) return 'file'
  return 'command'
}

function parseCompletionContext(textBeforeCursor: string): CompletionContext {
  const varMatch = /\$[A-Za-z_][A-Za-z0-9_]*$/.exec(textBeforeCursor)
  if (varMatch) {
    return { prefix: varMatch[0], type: 'variable' }
  }

  const parseResult = tryParseShellCommand(textBeforeCursor)
  if (!parseResult.success) {
    const words = textBeforeCursor.split(/\s+/).filter(w => w.length > 0)
    const last = words[words.length - 1] ?? ''
    const onlyToken = words.length === 1 && !/\s/.test(textBeforeCursor.trimStart() ? textBeforeCursor : '')
    if (onlyToken) {
      return { prefix: last, type: 'command' }
    }
    return { prefix: last, type: typeByShape(last) }
  }

  const stringTokens = parseResult.tokens.filter((t): t is string => typeof t === 'string')
  if (stringTokens.length === 0) {
    return { prefix: '', type: 'command' }
  }
  if (/\s$/.test(textBeforeCursor)) {
    return { prefix: '', type: 'file' }
  }

  const lastToken = stringTokens[stringTokens.length - 1] as string
  let type = typeByShape(lastToken)
  if (type === 'command') {
    const isFirst = stringTokens.length === 1
    const beforeLast = findTokenBefore(parseResult.tokens, lastToken)
    const followsOperator = beforeLast !== null && COMMAND_OPERATORS.has(beforeLast)
    if (!isFirst && !followsOperator) {
      type = 'file'
    }
  }
  return { prefix: lastToken, type }
}

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

function buildCompletionCommand(shellType: 'bash' | 'zsh', context: CompletionContext): string {
  const { prefix, type } = context
  if (shellType === 'bash') {
    if (type === 'variable') {
      const name = prefix.startsWith('$') ? prefix.slice(1) : prefix
      return `compgen -v ${quote([name])} 2>/dev/null`
    }
    if (type === 'file') {
      return `compgen -f ${quote([prefix])} 2>/dev/null | head -${RESULT_CAP} | while IFS= read -r __c; do if [ -d "$__c" ]; then printf '%s/\\n' "$__c"; else printf '%s \\n' "$__c"; fi; done`
    }
    return `compgen -c ${quote([prefix])} 2>/dev/null`
  }
  if (type === 'variable') {
    const name = prefix.startsWith('$') ? prefix.slice(1) : prefix
    return `print -rl -- \${(k)parameters[(I)${quote([`${name}*`])}]} 2>/dev/null`
  }
  if (type === 'file') {
    return `for __c in ${prefix}*(N[1,${RESULT_CAP}]); do if [ -d "$__c" ]; then print -r -- "$__c/"; else print -r -- "$__c "; fi; done 2>/dev/null`
  }
  return `print -rl -- \${(k)commands[(I)${quote([`${prefix}*`])}]} 2>/dev/null`
}

export async function getShellCompletions(
  input: string,
  cursorOffset: number,
  abortSignal: AbortSignal,
): Promise<SuggestionItem[]> {
  try {
    const shellType = getShellType()
    if (shellType !== 'bash' && shellType !== 'zsh') return []

    const context = parseCompletionContext(input.slice(0, cursorOffset))
    if (context.prefix === '' && context.type !== 'file') return []

    const command = buildCompletionCommand(shellType, context)
    const handle = await exec(command, abortSignal, 'bash', { timeout: COMPLETION_TIMEOUT_MS })
    const result = await handle.result
    const stdout = result.stdout ?? ''

    return stdout
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(0, RESULT_CAP)
      .map(line => ({
        id: line,
        displayText: line,
        metadata: { completionType: context.type, input },
      }))
  } catch (error) {
    logForDebugging(
      `shell completion failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}
