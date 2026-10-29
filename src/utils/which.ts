import { accessSync, constants, statSync } from 'node:fs'
import * as path from 'node:path'

type BunWhich = { which?: (command: string, options?: { PATH?: string }) => string | null }

function bunWhich(command: string): string | null | undefined {
  if (typeof Bun !== 'undefined' && typeof (Bun as BunWhich).which === 'function') {
    return (Bun as Required<BunWhich>).which(command, { PATH: process.env.PATH ?? '' })
  }
  return undefined
}

function normalize(result: string | null): string | null {
  if (result === null) return null
  const trimmed = result.trim()
  return trimmed === '' ? null : trimmed
}

const WIN32_SPAWNABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

export function spawnableSpellings(command: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [command]
  return [...WIN32_SPAWNABLE_EXTENSIONS.map(ext => `${command}${ext}`), command]
}

function isSpawnableSpelling(line: string): boolean {
  const lower = line.toLowerCase()
  return WIN32_SPAWNABLE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export function pickWin32ExecutableLine(lines: readonly string[]): string | null {
  const listed = lines.map(line => line.trim()).filter(line => line !== '')
  const spawnable = listed.find(isSpawnableSpelling)
  return spawnable ?? listed[0] ?? null
}

export interface LookupWorld {
  platform: string
  path: string
}

export function hostLookupWorld(): LookupWorld {
  return { platform: process.platform, path: process.env.PATH ?? '' }
}

function searchDirs(world: LookupWorld): string[] {
  const entries = world.path.split(world.platform === 'win32' ? ';' : ':')
  if (world.platform === 'win32') return entries.filter(entry => entry !== '')
  return entries.map(entry => (entry === '' ? '.' : entry))
}

function isExecutableFile(candidate: string, platform: string): boolean {
  try {
    if (platform !== 'win32') accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function hasDirectoryPart(command: string, platform: string): boolean {
  return command.includes('/') || (platform === 'win32' && command.includes('\\'))
}

export function resolveExecutable(command: string, world: LookupWorld = hostLookupWorld()): string | null {
  if (command === '') return null
  const spellings = spawnableSpellings(command, world.platform)
  if (hasDirectoryPart(command, world.platform)) {
    for (const spelling of spellings) {
      const candidate = path.resolve(spelling)
      if (isExecutableFile(candidate, world.platform)) return candidate
    }
    return null
  }
  if (world.platform === 'win32') {
    const listed: string[] = []
    for (const dir of searchDirs(world)) {
      for (const spelling of spellings) {
        const candidate = path.resolve(dir, spelling)
        if (isExecutableFile(candidate, world.platform)) listed.push(candidate)
      }
      if (listed.some(isSpawnableSpelling)) break
    }
    return pickWin32ExecutableLine(listed)
  }
  for (const dir of searchDirs(world)) {
    const candidate = path.resolve(dir, command)
    if (isExecutableFile(candidate, world.platform)) return candidate
  }
  return null
}

const foundExecutables = new Map<string, string>()

const KEY_JOIN = String.fromCharCode(0)

function foundKey(command: string): string {
  return `${command}${KEY_JOIN}${process.env.PATH ?? ''}`
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
