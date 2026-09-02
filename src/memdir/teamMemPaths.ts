// ============================================================================
//  src/memdir/teamMemPaths.ts — the team scope path and symlink-safe
//  write-path validation. The validators return the PATH-RESOLVED absolute
//  path, not the symlink-resolved one — the real path is computed for the
//  containment check and then discarded.
// ============================================================================
import { realpath, lstat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/** All rejections use this one type, distinguishable by class and name. */
export class PathTraversalError extends Error {
  override name = 'PathTraversalError'
}

/**
 * Team memory requires auto memory (checked first) and then the
 * `mercury_herring_clock` feature flag (default false — in this build it
 * resolves to its default through the empty gate table, so the predicate is
 * constant false and every team-memory consumer is dormant; the validators
 * below stay live because their callers do not gate on this).
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_herring_clock', false)
}

/** `<autoMemDir>/team/` — trailing separator, NFC. */
export function getTeamMemPath(): string {
  return `${join(getAutoMemPath(), 'team')}${sep}`.normalize('NFC')
}

export function getTeamMemEntrypoint(): string {
  return `${getTeamMemPath()}MEMORY.md`
}

/** Team memory enabled AND the path is inside the team directory. */
export function isTeamMemFile(filePath: string): boolean {
  if (!isTeamMemoryEnabled()) return false
  return resolve(filePath).startsWith(getTeamMemPath())
}

/**
 * Deepest-existing-ancestor resolution: walk upward from a target that may
 * not exist yet, rejoining the non-existing tail onto the first ancestor
 * that resolves. A DANGLING symlink anywhere on the way throws (a write
 * would follow it and create the target outside the directory); a symlink
 * loop throws; not-a-directory and name-too-long keep walking; any other
 * error (permission, I/O) fails closed with the same traversal error so a
 * caller can skip one entry instead of aborting a batch. Reaching the
 * filesystem root returns the input — the containment check then rejects.
 */
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
        // Distinguish a truly absent path (safe) from a dangling symlink.
        try {
          const stat = await lstat(current)
          if (stat.isSymbolicLink()) {
            throw new PathTraversalError(`Dangling symlink at ${current}`)
          }
          // A non-symlink lstat success with an ENOENT realpath means the
          // dangling link sits in an ancestor — keep walking to find it.
        } catch (lstatError) {
          if (lstatError instanceof PathTraversalError) throw lstatError
          // Truly absent — keep walking upward.
        }
      } else if (code === 'ELOOP') {
        throw new PathTraversalError(`Symlink loop at ${current}`)
      } else if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
        // Keep walking.
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

/**
 * Real-containment: resolve the team directory (trailing separator
 * stripped — some platforms reject them). Missing or not-a-directory team
 * dir → TRUE, skipping the check (safe: a symlink escape needs a
 * pre-existing symlink inside the directory, which needs the directory to
 * exist). Any other error → false (fail closed). Equality passes; otherwise
 * the candidate must start with the real directory PLUS a separator so a
 * sibling prefix cannot match.
 */
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
  // Pass one (string level): the team directory carries its trailing
  // separator, so a sibling like `team-evil/` cannot match.
  if (!resolved.startsWith(getTeamMemPath())) {
    throw new PathTraversalError(`${described} escapes the team memory directory`)
  }
  // Pass two (filesystem level): resolve() does not follow symlinks, so a
  // symlink planted inside the team directory pointing outside would pass
  // pass one alone.
  const real = await realpathDeepestExisting(resolved)
  if (!(await isReallyContained(real))) {
    throw new PathTraversalError(`${described} escapes the team memory directory via a symlink`)
  }
  return resolved
}

/**
 * Key validator for a server-supplied relative key. Sanitization order:
 * reject NUL; percent-decode (malformed encodings treated literal) and
 * reject when decoding changed the string AND the decoded form contains
 * `..` or `/`; NFKC-normalize and reject when normalization changed the
 * string and the normalized form contains `..`, `/`, `\` or NUL (full-width
 * look-alike separators); reject a backslash anywhere; reject a leading `/`.
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  if (relativeKey.includes('\0')) {
    throw new PathTraversalError('Team memory key contains a NUL byte')
  }
  let decoded = relativeKey
  try {
    decoded = decodeURIComponent(relativeKey)
  } catch {
    // Malformed encoding is treated as literal.
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

/** Path validator for an absolute path: reject NUL, resolve, two-pass check. */
export async function validateTeamMemWritePath(filePath: string): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError('Team memory path contains a NUL byte')
  }
  const resolved = resolve(filePath)
  return runTwoPassCheck(resolved, `Path ${filePath}`)
}
