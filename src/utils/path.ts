import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

export { sanitizePath } from './sessionStoragePortable.js'

/**
 * Path expansion, relativisation, tilde display and traversal checks. Every
 * expansion result is NFC-normalised and in the platform's native form.
 */

function defaultBaseDir(): string {
  try {
    return getCwd()
  } catch {
    return process.cwd()
  }
}

/**
 * A single-letter POSIX drive prefix, `/x/…` forms only, case-insensitive.
 * A bare `/x` with nothing after the letter is NOT a drive form.
 */
const POSIX_DRIVE_PREFIX = /^\/[a-zA-Z]\//

export function expandPath(path: string, baseDir: string = defaultBaseDir()): string {
  if (typeof path !== 'string') throw new TypeError(`expandPath: expected a string path, received ${typeof path}`)
  if (typeof baseDir !== 'string') throw new TypeError(`expandPath: expected a string base directory, received ${typeof baseDir}`)
  // NUL truncation is a classic path-confusion vector.
  if (path.includes('\0') || baseDir.includes('\0')) throw new Error('Path contains null bytes')
  if (path.trim() === '') return normalize(baseDir).normalize('NFC')
  const trimmed = path.trim()
  if (trimmed === '~') return homedir().normalize('NFC')
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2)).normalize('NFC')
  let candidate = trimmed
  if (getPlatform() === 'windows' && POSIX_DRIVE_PREFIX.test(candidate)) {
    try {
      candidate = posixPathToWindowsPath(candidate) as string
    } catch {
      candidate = trimmed
    }
  }
  if (isAbsolute(candidate)) return normalize(candidate).normalize('NFC')
  return resolve(baseDir, candidate).normalize('NFC')
}

/** Relative to the working directory for tool output; an escaping path stays absolute so it stays unambiguous. */
export function toRelativePath(absolutePath: string): string {
  const rel = relative(defaultBaseDir(), absolutePath)
  if (rel.startsWith('..')) return absolutePath
  return rel
}

/**
 * Expansion run backwards, for display: any label naming a home-relative
 * location is derived from the home the process actually resolved, so label
 * and file can never disagree.
 */
export function toTildePath(absolutePath: string): string {
  const rel = relative(homedir(), absolutePath)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel}`
  return absolutePath
}

/** Skips all filesystem access for UNC paths — touching them can leak credentials to a remote host. */
export function getDirectoryForPath(path: string): string {
  const expanded = expandPath(path)
  if (expanded.startsWith('\\\\') || expanded.startsWith('//')) return dirname(expanded)
  try {
    if (getFsImplementation().statSync(expanded).isDirectory()) return expanded
  } catch {
    // Nonexistent or inaccessible: the parent.
  }
  return dirname(expanded)
}

/** A `..` component bounded by separators or the string ends, on either separator style; `a..b` does not count. */
export function containsPathTraversal(path: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(path)
}

/** The same location produces the same JSON key regardless of where the path came from. */
export function normalizePathForConfigKey(path: string): string {
  const key = normalize(path).replace(/\\/g, '/')
  // One folder, one key: Windows reports the drive letter in whichever case
  // the launcher used, so a trust grant recorded from C:\proj did not cover
  // a launch from c:\proj — two project records for one folder (TASK-014
  // w5-f10-04). The fold applies to the drive-letter spelling wherever it
  // appears (the key namespace is per machine), so it proves on any host.
  return key.replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
}
