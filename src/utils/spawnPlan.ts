import { windowsBatchTail } from './shell/windowsBatchLine.js'
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
const LINE_BREAK = /[\r\n\0]/

function cmdCannotCarry(word: string): boolean {
  return LINE_BREAK.test(word) || windowsBatchTail([word]) === null
}

export function spawnPlanOf(argv: readonly string[], world: SpawnWorld = hostSpawnWorld()): SpawnPlan {
  const [tool, ...args] = argv
  if (tool === undefined || tool === '') return { refused: 'no program named' }
  const resolved = resolveExecutable(tool, world)
  if (resolved === null) return { refused: `${tool} is not on PATH`, missing: tool }
  if (world.platform !== 'win32' || !BATCH_SHIM.test(resolved)) {
    return { file: resolved, args, windowsVerbatimArguments: false }
  }
  const words = [resolved, ...args]
  const unsafe = words.find(cmdCannotCarry)
  const line = unsafe === undefined ? windowsBatchTail(words) : null
  if (line === null) {
    return { refused: `${resolved} is a batch file and the word ${JSON.stringify(unsafe ?? resolved)} carries a character cmd.exe would rewrite (a quote, a line break, or a percent pattern it could expand) — run the command by hand` }
  }
  return {
    file: world.comSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', line],
    windowsVerbatimArguments: true,
  }
}
