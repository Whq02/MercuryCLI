import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { rememberedPlatform } from './platform/host.js'
import { msysDrivePathToNative, normalizeLocalDevicePath } from './platform/paths.js'
import { uncPathRisk } from './permissions/uncPath.js'
import { passedOver } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'

export { sanitizePath } from './sessionStoragePortable.js'


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

export function expandPath(path: string, baseDir?: string): string {
  return notBuilt('src/utils/path.ts:41')
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
  return notBuilt('src/utils/path.ts:64')
}

export function getDirectoryForPath(path: string): string {
  return notBuilt('src/utils/path.ts:70')
}

export function containsPathTraversal(path: string): boolean {
  return notBuilt('src/utils/path.ts:81')
}

export function normalizePathForConfigKey(path: string): string {
  return notBuilt('src/utils/path.ts:85')
}
