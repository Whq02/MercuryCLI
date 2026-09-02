import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'

/**
 * Ghost-text completion for `!`-prefixed shell input, drawn from session
 * history.
 */

export type ShellHistoryMatch = {
  fullCommand: string
  suffix: string
}

const CORPUS_TTL_MS = 60_000
const CORPUS_CAP = 50

let corpusCache: { commands: string[]; cachedAt: number } | null = null

async function getCorpus(): Promise<string[]> {
  if (corpusCache !== null && Date.now() - corpusCache.cachedAt < CORPUS_TTL_MS) {
    return corpusCache.commands
  }
  const commands: string[] = []
  const seen = new Set<string>()
  try {
    for await (const entry of getHistory()) {
      if (!entry.display.startsWith('!')) continue
      const command = entry.display.slice(1).trim()
      if (command === '' || seen.has(command)) continue
      seen.add(command)
      commands.push(command)
      if (commands.length >= CORPUS_CAP) break
    }
  } catch (error) {
    logForDebugging(`shell history read failed: ${String(error)}`)
    return []
  }
  corpusCache = { commands, cachedAt: Date.now() }
  return commands
}

/**
 * The first corpus entry that starts with the input EXACTLY — including
 * trailing spaces — and is not equal to it: `ls ` matches `ls -lah`, while
 * `ls  ` (two spaces) does not. Inputs shorter than 2 characters or
 * trimming to nothing never match.
 */
export async function getShellHistoryCompletion(input: string): Promise<ShellHistoryMatch | null> {
  if (input.length < 2 || input.trim() === '') return null
  for (const command of await getCorpus()) {
    if (command.startsWith(input) && command !== input) {
      return { fullCommand: command, suffix: command.slice(input.length) }
    }
  }
  return null
}

export function clearShellHistoryCache(): void {
  corpusCache = null
}

/** Front-loads a just-submitted command, de-duplicating in place; a no-op before first population (the next read includes it anyway). */
export function prependToShellHistoryCache(command: string): void {
  if (corpusCache === null) return
  corpusCache.commands = [command, ...corpusCache.commands.filter(existing => existing !== command)]
}
