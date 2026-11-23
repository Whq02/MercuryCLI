import { hostEnv } from '../environment/hostEnv.js'
import { pickWin32ExecutableLine, resolveProgramInPath, spawnableCommandSpellings } from '../host-os/programs.js'

export { pickWin32ExecutableLine }


type BunWhich = { which?: (command: string, options?: { PATH?: string }) => string | null }

function bunWhich(command: string): string | null | undefined {
  if (typeof Bun !== 'undefined' && typeof (Bun as BunWhich).which === 'function') {
    return (Bun as Required<BunWhich>).which(command, { PATH: hostEnv().PATH ?? '' })
  }
  return undefined
}

function normalize(result: string | null): string | null {
  if (result === null) return null
  const trimmed = result.trim()
  return trimmed === '' ? null : trimmed
}

export function spawnableSpellings(command: string, platform: string = process.platform): string[] {
  return spawnableCommandSpellings(command, platform)
}

export interface LookupWorld {
  platform: string
  path: string
}

export function hostLookupWorld(): LookupWorld {
  return { platform: process.platform, path: hostEnv().PATH ?? '' }
}

export function resolveExecutable(command: string, world: LookupWorld = hostLookupWorld()): string | null {
  return resolveProgramInPath(command, world.path, world.platform)
}

const foundExecutables = new Map<string, string>()

const KEY_JOIN = String.fromCharCode(0)

function foundKey(command: string): string {
  return `${command}${KEY_JOIN}${hostEnv().PATH ?? ''}`
}

export function whichSync(command: string): string | null {
  const fromBun = bunWhich(command)
  if (fromBun !== undefined) return normalize(fromBun)

  const key = foundKey(command)
  const cached = foundExecutables.get(key)
  if (cached !== undefined) return cached

  const found = resolveExecutable(command)
  if (found !== null) foundExecutables.set(key, found)
  return found
}

export async function which(command: string): Promise<string | null> {
  return whichSync(command)
}
