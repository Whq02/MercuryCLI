import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from '../environment/platform.js'
import { rememberedPlatform } from '../host-os/host.js'
import { msysDrivePathToNative, normalizeLocalDevicePath } from '../host-os/paths.js'
import { uncPathRisk } from '../../permissions/rules/uncPath.js'
import { passedOver } from '../errors/passedOver.js'

export { sanitizePath } from '../../sessions/transcripts/sessionStoragePortable.js'


function defaultBaseDir(): string {
  try {
    return getCwd()
  } catch {
    return process.cwd()
  }
}

export const NUL_PATH_MESSAGE = 'Path contains null bytes'
export const CONTROL_PATH_MESSAGE = 'Path contains control characters'
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export function hasNulByte(path: string): boolean {
  return path.includes('\0')
}

export function hasControlCharacter(path: string): boolean {
  return CONTROL_CHARACTER.test(path)
}

export function controlCharacterPathRefusal(path: string | undefined): string | null {
  if (path === undefined) return null
  if (hasNulByte(path)) return NUL_PATH_MESSAGE
  return hasControlCharacter(path) ? CONTROL_PATH_MESSAGE : null
}

export function expandPath(path: string, baseDir: string = defaultBaseDir()): string {
  if (typeof path !== 'string') throw new TypeError(`expandPath: expected a string path, received ${typeof path}`)
  if (typeof baseDir !== 'string') throw new TypeError(`expandPath: expected a string base directory, received ${typeof baseDir}`)
  if (hasNulByte(path) || hasNulByte(baseDir)) throw new Error(NUL_PATH_MESSAGE)
  const text = path.trim()
  if (!text) return normalize(baseDir).normalize('NFC')
  if (text === '~') return homedir().normalize('NFC')
  if (text.startsWith('~/')) return join(homedir(), text.slice(2)).normalize('NFC')
  const native = msysDrivePathToNative(text, false, rememberedPlatform())
  return (isAbsolute(native) ? normalize(native) : resolve(baseDir, native)).normalize('NFC')
}

export function localPath(path: string, platform: ReturnType<typeof getPlatform> = getPlatform()): string {
  return normalizeLocalDevicePath(path, platform)
}

export function toRelativePath(absolutePath: string): string {
  const rel = relative(defaultBaseDir(), absolutePath)
  if (rel.startsWith('..')) return absolutePath
  return rel
}

export function toTildePath(absolutePath: string): string {
  const rel = relative(homedir(), absolutePath)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}` : absolutePath
}

export function getDirectoryForPath(path: string): string {
  const expanded = expandPath(path)
  if (uncPathRisk(path).risky || expanded.startsWith('\\\\') || expanded.startsWith('//')) return dirname(expanded)
  try {
    if (getFsImplementation().statSync(expanded).isDirectory()) return expanded
  } catch (error) {
    passedOver(error)
  }
  return dirname(expanded)
}

export function containsPathTraversal(path: string): boolean {
  return path.split(/[\\/]/).includes('..')
}

export function normalizePathForConfigKey(path: string): string {
  return normalize(path).replaceAll('\\', '/').replace(/^[a-z]:\//, drive => drive.toUpperCase())
}
