import { realpath, lstat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

export class PathTraversalError extends Error {
  override name = 'PathTraversalError'
}

export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_herring_clock', false)
}

export function getTeamMemPath(): string {
  return `${join(getAutoMemPath(), 'team')}${sep}`.normalize('NFC')
}

export function getTeamMemEntrypoint(): string {
  return `${getTeamMemPath()}MEMORY.md`
}

export function getScribeMemPath(): string {
  return `${join(getAutoMemPath(), 'scribe')}${sep}`.normalize('NFC')
}

export function getScribeMemEntrypoint(): string {
  return `${getScribeMemPath()}MEMORY.md`
}

export function isTeamMemFile(filePath: string): boolean {
  if (!isTeamMemoryEnabled()) return false
  return resolve(filePath).startsWith(getTeamMemPath())
}

async function realpathDeepestExisting(target: string): Promise<string> {
  let current = target
  let tail = ''
  for (;;) {
    try {
      const real = await realpath(current)
      return tail === '' ? real : join(real, tail)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') {
        try {
          const stat = await lstat(current)
          if (stat.isSymbolicLink()) {
            throw new PathTraversalError(`Dangling symlink at ${current}`)
          }
        } catch (lstatError) {
          if (lstatError instanceof PathTraversalError) throw lstatError
        }
      } else if (code === 'ELOOP') {
        throw new PathTraversalError(`Symlink loop at ${current}`)
      } else if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
      } else {
        throw new PathTraversalError(
          `Cannot resolve ${current}: ${(error as Error).message}`,
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail = tail === '' ? basename(current) : join(basename(current), tail)
      current = parent
    }
  }
}

async function isReallyContained(candidateReal: string): Promise<boolean> {
  const teamDir = getTeamMemPath().replace(/[\\/]+$/, '')
  let teamReal: string
  try {
    teamReal = await realpath(teamDir)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return true
    return false
  }
  if (candidateReal === teamReal) return true
  return candidateReal.startsWith(`${teamReal}${sep}`)
}

async function runTwoPassCheck(resolved: string, described: string): Promise<string> {
  if (!resolved.startsWith(getTeamMemPath())) {
    throw new PathTraversalError(`${described} escapes the team memory directory`)
  }
  const real = await realpathDeepestExisting(resolved)
  if (!(await isReallyContained(real))) {
    throw new PathTraversalError(`${described} escapes the team memory directory via a symlink`)
  }
  return resolved
}

export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  if (relativeKey.includes('\0')) {
    throw new PathTraversalError('Team memory key contains a NUL byte')
  }
  let decoded = relativeKey
  try {
    decoded = decodeURIComponent(relativeKey)
  } catch {
  }
  if (decoded !== relativeKey && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError('Team memory key hides a traversal behind percent-encoding')
  }
  const normalized = relativeKey.normalize('NFKC')
  if (
    normalized !== relativeKey &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError('Team memory key hides a traversal behind a look-alike codepoint')
  }
  if (relativeKey.includes('\\')) {
    throw new PathTraversalError('Team memory key contains a backslash')
  }
  if (relativeKey.startsWith('/')) {
    throw new PathTraversalError('Team memory key is absolute')
  }
  const resolved = resolve(join(getTeamMemPath(), relativeKey))
  return runTwoPassCheck(resolved, `Key ${relativeKey}`)
}

export async function validateTeamMemWritePath(filePath: string): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError('Team memory path contains a NUL byte')
  }
  const resolved = resolve(filePath)
  return runTwoPassCheck(resolved, `Path ${filePath}`)
}
