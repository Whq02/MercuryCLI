import { dirname, isAbsolute, relative, sep } from 'node:path'
import { statSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { resolveRelativePatternPrefix } from './globPrefix.js'

import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import { globSearchDepth, normalizeGlobPattern, resolveSearchGlob } from './globPattern.js'
import { getFileReadIgnorePatterns, normalizePatternsToPath, readDenialFilter } from './permissions/filesystem.js'
import { ensureDriveRootSeparator } from './platform/paths.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { ripGrepAnswer } from './ripgrep.js'
import { passedOver } from './passedOver.js'

function lastSeparatorIndex(value: string): number {
  const slashIndex = value.lastIndexOf('/')
  if (sep === '/') return slashIndex
  return Math.max(slashIndex, value.lastIndexOf(sep))
}

export function extractGlobBaseDirectory(pattern: string): { baseDir: string; relativePattern: string } {
  const metaIndex = pattern.search(/[*?[{]/)
  const staticPrefix = metaIndex === -1 ? pattern : pattern.slice(0, metaIndex)
  const sepIndex = lastSeparatorIndex(staticPrefix)
  if (sepIndex === -1) {
    return {
      baseDir: metaIndex === -1 ? dirname(pattern) : '',
      relativePattern: pattern,
    }
  }
  if (sepIndex === 0) {
    return { baseDir: pattern.slice(0, 1), relativePattern: pattern.slice(1) }
  }
  return {
    baseDir: fixDrive(pattern.slice(0, sepIndex)),
    relativePattern: pattern.slice(sepIndex + 1),
  }
}

function fixDrive(baseDir: string): string {
  return ensureDriveRootSeparator(baseDir)
}

function envFlagDefaultOn(name: string): boolean {
  const raw = flagEnv(name)
  return isEnvTruthy(raw === undefined || raw === '' ? '1' : raw)
}

function sampleAcrossTopLevel(files: string[], root: string, limit: number, offset: number): string[] {
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const key = relative(root, file).split(sep)[0]!
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }
  let active = [...groups.values()].map(group => group.values())
  const selected = new Set<string>()
  let count = 0
  while (active.length && count < offset + limit) {
    const next: typeof active = []
    for (const group of active) {
      const item = group.next()
      if (item.done) continue
      if (count >= offset) selected.add(item.value)
      count++
      next.push(group)
      if (count >= offset + limit) break
    }
    active = next
  }
  return files.filter(file => selected.has(file))
}

export async function glob(
  filePattern: string,
  cwd: string,
  arg2: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean; ignored: number; incomplete?: string }> {
  let searchDir = cwd
  let rawPattern = filePattern
  if (isAbsolute(rawPattern)) {
    const extracted = extractGlobBaseDirectory(rawPattern)
    if (extracted.baseDir) {
      searchDir = extracted.baseDir
      rawPattern = extracted.relativePattern || '**/*'
    }
  }

  const normalizedPattern = normalizeGlobPattern(rawPattern).replace(/^\.\//, '')
  const prefixed = resolveRelativePatternPrefix(searchDir, normalizedPattern)
  searchDir = prefixed.searchDir
  const pattern = prefixed.pattern

  const resolvedTarget = safeResolvePath(getFsImplementation(), searchDir)
  const canonicalTarget = resolvedTarget.isCanonical ? resolvedTarget.resolvedPath : searchDir

  let isFileTarget = false
  try {
    isFileTarget = statSync(canonicalTarget).isFile()
  } catch (error) {
    passedOver(error)
  }

  const rgCwd = isFileTarget ? dirname(canonicalTarget) : canonicalTarget
  const resolvedGlobs = resolveSearchGlob(pattern, rgCwd, false)
  const maxDepth = globSearchDepth(resolvedGlobs)

  const sharedPrefix: string[] = ['--files']
  if (envFlagDefaultOn('MERCURY_GLOB_HIDDEN')) {
    sharedPrefix.push('--hidden')
  }
  if (maxDepth !== undefined) {
    sharedPrefix.push('--max-depth', String(maxDepth))
  }

  const ignoreByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  const ignorePatterns = new Set<string>(normalizePatternsToPath(ignoreByRoot, rgCwd))
  const suppliedCwd = isFileTarget ? dirname(searchDir) : searchDir
  if (suppliedCwd !== rgCwd) {
    for (const ignorePattern of normalizePatternsToPath(ignoreByRoot, suppliedCwd)) {
      ignorePatterns.add(ignorePattern)
    }
  }
  const unrootedIgnores = ignoreByRoot.get(null)
  if (unrootedIgnores !== undefined && unrootedIgnores.length > 0) {
    const processCwd = process.cwd()
    const procResolved = safeResolvePath(getFsImplementation(), processCwd).resolvedPath
    for (const rootCandidate of procResolved === processCwd ? [processCwd] : [processCwd, procResolved]) {
      const rel = relative(rootCandidate, rgCwd)
      if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        for (const ignorePattern of normalizePatternsToPath(new Map([[rootCandidate, unrootedIgnores]]), rgCwd)) {
          ignorePatterns.add(ignorePattern)
        }
      }
    }
  }

  const sharedExcludes: string[] = []
  for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
    sharedExcludes.push('--glob', `!**/${dir}`, '--glob', `!**/${dir}/**`)
  }
  for (const ignorePattern of ignorePatterns) {
    sharedExcludes.push('--iglob', ignorePattern.startsWith('/') ? `!${ignorePattern}` : `!**/${ignorePattern}`)
  }

  const matchArgs = [
    '--sortr=modified',
    '--no-ignore',
    ...sharedPrefix,
    ...resolvedGlobs.flatMap(resolvedGlob => ['--glob', resolvedGlob]),
    ...sharedExcludes,
  ]
  const universeArgs = [...sharedPrefix, ...sharedExcludes]
  const rgOptions = { cwd: rgCwd }

  const [matchAnswer, universeAnswer] = await Promise.all([
    ripGrepAnswer(matchArgs, canonicalTarget, abortSignal, rgOptions),
    ripGrepAnswer(universeArgs, canonicalTarget, abortSignal, rgOptions),
  ])

  const suppliedBase = searchDir.replace(/[\\/]+$/, '')
  const canonicalBase = canonicalTarget.replace(/[\\/]+$/, '')
  const restoreSpelling = (file: string): string => {
    if (canonicalTarget === searchDir) return file
    if (file === canonicalTarget) return searchDir
    if (file.startsWith(canonicalBase)) {
      const next = file.charAt(canonicalBase.length)
      if (next === '/' || next === '\\') {
        return `${suppliedBase}${file.slice(canonicalBase.length)}`
      }
    }
    return file
  }

  const isDenied = readDenialFilter(toolPermissionContext, searchDir)
  const readableMatches = matchAnswer.lines.map(restoreSpelling).filter(file => !isDenied(file))
  const readableUniverse = new Set(universeAnswer.lines.map(restoreSpelling).filter(file => !isDenied(file)))
  const visible = readableMatches.filter(file => readableUniverse.has(file))

  const complete = matchAnswer.complete && universeAnswer.complete
  const ignored = complete ? readableMatches.length - visible.length : 0
  const incomplete = complete ? undefined : (matchAnswer.reason ?? universeAnswer.reason)

  const { limit, offset } = arg2
  const truncated = visible.length > offset + limit
  const files =
    visible.length > limit
      ? sampleAcrossTopLevel(visible, searchDir, limit, offset)
      : visible.slice(offset, offset + limit)

  return {
    files,
    truncated,
    ignored,
    ...(incomplete === undefined ? {} : { incomplete }),
  }
}
