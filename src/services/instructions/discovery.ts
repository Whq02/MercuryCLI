import ignore from 'ignore'
import { LRUCache } from 'lru-cache'
import { homedir } from 'os'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'
import picomatch from 'picomatch'

import { getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { normalizePathForComparison } from '../../utils/file.js'
import { detectEncodingForResolvedPath } from '../../utils/fileRead.js'
import type { FsOperations } from '../../utils/fsOperations.js'
import { getFsImplementation, isUncLikePath, safeResolvePath } from '../../utils/fsOperations.js'
import type { MemoryType } from '../../utils/memory/types.js'
import { pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { rememberedPlatform } from '../../utils/platform/host.js'
import { hostOrWin32PathModule, isWindowsShareRooted, normalizedDriveRoot, picomatchPathOptions } from '../../utils/platform/paths.js'
import { recordHiddenCharacters } from '../../utils/text/hiddenCharacterFindings.js'
import type {
  InstructionConvention,
  InstructionDiagnostic,
  InstructionSourceEntry,
} from '../../utils/instructions/contracts.js'
import { parseInstructionFileContent, readRuleSource, TEXT_FILE_EXTENSIONS } from './sourceText.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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
  type: MemoryType,
  includeBasePath?: string,
): Promise<{
  info: InstructionSourceEntry | null
  includePaths: string[]
  bareMentionPaths: string[]
}> {
  return notBuilt('src/services/instructions/discovery.ts:52')
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

export function matchesInstructionExcludes(
  filePath: string,
  patterns: string[] | undefined,
): boolean {
  return notBuilt('src/services/instructions/discovery.ts:149')
}

export type ExternalImports = Unbuilt

export async function processInstructionFile(
  convention: InstructionConvention,
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: ExternalImports,
  depth?: number,
  parent?: string,
  diagnostics?: InstructionDiagnostic[],
  ancestors?: Set<string>,
): Promise<InstructionSourceEntry[]> {
  return notBuilt('src/services/instructions/discovery.ts:180')
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
  type: MemoryType,
  processedPaths: Set<string>,
  diagnostics?: InstructionDiagnostic[],
  alone?: boolean,
): Promise<InstructionSourceEntry[]> {
  return notBuilt('src/services/instructions/discovery.ts:391')
}

const RULES_DIR_LISTING_TTL_MS: Unbuilt = unbuilt('src/services/instructions/discovery.ts:441')

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

export async function processRulesDir(arg0: {
  convention: InstructionConvention
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: ExternalImports
  conditionalRule: boolean
  visitedDirs?: Set<string>
  diagnostics?: InstructionDiagnostic[]
  every?: boolean
}): Promise<InstructionSourceEntry[]> {
  return notBuilt('src/services/instructions/discovery.ts:486')
}

function ruleAnchorOf(convention: InstructionConvention, type: MemoryType, rulesDir: string): string {
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
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<InstructionSourceEntry[]> {
  return notBuilt('src/services/instructions/discovery.ts:605')
}
