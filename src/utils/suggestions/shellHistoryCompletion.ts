import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'


type ShellHistoryMatch = {
  fullCommand: string
  suffix: string
}

const CORPUS_TTL_MS = 60_000
const CORPUS_CAP = 50

let corpusCache: { commands: string[]; cachedAt: number } | null = null

async function getCorpus(): Promise<string[]> {
  const now = Date.now()
  if (corpusCache !== null && now - corpusCache.cachedAt < CORPUS_TTL_MS) {
    return corpusCache.commands
  }
  const commands: string[] = []
  const seen = new Set<string>()
  try {
    for await (const entry of getHistory()) {
      if (!entry.display.startsWith('!')) continue
      const command = entry.display.slice(1).trim()
      if (command.length === 0 || seen.has(command)) continue
      seen.add(command)
      commands.push(command)
      if (commands.length >= CORPUS_CAP) break
    }
    corpusCache = { commands, cachedAt: now }
  } catch (error) {
    logForDebugging(`shellHistoryCompletion: failed to load history: ${String(error)}`)
    return corpusCache?.commands ?? []
  }
  return commands
}

export async function getShellHistoryCompletion(input: string): Promise<ShellHistoryMatch | null> {
  if (input.length < 2 || input.trim() === '') return null
  for (const command of await getCorpus()) {
    if (command.startsWith(input) && command !== input) {
      return { fullCommand: command, suffix: command.slice(input.length) }
    }
  }
  return null
}
