import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

export { sanitizePath } from './sessionStoragePortable.js'


function defaultBaseDir(): string {
  try {
    return getCwd()
  } catch {
    return process.cwd()
  }
}

const POSIX_DRIVE_PREFIX = /^\/[a-zA-Z]\//

export function expandPath(path: string, baseDir: string = defaultBaseDir()): string {
  if (typeof path !== 'string') throw new TypeError(`expandPath: expected a string path, received ${typeof path}`)
  if (typeof baseDir !== 'string') throw new TypeError(`expandPath: expected a string base directory, received ${typeof baseDir}`)
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

export function toRelativePath(absolutePath: string): string {
  const rel = relative(defaultBaseDir(), absolutePath)
  if (rel.startsWith('..')) return absolutePath
  return rel
}

export function toTildePath(absolutePath: string): string {
  const rel = relative(homedir(), absolutePath)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel}`
  return absolutePath
}

export function getDirectoryForPath(path: string): string {
  const expanded = expandPath(path)
  if (expanded.startsWith('\\\\') || expanded.startsWith('//')) return dirname(expanded)
  try {
    if (getFsImplementation().statSync(expanded).isDirectory()) return expanded
  } catch {
  }
  return dirname(expanded)
}

export function containsPathTraversal(path: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(path)
}

export function normalizePathForConfigKey(path: string): string {
  const key = normalize(path).replace(/\\/g, '/')
  return key.replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
}
