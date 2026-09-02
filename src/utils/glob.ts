import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveRelativePatternPrefix } from './globPrefix.js'

import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { normalizeGlobPattern } from './globPattern.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { ripGrepAnswer } from './ripgrep.js'

/**
 * Glob search over the workspace via the vendored ripgrep.
 */

/**
 * Split an absolute pattern into its static base directory and the
 * remaining relative pattern: with no glob metacharacter the pattern is a
 * literal path (directory plus file name); with one, take the static prefix
 * and split at its last separator — `/` plus the PLATFORM separator only, a
 * backslash is not a separator on POSIX. No separator means relative to the
 * working directory, a separator at index zero means the filesystem root,
 * and on Windows a bare drive designator gains a separator (a bare drive
 * means "current directory on that drive", not its root).
 */
function lastSeparatorIndex(value: string): number {
  const slashIndex = value.lastIndexOf('/')
  if (sep === '/') return slashIndex
  return Math.max(slashIndex, value.lastIndexOf(sep))
}

export function extractGlobBaseDirectory(pattern: string): { baseDir: string; relativePattern: string } {
  const metaIndex = pattern.search(/[*?[{]/)
  if (metaIndex === -1) {
    const lastSep = lastSeparatorIndex(pattern)
    if (lastSep === -1) {
      // The relative literal case bases at the platform "current directory"
      // token — the directory-name helper's answer — not the empty string.
      return { baseDir: dirname(pattern), relativePattern: pattern }
    }
    return {
      baseDir: fixDrive(pattern.slice(0, Math.max(1, lastSep))),
      relativePattern: pattern.slice(lastSep + 1),
    }
  }
  const staticPrefix = pattern.slice(0, metaIndex)
  const lastSep = lastSeparatorIndex(staticPrefix)
  if (lastSep === -1) return { baseDir: '', relativePattern: pattern }
  if (lastSep === 0) return { baseDir: pattern[0] as string, relativePattern: pattern.slice(1) }
  return {
    baseDir: fixDrive(staticPrefix.slice(0, lastSep)),
    relativePattern: pattern.slice(lastSep + 1),
  }
}

function fixDrive(baseDir: string): string {
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) return `${baseDir}\\`
  return baseDir
}

// The variables default to enabled: an unset OR empty value is replaced by
// the literal enabling value before decoding, so empty counts as unset;
// any value outside the truthy set turns the flag off.
function envFlagDefaultOn(name: string): boolean {
  const raw = process.env[name]
  return isEnvTruthy(raw === undefined || raw === '' ? '1' : raw)
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean; incomplete?: string }> {
  let searchDir = cwd
  let pattern = filePattern
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      pattern = relativePattern
    }
  } else {
    // The link-prefix accommodation (FC-088) — see utils/globPrefix.ts.
    const rewritten = resolveRelativePatternPrefix(searchDir, pattern)
    searchDir = rewritten.searchDir
    pattern = rewritten.pattern
  }

  // Ripgrep's own flags: list files, the pattern glob (through the one
  // separator door — a backslash-spelled pattern matched nothing on win32,
  // FN-015 rank 9), modified-time sort NEWEST FIRST (--sortr is rg's
  // descending sort; bare --sort is ASCENDING — the tool's own description
  // promises "newest modification first", and past the result cap the
  // ascending sort handed the operator the 100 OLDEST matches labelled
  // newest-on-top, FC-089), and the two env-gated toggles.
  const args = ['--files', '--glob', normalizeGlobPattern(pattern), '--sortr=modified']
  if (envFlagDefaultOn('MERCURY_GLOB_NO_IGNORE')) args.push('--no-ignore')
  if (envFlagDefaultOn('MERCURY_GLOB_HIDDEN')) args.push('--hidden')

  // Read-ignore patterns normalised against the search directory, negated.
  const ignoreByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  for (const ignore of normalizePatternsToPath(ignoreByRoot as never, searchDir)) {
    args.push('--glob', `!${ignore}`)
  }

  // The answer carries its own completeness: a walk cut off by its deadline
  // or an engine failure must never render as a finished search with fewer
  // files (FN-015 rank 10).
  const answer = await ripGrepAnswer(args, searchDir, abortSignal)
  const files = answer.lines.map(entry => (isAbsolute(entry) ? entry : resolve(join(searchDir, entry))))
  const truncated = files.length > offset + limit
  return {
    files: files.slice(offset, offset + limit),
    truncated,
    ...(answer.complete ? {} : { incomplete: answer.reason ?? 'the search did not finish' }),
  }
}
