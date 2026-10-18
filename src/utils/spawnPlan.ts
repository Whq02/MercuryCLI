import { hostLookupWorld, resolveExecutable, type LookupWorld } from './which.js'

export interface SpawnWorld extends LookupWorld {
  comSpec?: string
}

export type SpawnPlan =
  | { file: string; args: string[]; windowsVerbatimArguments: boolean }
  | { refused: string; missing?: string }

export function hostSpawnWorld(): SpawnWorld {
  return { ...hostLookupWorld(), comSpec: process.env.ComSpec }
}

const BATCH_SHIM = /\.(cmd|bat)$/i
const CMD_CANNOT_CARRY = /["%!\r\n\0]/
const CMD_NEEDS_QUOTES = /[\s&|<>^()]/

function quoteForCmd(word: string): string {
  if (word === '') return '""'
  return CMD_NEEDS_QUOTES.test(word) ? `"${word}"` : word
}

export function spawnPlanOf(argv: readonly string[], world: SpawnWorld = hostSpawnWorld()): SpawnPlan {
  const [tool, ...args] = argv
  if (tool === undefined || tool === '') return { refused: 'no program named' }
  const resolved = resolveExecutable(tool, world)
  if (resolved === null) return { refused: `${tool} is not on PATH`, missing: tool }
  if (world.platform !== 'win32' || !BATCH_SHIM.test(resolved)) {
    return { file: resolved, args, windowsVerbatimArguments: false }
  }
  const unsafe = [resolved, ...args].find(word => CMD_CANNOT_CARRY.test(word))
  if (unsafe !== undefined) {
    return { refused: `${resolved} is a batch file and the word ${JSON.stringify(unsafe)} carries a character cmd.exe would rewrite (a quote, %, ! or a line break) — run the command by hand` }
  }
  return {
    file: world.comSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteForCmd).join(' ')}"`],
    windowsVerbatimArguments: true,
  }
}
