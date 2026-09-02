import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

import { execFileNoThrow } from './execFileNoThrow.js'

/**
 * Executable lookup on PATH, async and sync, each returning the absolute
 * path or null. Never throws; never returns an empty string.
 *
 * Under Bun both exports resolve through the runtime's built-in lookup.
 * CRITICAL: Bun snapshots the environment at startup, so PATH is passed
 * explicitly from process.env.PATH on every call — the self-healing
 * search-availability logic and env-manipulating proofs depend on a
 * mid-process PATH mutation being visible.
 */

type BunWhich = { which?: (command: string, options?: { PATH?: string }) => string | null }

/** undefined = no Bun lookup available; otherwise the (possibly null) result. */
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

/**
 * The spellings the process launcher can actually run on Windows, most
 * direct first: .exe and .com spawn as-is; .cmd and .bat need the batch-shim
 * shell ride the language-server client keys on that suffix. An
 * extensionless entry is a POSIX script — npm writes one beside every
 * <name>.cmd for git-bash — and spawns ENOENT under node (libuv appends
 * .com/.exe and never tries the bare path), so it is the last resort.
 */
const WIN32_SPAWNABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

/** The probe order for one command name: every spawnable spelling ahead of
 *  the bare name on win32, the bare name alone elsewhere. */
export function spawnableSpellings(command: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [command]
  return [...WIN32_SPAWNABLE_EXTENSIONS.map(ext => `${command}${ext}`), command]
}

/**
 * The where.exe line worth spawning. where.exe lists EVERY match on PATH,
 * and for an npm-delivered tool the extensionless shim precedes its .cmd
 * sibling in the same directory — so the first line outright was an
 * ENOENT-shaped spawn for every npm language server on Windows (FN-015
 * rank 18). The first line carrying a spawnable extension wins, in PATH
 * order (where.exe order IS cmd.exe order); when nothing spawnable was
 * listed the bare first line stays the answer, as before. Exported for the
 * unit pin: the win32 arm cannot run on a POSIX host.
 */
export function pickWin32ExecutableLine(lines: readonly string[]): string | null {
  const listed = lines.map(line => line.trim()).filter(line => line !== '')
  const spawnable = listed.find(line => {
    const lower = line.toLowerCase()
    return WIN32_SPAWNABLE_EXTENSIONS.some(ext => lower.endsWith(ext))
  })
  return spawnable ?? listed[0] ?? null
}

// Per-process cache of FOUND binaries, keyed by command AND the live PATH so
// a mid-process PATH mutation stays visible (the documented contract above).
// Misses are never cached: the self-healing availability probes depend on a
// binary appearing under an unchanged PATH being seen, while the repeated
// where.exe/which spawns for already-found binaries — the hot path on
// Windows subprocess launches — collapse to a Map hit.
const foundExecutables = new Map<string, string>()

function foundKey(command: string): string {
  // NUL joins unambiguously - neither a command nor PATH can contain it.
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
