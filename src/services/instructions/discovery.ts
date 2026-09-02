import ignore from 'ignore'
import { LRUCache } from 'lru-cache'
import { homedir } from 'os'
import { dirname, extname, isAbsolute, join, relative } from 'path'
import picomatch from 'picomatch'

import { getAddedDirectories, getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { normalizePathForComparison } from '../../utils/file.js'
import type { FsOperations } from '../../utils/fsOperations.js'
import { getFsImplementation, safeResolvePath } from '../../utils/fsOperations.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import type {
  InstructionConvention,
  InstructionDiagnostic,
  InstructionSourceEntry,
} from './contracts.js'
import { parseInstructionFileContent, TEXT_FILE_EXTENSIONS } from './sourceText.js'

export function pathInInstructionRoots(path: string): boolean {
  if (pathInWorkingPath(path, getOriginalCwd())) return true
  return getAddedDirectories().some(root => pathInWorkingPath(path, root))
}

function handleInstructionFileReadError(
  error: unknown,
  filePath: string,
): void {
  const code = getErrnoCode(error)
  if (code === 'ENOENT' || code === 'EISDIR') {
    return
  }
  logForDebugging(
    `instruction discovery: skipping unreadable file ${filePath} (${code ?? String(error)})`,
    { level: 'error' },
  )
}

export async function safelyReadInstructionFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{
  info: InstructionSourceEntry | null
  includePaths: string[]
  bareMentionPaths: string[]
}> {
  try {
    const fs = getFsImplementation()
    const rawContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return parseInstructionFileContent(
      rawContent,
      filePath,
      type,
      includeBasePath,
    )
  } catch (error) {
    handleInstructionFileReadError(error, filePath)
    return { info: null, includePaths: [], bareMentionPaths: [] }
  }
}

export const MAX_INCLUDE_DEPTH = 5

let excludeResolutionMemo = new WeakMap<FsOperations, Map<string, string>>()

export function clearExcludeResolutionMemo(): void {
  excludeResolutionMemo = new WeakMap()
}

function memoizedResolvedPath(fsImpl: FsOperations, path: string): string {
  let memo = excludeResolutionMemo.get(fsImpl)
  if (!memo) {
    memo = new Map()
    excludeResolutionMemo.set(fsImpl, memo)
  }
  const cached = memo.get(path)
  if (cached !== undefined) {
    return cached
  }
  const resolved = safeResolvePath(fsImpl, path).resolvedPath.replaceAll(
    '\\',
    '/',
  )
  memo.set(path, resolved)
  return resolved
}

function resolveExcludePatterns(patterns: string[]): string[] {
  const fs = getFsImplementation()
  const expanded: string[] = patterns.map(p => {
    const normalized = p.replaceAll('\\', '/')
    if (normalized === '~') {
      return homedir().replaceAll('\\', '/')
    }
    if (normalized.startsWith('~/')) {
      return join(homedir(), normalized.slice(2)).replaceAll('\\', '/')
    }
    return normalized
  })

  for (const normalized of [...expanded]) {
    if (!normalized.startsWith('/')) {
      continue
    }

    const globStart = normalized.search(/[*?{[]/)
    let staticPrefix: string
    if (globStart === -1) {
      staticPrefix = normalized
    } else {
      const lastSep = normalized.lastIndexOf('/', globStart)
      staticPrefix = lastSep <= 0 ? '/' : normalized.slice(0, lastSep)
    }

    const resolved = memoizedResolvedPath(fs, staticPrefix)
    if (resolved !== staticPrefix) {
      expanded.push(resolved + normalized.slice(staticPrefix.length))
    }
  }

  return expanded
}

export function matchesInstructionExcludes(
  filePath: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false
  }

  const matchOpts = { dot: true, nocase: process.platform === 'win32' }
  const normalizedPath = filePath.replaceAll('\\', '/')

  const expandedPatterns = resolveExcludePatterns(patterns).filter(
    p => p.length > 0,
  )
  if (expandedPatterns.length === 0) {
    return false
  }

  if (picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)) {
    return true
  }

  const resolvedTwin = memoizedResolvedPath(getFsImplementation(), filePath)
  return (
    resolvedTwin !== normalizedPath &&
    picomatch.isMatch(resolvedTwin, expandedPatterns, matchOpts)
  )
}

export async function processInstructionFile(
  convention: InstructionConvention,
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
  diagnostics?: InstructionDiagnostic[],
  ancestors?: Set<string>,
): Promise<InstructionSourceEntry[]> {
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  if (convention.isExcluded(filePath, type)) {
    return []
  }

  const { resolvedPath, isSymlink } = safeResolvePath(
    getFsImplementation(),
    filePath,
  )

  processedPaths.add(normalizedPath)
  if (isSymlink) {
    processedPaths.add(normalizePathForComparison(resolvedPath))
  }

  const { info: memoryFile, includePaths: resolvedIncludePaths, bareMentionPaths } =
    await safelyReadInstructionFileAsync(filePath, type, resolvedPath)
  if (!memoryFile || !memoryFile.content.trim()) {
    return []
  }

  const existingBareMentions: string[] = []
  for (const mention of bareMentionPaths) {
    if (getFsImplementation().existsSync(mention)) {
      existingBareMentions.push(mention)
    } else {
      logForDebugging(
        `instruction @mention without path evidence names no file — treated as prose, not an import: ${mention}`,
      )
    }
  }

  if (parent) {
    memoryFile.parent = parent
  }

  const result: InstructionSourceEntry[] = []

  result.push(memoryFile)

  const chain = new Set(ancestors ?? [])
  chain.add(normalizedPath)

  for (const resolvedIncludePath of [...resolvedIncludePaths, ...existingBareMentions]) {
    const normalizedInclude = normalizePathForComparison(resolvedIncludePath)
    if (chain.has(normalizedInclude)) {
      diagnostics?.push({
        kind: 'import-cycle',
        path: resolvedIncludePath,
        parent: filePath,
        detail: 'the @import names one of its own ancestors',
      })
      continue
    }
    const isExternal =
      !pathInInstructionRoots(resolvedIncludePath) &&
      !pathInWorkingPath(resolvedIncludePath, dirname(resolvedPath))
    if (isExternal && !includeExternal) {
      diagnostics?.push({
        kind: 'external-import-blocked',
        path: resolvedIncludePath,
        parent: filePath,
        detail: 'outside the instruction roots — composed only after operator approval',
      })
      continue
    }
    if (depth + 1 >= MAX_INCLUDE_DEPTH) {
      diagnostics?.push({
        kind: 'import-depth-exceeded',
        path: resolvedIncludePath,
        parent: filePath,
        detail: `include depth limit is ${MAX_INCLUDE_DEPTH}`,
      })
      continue
    }
    if (
      diagnostics !== undefined &&
      !processedPaths.has(normalizedInclude) &&
      !getFsImplementation().existsSync(resolvedIncludePath)
    ) {
      diagnostics.push({
        kind: 'missing-import-target',
        path: resolvedIncludePath,
        parent: filePath,
        detail: 'the @import target does not exist',
      })
      continue
    }
    if (diagnostics !== undefined && !processedPaths.has(normalizedInclude)) {
      let isDirectory = false
      try {
        isDirectory = getFsImplementation().statSync(resolvedIncludePath).isDirectory()
      } catch {
      }
      if (isDirectory) {
        diagnostics.push({
          kind: 'import-target-is-directory',
          path: resolvedIncludePath,
          parent: filePath,
          detail: 'the @import names a directory, not a file — an instruction file inside it must be named',
        })
        continue
      }
    }
    {
      const includeExt = extname(resolvedIncludePath).toLowerCase()
      if (includeExt && !TEXT_FILE_EXTENSIONS.has(includeExt)) {
        diagnostics?.push({
          kind: 'unsupported-import-type',
          path: resolvedIncludePath,
          parent: filePath,
          detail: `the @import target exists but '${includeExt}' is not a composable text type — nothing was composed`,
        })
        continue
      }
    }

    const includedFiles = await processInstructionFile(
      convention,
      resolvedIncludePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath,
      diagnostics,
      chain,
    )
    result.push(...includedFiles)
  }

  return result
}

const RULES_DIR_LISTING_TTL_MS = 5000
const rulesDirListingCaches = new WeakMap<object, LRUCache<string, { entries: import('fs').Dirent[] | null }>>()

async function cachedRulesDirListing(fsImpl: FsOperations, dir: string): Promise<import('fs').Dirent[] | null> {
  let cache = rulesDirListingCaches.get(fsImpl as unknown as object)
  if (cache === undefined) {
    cache = new LRUCache({ max: 500, ttl: RULES_DIR_LISTING_TTL_MS })
    rulesDirListingCaches.set(fsImpl as unknown as object, cache)
  }
  const held = cache.get(dir)
  if (held !== undefined) return held.entries
  try {
    const entries = await fsImpl.readdir(dir)
    cache.set(dir, { entries })
    return entries
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      cache.set(dir, { entries: null })
      return null
    }
    throw e
  }
}

export async function processRulesDir({
  convention,
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
}: {
  convention: InstructionConvention
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<InstructionSourceEntry[]> {
  if (visitedDirs.has(rulesDir)) {
    return []
  }

  try {
    const fs = getFsImplementation()

    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(
      fs,
      rulesDir,
    )

    visitedDirs.add(rulesDir)
    if (isSymlink) {
      visitedDirs.add(resolvedRulesDir)
    }

    const result: InstructionSourceEntry[] = []
    const entries = await cachedRulesDirListing(fs, resolvedRulesDir)
    if (entries === null) {
      return []
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink } = safeResolvePath(
        fs,
        entryPath,
      )

      const stats = isSymlink ? await fs.stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        result.push(
          ...(await processRulesDir({
            convention,
            rulesDir: resolvedEntryPath,
            type,
            processedPaths,
            includeExternal,
            conditionalRule,
            visitedDirs,
          })),
        )
      } else if (isFile && entry.name.endsWith('.md')) {
        const files = await processInstructionFile(
          convention,
          resolvedEntryPath,
          type,
          processedPaths,
          includeExternal,
        )
        result.push(
          ...files.filter(f => (conditionalRule ? f.globs : !f.globs)),
        )
      }
    }

    return result
  } catch (error) {
    logForDebugging(
      `instruction discovery: rules dir ${rulesDir} unreadable (${String(error)})`,
      { level: 'error' },
    )
    return []
  }
}

export async function processConditionedRules(
  convention: InstructionConvention,
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<InstructionSourceEntry[]> {
  const conditionedRuleMdFiles = await processRulesDir({
    convention,
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
  })

  return conditionedRuleMdFiles.filter(file => {
    if (!file.globs || file.globs.length === 0) {
      return false
    }

    const baseDir =
      type === 'Project'
        ? dirname(dirname(rulesDir))
        : getOriginalCwd()

    const relativePath = isAbsolute(targetPath)
      ? relative(baseDir, targetPath)
      : targetPath
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      return false
    }
    return ignore().add(file.globs).ignores(relativePath)
  })
}
