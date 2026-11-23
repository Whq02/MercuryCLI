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
  const resolvedGlobs = resolveSearchGlob(pattern, rgCwd)
  const maxDepth = globSearchDepth(resolvedGlobs)

  const sharedArgs: string[] = ['--files']
  if (envFlagDefaultOn('MERCURY_GLOB_HIDDEN')) {
    sharedArgs.push('--hidden')
  }
  if (maxDepth !== undefined) {
    sharedArgs.push('--max-depth', String(maxDepth))
  }
  for (const resolvedGlob of resolvedGlobs) {
    sharedArgs.push('--glob', resolvedGlob)
  }
  for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
    sharedArgs.push('--glob', `!**/${dir}`, '--glob', `!**/${dir}/**`)
  }

  const ignoreByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  const ignorePatterns = new Set<string>(normalizePatternsToPath(ignoreByRoot, rgCwd))
  const suppliedCwd = isFileTarget ? dirname(searchDir) : searchDir
  if (suppliedCwd !== rgCwd) {
    for (const ignorePattern of normalizePatternsToPath(ignoreByRoot, suppliedCwd)) {
      ignorePatterns.add(ignorePattern)
    }
  }
  for (const ignorePattern of ignorePatterns) {
    sharedArgs.push('--iglob', ignorePattern.startsWith('/') ? `!${ignorePattern}` : `!**/${ignorePattern}`)
  }

  const mainArgs = ['--sortr=modified', ...sharedArgs]
  const unignoredArgs = ['--no-ignore', ...sharedArgs]
  const rgOptions = { cwd: rgCwd }

  const [mainAnswer, unignoredAnswer] = await Promise.all([
    ripGrepAnswer(mainArgs, canonicalTarget, abortSignal, rgOptions),
    ripGrepAnswer(unignoredArgs, canonicalTarget, abortSignal, rgOptions),
  ])

  const suppliedBase = searchDir.replace(/[\\/]+$/, '')
  const restoreSpelling = (file: string): string => {
    if (canonicalTarget === searchDir) return file
    if (file === canonicalTarget) return searchDir
    if (file.startsWith(canonicalTarget)) {
      const next = file.charAt(canonicalTarget.length)
      if (next === '/' || next === '\\') {
        return `${suppliedBase}${file.slice(canonicalTarget.length)}`
      }
    }
    return file
  }

  const isDenied = readDenialFilter(toolPermissionContext, searchDir)
  const visible = mainAnswer.lines.map(restoreSpelling).filter(file => !isDenied(file))

  let ignored = 0
  if (mainAnswer.complete && unignoredAnswer.complete) {
    const visibleSet = new Set(visible)
    for (const rawFile of unignoredAnswer.lines) {
      const file = restoreSpelling(rawFile)
      if (!isDenied(file) && !visibleSet.has(file)) ignored++
    }
  }

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
    ...(mainAnswer.complete ? {} : { incomplete: mainAnswer.reason }),
  }
}
