import ignore from 'ignore'
import { LRUCache } from 'lru-cache'
import { homedir } from 'os'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'
import picomatch from 'picomatch'

import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { normalizePathForComparison } from '../../platform/files/file.js'
import { detectEncodingForResolvedPath } from '../../platform/files/syncFileRead.js'
import type { FsOperations } from '../../platform/files/fsOperations.js'
import { getFsImplementation, isUncLikePath, safeResolvePath } from '../../platform/files/fsOperations.js'
import type { InstructionFileType } from '../memory-shapes/types.js'
import { pathInWorkingPath } from '../../permissions/rules/filesystem.js'
import { rememberedPlatform } from '../../platform/host-os/host.js'
import { hostOrWin32PathModule, isWindowsShareRooted, normalizedDriveRoot, picomatchPathOptions } from '../../platform/host-os/paths.js'
import { recordHiddenCharacters } from '../../platform/text/hiddenCharacterFindings.js'
import type {
  InstructionConvention,
  InstructionDiagnostic,
  InstructionSourceEntry,
} from '../instruction-contracts/contracts.js'
import { parseInstructionFileContent, readRuleSource, TEXT_FILE_EXTENSIONS } from './sourceText.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const shareRooted = (path: string): boolean => isWindowsShareRooted(path)

export function withinInstructionDir(path: string, dir: string): boolean {
  return shareRooted(path) === shareRooted(dir) && pathInWorkingPath(path, dir)
}

export function pathInInstructionRoots(path: string): boolean {
  const fs = getFsImplementation()
  return withinInstructionDir(safeResolvePath(fs, path).resolvedPath, safeResolvePath(fs, getOriginalCwd()).resolvedPath)
}

export async function safelyReadInstructionFileAsync(
  filePath: string,
  type: InstructionFileType,
  includeBasePath?: string,
): Promise<{
  info: InstructionSourceEntry | null
  includePaths: string[]
  bareMentionPaths: string[]
}> {
  try {
    const fs = getFsImplementation()
    const bytes = await fs.readFileBytes(filePath)
    const encoding = detectEncodingForResolvedPath(filePath)
    const content = bytes.toString(encoding)
    return parseInstructionFileContent(content, filePath, type, includeBasePath)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'EISDIR') {
      logForDebugging(
        `instruction discovery: skipping unreadable file ${filePath} (${code ?? (error instanceof Error ? error.message : String(error))})`,
        { level: 'error' },
      )
    }
    return { info: null, includePaths: [], bareMentionPaths: [] }
  }
}

async function leftOutByRule(filePath: string, resolved: { isSymlink: boolean; isCanonical: boolean }): Promise<boolean> {
  if (resolved.isCanonical && !resolved.isSymlink) return false
  try {
    return !(await getFsImplementation().stat(filePath)).isFile()
  } catch (error) {
    return getErrnoCode(error) === 'ENOENT'
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

function normalizeExcludePattern(raw: string): string {
  const slashed = raw.replaceAll('\\', '/')
  if (slashed === '~') return homedir().replaceAll('\\', '/')
  if (slashed.startsWith('~/')) return homedir().replaceAll('\\', '/') + slashed.slice(1)
  return slashed
}

function canonicalExcludeTwin(fsImpl: FsOperations, pattern: string): string | null {
  const root = normalizedDriveRoot(pattern)
  if (root === null) return null
  const globIndex = pattern.search(/[*?{[]/)
  let staticPrefix: string
  let tail: string
  if (globIndex === -1) {
    staticPrefix = pattern
    tail = ''
  } else {
    const lastSlash = pattern.lastIndexOf('/', globIndex)
    if (lastSlash < root.length) {
      staticPrefix = root
      tail = pattern.slice(root.length)
    } else {
      staticPrefix = pattern.slice(0, lastSlash)
      tail = pattern.slice(lastSlash)
    }
  }
  const resolved = memoizedResolvedPath(fsImpl, staticPrefix)
  if (resolved === staticPrefix) return null
  if (tail === '') return resolved
  if (tail.startsWith('/')) {
    return (resolved.endsWith('/') ? resolved.slice(0, -1) : resolved) + tail
  }
  return (resolved.endsWith('/') ? resolved : `${resolved}/`) + tail
}

export function matchesInstructionExcludes(
  filePath: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false
  const normalizedPatterns = patterns.map(normalizeExcludePattern).filter(p => p !== '')
  if (normalizedPatterns.length === 0) return false

  const opts = picomatchPathOptions()
  const lexical = filePath.replaceAll('\\', '/')
  if (picomatch.isMatch(lexical, normalizedPatterns, opts)) return true

  const fsImpl = getFsImplementation()
  const twins: string[] = []
  for (const pattern of normalizedPatterns) {
    const twin = canonicalExcludeTwin(fsImpl, pattern)
    if (twin !== null) twins.push(twin)
  }
  if (twins.length > 0 && picomatch.isMatch(lexical, twins, opts)) return true

  const canonical = memoizedResolvedPath(fsImpl, filePath)
  if (canonical !== lexical) {
    const allPatterns = twins.length > 0 ? [...normalizedPatterns, ...twins] : normalizedPatterns
    if (picomatch.isMatch(canonical, allPatterns, opts)) return true
  }
  return false
}

export type ExternalImports = boolean | { heldShares: { path: string; parent: string }[] }

function importedRuleAnchorOf(fs: FsOperations, owner: string): string {
  const cwd = getOriginalCwd()
  const resolvedOwner = safeResolvePath(fs, owner).resolvedPath
  const resolvedCwd = safeResolvePath(fs, cwd).resolvedPath
  return withinInstructionDir(resolvedCwd, resolvedOwner) || withinInstructionDir(resolvedOwner, resolvedCwd)
    ? owner
    : cwd
}

async function tryImportRecognizedRule(
  fs: FsOperations,
  includePath: string,
  parentPath: string,
  type: InstructionFileType,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
): Promise<InstructionSourceEntry[] | null> {
  const cleanPath = includePath.replace(/[\\/]+$/, '') || includePath
  const { sharedRuleFormats } = await import('./compositionOrder.js')
  let matchedFormat: InstructionConvention | undefined
  let matchedLoc: { owner: string; source: boolean } | null = null
  for (const format of sharedRuleFormats()) {
    const loc = format.ruleAt?.(cleanPath) ?? null
    if (loc !== null) {
      matchedFormat = format
      matchedLoc = loc
      break
    }
  }
  if (matchedFormat === undefined || matchedLoc === null) return null

  let stats
  try {
    stats = await fs.stat(cleanPath)
  } catch (error) {
    passedOver(error)
    return null
  }

  let rawEntries: InstructionSourceEntry[]
  let fromFolder: boolean
  if (stats.isDirectory()) {
    if (!matchedLoc.source) return null
    fromFolder = true
    rawEntries = await processRulesDir({
      convention: matchedFormat,
      rulesDir: cleanPath,
      type,
      processedPaths,
      includeExternal: false,
      conditionalRule: false,
      diagnostics,
      every: true,
    })
  } else {
    fromFolder = false
    rawEntries = await processRuleFile(
      matchedFormat,
      cleanPath,
      type,
      processedPaths,
      diagnostics,
      matchedLoc.source,
    )
  }

  const survivors: InstructionSourceEntry[] = []
  for (const entry of rawEntries) {
    if (fromFolder ? entry.dormant !== undefined : entry.dormant !== undefined && entry.dormant !== 'manual') {
      continue
    }
    entry.parent = parentPath
    delete entry.dormant
    if (entry.globs !== undefined) {
      entry.anchor = importedRuleAnchorOf(fs, matchedLoc.owner)
    }
    survivors.push(entry)
  }
  return survivors
}

export async function processInstructionFile(
  convention: InstructionConvention,
  filePath: string,
  type: InstructionFileType,
  processedPaths: Set<string>,
  includeExternal: ExternalImports,
  depth: number = 0,
  parent?: string,
  diagnostics?: InstructionDiagnostic[],
  ancestors?: Set<string>,
): Promise<InstructionSourceEntry[]> {
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath)) return []
  if (depth >= MAX_INCLUDE_DEPTH) return []
  if (convention.isExcluded(filePath, type)) return []

  processedPaths.add(normalizedPath)
  const fs = getFsImplementation()
  const resolved = safeResolvePath(fs, filePath)
  const resolvedPath = resolved.resolvedPath
  if (resolved.isSymlink) {
    const normalizedResolved = normalizePathForComparison(resolvedPath)
    if (normalizedResolved !== normalizedPath && processedPaths.has(normalizedResolved)) return []
    processedPaths.add(normalizedResolved)
  }

  if (await leftOutByRule(filePath, resolved)) return []

  const { info, includePaths, bareMentionPaths } = await safelyReadInstructionFileAsync(
    filePath,
    type,
    resolvedPath,
  )
  if (!info || !info.content.trim()) return []

  recordHiddenCharacters('instruction', filePath, info.rawContent ?? info.content)
  if (parent) info.parent = parent
  info.convention = convention.id

  const results: InstructionSourceEntry[] = [info]
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(normalizedPath)
  if (resolved.isSymlink) {
    nextAncestors.add(normalizePathForComparison(resolvedPath))
  }
  const holderDir = hostOrWin32PathModule(rememberedPlatform()).dirname(resolvedPath)

  const existingBarePaths: string[] = []
  for (const barePath of bareMentionPaths) {
    let exists = false
    try {
      exists = fs.existsSync(barePath)
    } catch (error) {
      passedOver(error)
      exists = false
    }
    if (!exists) {
      logForDebugging(
        `instruction @mention without path evidence names no file — treated as prose, not an import: ${barePath}`,
      )
      continue
    }
    existingBarePaths.push(barePath)
  }

  for (const includePath of [...includePaths, ...existingBarePaths]) {
    const normalizedInclude = normalizePathForComparison(includePath)
    if (nextAncestors.has(normalizedInclude)) {
      diagnostics?.push({
        kind: 'import-cycle',
        path: includePath,
        parent: filePath,
        detail: 'the @import names one of its own ancestors',
      })
      continue
    }

    const targetResolved = safeResolvePath(fs, includePath).resolvedPath
    if (nextAncestors.has(normalizePathForComparison(targetResolved))) {
      diagnostics?.push({
        kind: 'import-cycle',
        path: includePath,
        parent: filePath,
        detail: 'the @import names one of its own ancestors',
      })
      continue
    }

    const isExternal = !pathInInstructionRoots(targetResolved) && !withinInstructionDir(targetResolved, holderDir)
    if (isExternal) {
      if (includeExternal === false) {
        diagnostics?.push({
          kind: 'external-import-blocked',
          path: includePath,
          parent: filePath,
          detail: 'outside the instruction roots — composed only after operator approval',
        })
        continue
      }
      if (typeof includeExternal === 'object' && (isUncLikePath(includePath) || isUncLikePath(targetResolved))) {
        diagnostics?.push({
          kind: 'external-import-blocked',
          path: includePath,
          parent: filePath,
          detail: 'outside the instruction roots — composed only after operator approval',
        })
        if (!includeExternal.heldShares.some(entry => entry.path === includePath)) {
          includeExternal.heldShares.push({ path: includePath, parent: filePath })
        }
        continue
      }
    }

    if (depth + 1 >= MAX_INCLUDE_DEPTH) {
      diagnostics?.push({
        kind: 'import-depth-exceeded',
        path: includePath,
        parent: filePath,
        detail: `include depth limit is ${MAX_INCLUDE_DEPTH}`,
      })
      continue
    }

    const recognized = await tryImportRecognizedRule(
      fs,
      includePath,
      filePath,
      type,
      processedPaths,
      diagnostics,
    )
    if (recognized !== null) {
      results.push(...recognized)
      continue
    }

    const ext = extname(includePath).toLowerCase()
    const unsupportedExt = ext !== '' && !TEXT_FILE_EXTENSIONS.has(ext)
    if (diagnostics !== undefined && !processedPaths.has(normalizedInclude)) {
      let skip = false
      try {
        const st = await fs.stat(includePath)
        if (st.isDirectory()) {
          diagnostics.push({
            kind: 'import-target-is-directory',
            path: includePath,
            parent: filePath,
            detail: 'the @import names a directory, not a file — an instruction file inside it must be named',
          })
          skip = true
        } else if (unsupportedExt) {
          diagnostics.push({
            kind: 'unsupported-import-type',
            path: includePath,
            parent: filePath,
            detail: `the @import target exists but '${ext}' is not a composable text type — nothing was composed`,
          })
          skip = true
        }
      } catch (error) {
        if (getErrnoCode(error) === 'ENOENT') {
          diagnostics.push({
            kind: 'missing-import-target',
            path: includePath,
            parent: filePath,
            detail: 'the @import target does not exist',
          })
          skip = true
        }
      }
      if (skip) continue
    }
    if (unsupportedExt) continue
    const imported = await processInstructionFile(
      convention,
      includePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath,
      diagnostics,
      nextAncestors,
    )
    results.push(...imported)
  }

  return results
}

const vendorGlobMatches = (globs: string[], spelling: string): boolean =>
  picomatch.isMatch(spelling.split(sep).join('/'), globs, picomatchPathOptions())

export function importedRuleGoverns(entry: InstructionSourceEntry, targetPath: string): boolean {
  if (entry.anchor === undefined || entry.globs === undefined) return false
  const spelling = targetSpellingUnder(entry.anchor, targetPath)
  return spelling !== null && vendorGlobMatches(entry.globs, spelling)
}

export async function processRuleFile(
  convention: InstructionConvention,
  filePath: string,
  type: InstructionFileType,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
  alone: boolean = false,
): Promise<InstructionSourceEntry[]> {
  const format = convention.rules
  if (format === undefined) return []
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath)) return []
  if (convention.isExcluded(filePath, type)) return []

  processedPaths.add(normalizedPath)
  const fs = getFsImplementation()
  const resolved = safeResolvePath(fs, filePath)
  if (resolved.isSymlink) {
    const normalizedResolved = normalizePathForComparison(resolved.resolvedPath)
    if (normalizedResolved !== normalizedPath && processedPaths.has(normalizedResolved)) return []
    processedPaths.add(normalizedResolved)
  }

  if (await leftOutByRule(filePath, resolved)) return []

  let rawText: string
  try {
    const bytes = await fs.readFileBytes(filePath)
    const encoding = detectEncodingForResolvedPath(filePath)
    rawText = bytes.toString(encoding)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'EISDIR') {
      logForDebugging(
        `instruction discovery: skipping unreadable file ${filePath} (${code ?? (error instanceof Error ? error.message : String(error))})`,
        { level: 'error' },
      )
    }
    return []
  }

  const { info, unreadable, reading } = readRuleSource(rawText, filePath, type, format, alone)
  if (unreadable) {
    diagnostics?.push({
      kind: 'unreadable-rule-header',
      path: filePath,
      detail: `the header between the --- lines is not YAML: the rule ${
        reading === null ? 'is not loaded' : 'loads whole, as its tool loads it'
      }`,
    })
  } else if (reading?.kind === 'unsupported') {
    diagnostics?.push({
      kind: 'unsupported-rule-activation',
      path: filePath,
      detail: reading.detail,
    })
  }

  if (!info.content.trim()) return []
  info.convention = convention.id
  if (info.dormant === undefined) {
    recordHiddenCharacters('instruction', filePath, rawText)
  }
  return [info]
}

const RULES_DIR_LISTING_TTL_MS = 5_000

type DirListing = Awaited<ReturnType<FsOperations['readdir']>>

const rulesDirListingCaches = new WeakMap<FsOperations, LRUCache<string, { entries: DirListing | null }>>()

async function readRulesDirCached(fsImpl: FsOperations, dir: string): Promise<DirListing | null> {
  let cache = rulesDirListingCaches.get(fsImpl)
  if (cache === undefined) {
    cache = new LRUCache({ max: 500, ttl: RULES_DIR_LISTING_TTL_MS })
    rulesDirListingCaches.set(fsImpl, cache)
  }
  const cached = cache.get(dir)
  if (cached !== undefined) return cached.entries
  try {
    const entries = await fsImpl.readdir(dir)
    cache.set(dir, { entries })
    return entries
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      cache.set(dir, { entries: null })
      return null
    }
    throw error
  }
}
const ruleFileCaches = new WeakMap<FsOperations, LRUCache<string, { file: boolean }>>()

async function standsAsRuleFile(fsImpl: FsOperations, source: string): Promise<boolean> {
  let cache = ruleFileCaches.get(fsImpl)
  if (cache === undefined) {
    cache = new LRUCache({ max: 500, ttl: RULES_DIR_LISTING_TTL_MS })
    ruleFileCaches.set(fsImpl, cache)
  }
  const held = cache.get(source)
  if (held !== undefined) return held.file
  let file = false
  try {
    file = (await fsImpl.stat(source)).isFile()
  } catch (error) {
    passedOver(error)
  }
  cache.set(source, { file })
  return file
}

function matchesConditionSplit(entry: InstructionSourceEntry, conditionalRule: boolean): boolean {
  const hasGlobs = entry.globs !== undefined && entry.globs.length > 0
  return conditionalRule ? hasGlobs : !hasGlobs
}

export async function processRulesDir({
  convention,
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set<string>(),
  diagnostics,
  every = false,
}: {
  convention: InstructionConvention
  rulesDir: string
  type: InstructionFileType
  processedPaths: Set<string>
  includeExternal: ExternalImports
  conditionalRule: boolean
  visitedDirs?: Set<string>
  diagnostics?: InstructionDiagnostic[]
  every?: boolean
}): Promise<InstructionSourceEntry[]> {
  const normalizedDir = normalizePathForComparison(rulesDir)
  if (visitedDirs.has(normalizedDir)) return []
  visitedDirs.add(normalizedDir)

  const fs = getFsImplementation()
  const resolvedDir = safeResolvePath(fs, rulesDir)
  if (resolvedDir.isSymlink) {
    const normalizedResolvedDir = normalizePathForComparison(resolvedDir.resolvedPath)
    if (normalizedResolvedDir !== normalizedDir && visitedDirs.has(normalizedResolvedDir)) return []
    visitedDirs.add(normalizedResolvedDir)
  }

  try {
    const entries = await readRulesDirCached(fs, rulesDir)
    const format = convention.rules
    if (entries === null) {
      if (format !== undefined && (await standsAsRuleFile(fs, rulesDir))) {
        const read = await processRuleFile(convention, rulesDir, type, processedPaths, diagnostics, true)
        return every
          ? read
          : read.filter(entry => entry.dormant === undefined && matchesConditionSplit(entry, conditionalRule))
      }
      return []
    }

    const ordered =
      format !== undefined
        ? [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : entries

    const results: InstructionSourceEntry[] = []
    for (const dirent of ordered) {
      const entryPath = join(rulesDir, dirent.name)
      let isDir = dirent.isDirectory()
      let isFile = dirent.isFile()
      let targetPath = entryPath

      if (dirent.isSymbolicLink()) {
        try {
          targetPath = safeResolvePath(fs, entryPath).resolvedPath
          const st = await fs.stat(targetPath)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch (error) {
          passedOver(error)
          continue
        }
      }

      if (isDir) {
        const nested = await processRulesDir({
          convention,
          rulesDir: targetPath,
          type,
          processedPaths,
          includeExternal,
          conditionalRule,
          visitedDirs,
          diagnostics,
          every,
        })
        results.push(...nested)
      } else if (isFile) {
        if (format !== undefined) {
          if (!format.accepts(dirent.name)) continue
          const loaded = await processRuleFile(convention, targetPath, type, processedPaths, diagnostics, false)
          if (every) {
            results.push(...loaded)
          } else {
            for (const entry of loaded) {
              if (entry.dormant !== undefined) continue
              if (matchesConditionSplit(entry, conditionalRule)) results.push(entry)
            }
          }
        } else {
          if (!dirent.name.endsWith('.md')) continue
          const loaded = await processInstructionFile(
            convention,
            targetPath,
            type,
            processedPaths,
            includeExternal,
          )
          for (const entry of loaded) {
            if (matchesConditionSplit(entry, conditionalRule)) results.push(entry)
          }
        }
      }
    }
    return results
  } catch (error) {
    logForDebugging(
      `instruction discovery: rules dir ${rulesDir} unreadable (${error instanceof Error ? error.message : String(error)})`,
    )
    return []
  }
}

function ruleAnchorOf(convention: InstructionConvention, type: InstructionFileType, rulesDir: string): string {
  if (type !== 'Project') return getOriginalCwd()
  return convention.ruleAnchor?.(rulesDir) ?? dirname(dirname(rulesDir))
}

function targetSpellingUnder(anchor: string, targetPath: string): string | null {
  const spelling = isAbsolute(targetPath) ? relative(anchor, targetPath) : targetPath
  const judgeable = spelling !== '' && !spelling.startsWith('..') && !isAbsolute(spelling)
  return judgeable ? spelling : null
}

function ruleGoverns(convention: InstructionConvention, globs: string[] | undefined, spelling: string): boolean {
  if (globs === undefined || globs.length === 0) return false
  if (convention.rules === undefined) return ignore().add(globs).ignores(spelling)
  return vendorGlobMatches(globs, spelling)
}

export async function processConditionedRules(
  convention: InstructionConvention,
  targetPath: string,
  rulesDir: string,
  type: InstructionFileType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<InstructionSourceEntry[]> {
  const entries = await processRulesDir({
    convention,
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
  })
  const anchor = ruleAnchorOf(convention, type, rulesDir)
  const spelling = targetSpellingUnder(anchor, targetPath)
  if (spelling === null) return []
  return entries.filter(entry => ruleGoverns(convention, entry.globs, spelling))
}
