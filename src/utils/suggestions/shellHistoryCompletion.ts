import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'
import { notBuilt } from '../../pi/holes.js'


type ShellHistoryMatch = {
  fullCommand: string
  suffix: string
}

const CORPUS_TTL_MS = 60_000
const CORPUS_CAP = 50

let corpusCache: { commands: string[]; cachedAt: number } | null = null

async function getCorpus(): Promise<string[]> {
  return notBuilt('src/utils/suggestions/shellHistoryCompletion.ts:15')
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
