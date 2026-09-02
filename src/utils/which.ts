import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { execFileNoThrow } from './execFileNoThrow.js'


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

export function pickWin32ExecutableLine(lines: readonly string[]): string | null {
  const listed = lines.map(line => line.trim()).filter(line => line !== '')
  const spawnable = listed.find(line => {
    const lower = line.toLowerCase()
    return WIN32_SPAWNABLE_EXTENSIONS.some(ext => lower.endsWith(ext))
  })
  return spawnable ?? listed[0] ?? null
}

const foundExecutables = new Map<string, string>()

function foundKey(command: string): string {
  return `${command}\u0000${process.env.PATH ?? ''}`
}

export async function which(command: string): Promise<string | null> {
  const fromBun = bunWhich(command)
  if (fromBun !== undefined) return normalize(fromBun)

  const key = foundKey(command)
  const cached = foundExecutables.get(key)
  if (cached !== undefined) return cached

  if (process.platform === 'win32') {
    const result = await execFileNoThrow('where.exe', [command])
    if (result.code !== 0) return null
    const path = pickWin32ExecutableLine(result.stdout.split(/\r?\n/))
    if (path !== null) foundExecutables.set(key, path)
    return path
  }
  const result = await execFileNoThrow('which', [command])
  if (result.code !== 0) return null
  const path = normalize(result.stdout)
  if (path !== null) foundExecutables.set(key, path)
  return path
}

export function whichSync(command: string): string | null {
  const fromBun = bunWhich(command)
  if (fromBun !== undefined) return normalize(fromBun)

  const key = foundKey(command)
  const cached = foundExecutables.get(key)
  if (cached !== undefined) return cached

  try {
    if (process.platform === 'win32') {
      const result = spawnSync('where.exe', [command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5_000, env: { ...subprocessEnv() } })
      if (result.status !== 0 || !result.stdout) return null
      const path = pickWin32ExecutableLine(result.stdout.split(/\r?\n/))
      if (path !== null) foundExecutables.set(key, path)
      return path
    }
    const result = spawnSync('which', [command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5_000, env: { ...subprocessEnv() } })
    if (result.status !== 0 || !result.stdout) return null
    const path = normalize(result.stdout)
    if (path !== null) foundExecutables.set(key, path)
    return path
  } catch {
    return null
  }
}
