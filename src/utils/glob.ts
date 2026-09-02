import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveRelativePatternPrefix } from './globPrefix.js'

import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { normalizeGlobPattern } from './globPattern.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { ripGrepAnswer } from './ripgrep.js'


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
    const rewritten = resolveRelativePatternPrefix(searchDir, pattern)
    searchDir = rewritten.searchDir
    pattern = rewritten.pattern
  }

  const args = ['--files', '--glob', normalizeGlobPattern(pattern), '--sortr=modified']
  if (envFlagDefaultOn('MERCURY_GLOB_NO_IGNORE')) args.push('--no-ignore')
  if (envFlagDefaultOn('MERCURY_GLOB_HIDDEN')) args.push('--hidden')

  const ignoreByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  for (const ignore of normalizePatternsToPath(ignoreByRoot as never, searchDir)) {
    args.push('--glob', `!${ignore}`)
  }

  const answer = await ripGrepAnswer(args, searchDir, abortSignal)
  const files = answer.lines.map(entry => (isAbsolute(entry) ? entry : resolve(join(searchDir, entry))))
  const truncated = files.length > offset + limit
  return {
    files: files.slice(offset, offset + limit),
    truncated,
    ...(answer.complete ? {} : { incomplete: answer.reason ?? 'the search did not finish' }),
  }
}
