import type { ParseEntry } from 'shell-quote'
import type { SuggestionItem } from '../../types/suggestions.js'
import { logForDebugging } from '../debug.js'
import { exec } from '../Shell.js'
import { completionDialect } from '../shell/shellRecord.js'
import { quote, tryParseShellCommand } from './shellQuote.js'
import { notBuilt } from '../../pi/holes.js'

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

export async function getShellCompletions(
  input: string,
  cursorOffset: number,
  abortSignal: AbortSignal,
): Promise<SuggestionItem[]> {
  return notBuilt('src/utils/bash/shellCompletion.ts:86')
}
