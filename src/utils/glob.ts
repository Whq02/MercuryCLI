import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { statSync } from 'node:fs'
import { resolveRelativePatternPrefix } from './globPrefix.js'

import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { globSearchDepth, normalizeGlobPattern } from './globPattern.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
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
): Promise<{ files: string[]; truncated: boolean; ignored: number; incomplete?: string }> {
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

  const givenSearchDir = resolve(searchDir)
  searchDir = safeResolvePath(getFsImplementation(), givenSearchDir).resolvedPath
  const args = ['--files', '--glob', normalizeGlobPattern(pattern), '--sortr=modified', '--no-ignore']
  const universeArgs = ['--files', '--sortr=modified']
  const depth = globSearchDepth([normalizeGlobPattern(pattern)])
  if (depth !== undefined) {
    args.push('--max-depth', String(depth))
    universeArgs.push('--max-depth', String(depth))
  }
  if (envFlagDefaultOn('MERCURY_GLOB_HIDDEN')) {
    args.push('--hidden')
    universeArgs.push('--hidden')
  }

  const ignoreByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  const relativeRules = ignoreByRoot.get(null) ?? []
  const sessionRoot = safeResolvePath(getFsImplementation(), process.cwd()).resolvedPath
  ignoreByRoot.set(null, relativeRules.filter(pattern => !pattern.includes('/')))
  ignoreByRoot.set(sessionRoot, [...(ignoreByRoot.get(sessionRoot) ?? []), ...relativeRules.filter(pattern => pattern.includes('/'))])
  let walkRoot = searchDir
  try { if (!statSync(walkRoot).isDirectory()) walkRoot = dirname(walkRoot) } catch {}
  const ignores = normalizePatternsToPath(ignoreByRoot as never, walkRoot)
  for (const ignore of ignores) {
    args.push('--iglob', `!${ignore}`)
    universeArgs.push('--iglob', `!${ignore}`)
  }

  const anchor = { cwd: walkRoot }
  const matches = await ripGrepAnswer(args, searchDir, abortSignal, anchor)
  const universe = await ripGrepAnswer(universeArgs, searchDir, abortSignal, anchor)
  const listed = new Set(universe.lines)
  const kept = matches.lines.filter(entry => listed.has(entry))
  const complete = matches.complete && universe.complete
  const files = kept.map(entry => (isAbsolute(entry) ? entry : resolve(join(searchDir, entry))))
    .map(file => resolve(givenSearchDir, relative(searchDir, file)))
  const truncated = files.length > offset + limit
  return {
    files: files.slice(offset, offset + limit),
    truncated,
    ignored: complete ? matches.lines.length - kept.length : 0,
    ...(complete ? {} : { incomplete: (matches.complete ? universe.reason : matches.reason) ?? 'the search did not finish' }),
  }
}
