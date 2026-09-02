// ============================================================================
//  instructions/discovery.ts — traversal + parsing mechanics of the ONE
//  instruction engine: per-file processing with
//  @include recursion, rules-directory traversal with the conditional/
//  unconditional split, exclusion-pattern matching, and conditional-rule
//  glob filtering. The established traversal behavior, byte-exact
//  (oracle-pinned); the source CONVENTION (file names, homes, exclusion
//  policy) arrives as a parameter instead of being hard-wired to the
//  Claude family.
// ============================================================================
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

/** Inside an instruction root — the boot cwd or a directory the operator
 *  added. The @import approval boundary: an import that stays inside a root
 *  the operator named is not external. */
export function pathInInstructionRoots(path: string): boolean {
  if (pathInWorkingPath(path, getOriginalCwd())) return true
  return getAddedDirectories().some(root => pathInWorkingPath(path, root))
}

// The discovery walk PROBES: most reads land ENOENT (the file simply isn't
// there) or EISDIR (a directory wearing an instruction-file name) — both are
// normal outcomes, not errors. Anything else is a real read failure the
// operator can act on (EACCES above all), so it goes to the LOCAL debug log
// with its path — a silently skipped instruction file is a session quietly
// running without rules the operator believes are in force.
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

/**
 * The walk's read primitive. Async io on purpose — discovery makes many
 * read attempts (mostly ENOENT probes) and must not stall the event loop
 * through them. With includeBasePath set, the single lex pass also
 * resolves @include paths, returned beside the parsed file.
 */
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

/**
 * Realpath memo for the exclusion matcher. Exclusion runs on the engine
 * walk — every probed file consults it — so each spelling resolves once
 * per cache lifetime, not once per probe. Keyed by fs implementation so an
 * injected test double never shares entries with the real fs; cleared with
 * the discovery cache (clearInstructionFileCaches), so a retargeted
 * symlink is picked up exactly when the walk itself re-runs.
 */
let excludeResolutionMemo = new WeakMap<FsOperations, Map<string, string>>()

export function clearExcludeResolutionMemo(): void {
  excludeResolutionMemo = new WeakMap()
}

/** Resolved spelling ('/'-separated) of `path`, or `path` itself when it
 *  does not resolve; sync on purpose — the callers (convention.isExcluded
 *  → processInstructionFile → the engine walk) are sync. */
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
  // safeResolvePath's guards hold here too: special files and unresolvable
  // paths keep their written spelling.
  const resolved = safeResolvePath(fsImpl, path).resolvedPath.replaceAll(
    '\\',
    '/',
  )
  memo.set(path, resolved)
  return resolved
}

/**
 * Widen exclude patterns to every spelling that must keep matching. A
 * leading `~` means the operator's home (the permission-rule law for
 * operator-written path rules). Each absolute pattern's glob-free static
 * prefix gains its realpath twin: the WHOLE pattern when it carries no
 * glob (a pattern naming a symlinked file resolves to the file's target),
 * otherwise the last complete directory before the first glob token —
 * never a partial component, so "/a/foo*.md" resolves /a, not /a/foo.
 * Resolved spellings JOIN the list (never replace — both spellings must
 * keep matching).
 */
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
    // Only absolute patterns carry a filesystem prefix worth resolving;
    // pure globs ("**/*.md") have nothing on disk to realpath.
    if (!normalized.startsWith('/')) {
      continue
    }

    // The static prefix ends where glob syntax begins.
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

/**
 * The exclusion matcher. Symlink-honest in BOTH directions, file level
 * included: the tested path is matched by its written spelling AND its
 * realpath twin (a rules file reached through a symlink is excluded no
 * matter which spelling the operator's pattern names), and each pattern's
 * glob-free static prefix gains its realpath twin (resolveExcludePatterns
 * above) — so an exclude written as "/tmp/…" still bites when the session
 * resolved cwd to "/private/tmp/…" (the macOS shape). Which SETTING
 * supplies the patterns, and which memory types they govern, is convention
 * policy — the adapters own that.
 */
export function matchesInstructionExcludes(
  filePath: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false
  }

  // nocase on windows (FC-031): an exclude naming the same file with a
  // lowercase drive letter excluded nothing — the filesystem is
  // case-insensitive there and the pattern match must agree.
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

  // The tested path's own realpath twin — the other direction of the
  // symlink law.
  const resolvedTwin = memoizedResolvedPath(getFsImplementation(), filePath)
  return (
    resolvedTwin !== normalizedPath &&
    picomatch.isMatch(resolvedTwin, expandedPatterns, matchOpts)
  )
}

/**
 * Recursively processes an instruction file and all its @include references
 * Returns an array of entries with the main file first, then includes
 * (parent before children).
 *
 * `diagnostics` (optional) collects import findings — cycles, missing
 * targets, depth overruns, blocked externals — for the doctor surface;
 * `ancestors` carries the normalized paths of the CURRENT include chain so a
 * cycle (an @import naming its own ancestor) is distinguished from the
 * benign already-composed-elsewhere dedup.
 */
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
  // Once per path, and never past the depth cap. Comparison keys are
  // normalized so Windows drive-letter casing (C:\ vs c:\) cannot smuggle
  // the same file in twice.
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // The convention's exclusion policy has the next veto.
  if (convention.isExcluded(filePath, type)) {
    return []
  }

  // Resolve a symlink up front — @include targets resolve relative to the
  // REAL file's directory, and both spellings join the processed set.
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

  // FC-110: a bare @word with no path evidence is an import only when it
  // names a real file — "@alice" and scoped-package prose mentions must
  // not fabricate missing-import warns in the doctor. A bare mention that
  // EXISTS (an operator's @Makefile) composes on the ordinary rung below.
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

  // Ordering law: the file itself first, then its includes (parent before
  // children, depth-first).
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
    // The importing FILE's own directory is a root for ITS imports: a
    // parent MERCURY.md discovered above the cwd legitimately composes from
    // where it lives — its sibling import was dropped as "external",
    // including one naming a file in the importing file's own directory
    // (FC-030). Genuinely-outside imports still block.
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
    // An include that resolves to a DIRECTORY is its own finding: the
    // reader's EISDIR is a normal probe outcome on the discovery walk and is
    // swallowed there, so a cut-short Windows spelling (or a plain mistake)
    // composed nothing and said nothing (FN-015 rank 44).
    if (diagnostics !== undefined && !processedPaths.has(normalizedInclude)) {
      let isDirectory = false
      try {
        isDirectory = getFsImplementation().statSync(resolvedIncludePath).isDirectory()
      } catch {
        /* absent or unreadable — the existence probe above already spoke */
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
    // An EXISTING target with a non-composable extension used to vanish in
    // silence (FC-100): the allowlist gate rejects inside the pure parser,
    // AFTER discovery already marked the target resolved — the typo'd path
    // warned while the wrong file type composed nothing and said nothing.
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
      filePath, // this file is the include's parent
      diagnostics,
      chain,
    )
    result.push(...includedFiles)
  }

  return result
}

/**
 * Short-TTL listing cache over rules directories (FN-014 row 2): the
 * per-touched-file loop walks the SAME ancestor ladders for every file the
 * agent touches, and each level's readdir went to disk every time —
 * O(files × levels) real seeks, mostly for `.mercury/rules`-shaped dirs
 * that DON'T exist. Negative answers (ENOENT/EACCES/ENOTDIR → null) are the
 * common case and the actual win; other codes throw uncached, exactly the
 * uncached classification. Keyed PER injected fs implementation (provers
 * swap fakes in), value-wrapped so a cached null is not a miss. The 5 s TTL
 * mirrors the directoryCompletion/fileSuggestions refresh floor: a rule
 * file added mid-turn appears within it.
 */
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

/**
 * Traverse a rules directory (recursively) and compose its .md files.
 * `conditionalRule` selects WHICH kind this pass keeps: true keeps only
 * files WITH frontmatter path globs, false keeps only files WITHOUT — the
 * same tree serves both passes, filtered. `visitedDirs` breaks symlinked
 * directory cycles.
 */
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

      // A plain Dirent already knows what it is (no extra stat); only a
      // symlink needs a stat of its TARGET to classify.
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
    // Same honesty rule as the file probe above: a rules directory that
    // exists but cannot be traversed is worth a local debug line, never a
    // silent empty result.
    logForDebugging(
      `instruction discovery: rules dir ${rulesDir} unreadable (${String(error)})`,
      { level: 'error' },
    )
    return []
  }
}

/**
 * The conditional-rule pass: traverse `rulesDir` for frontmatter-globbed
 * rules, then keep only those whose globs match `targetPath`.
 */
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

    // Glob anchor: Project rules match relative to the directory HOLDING
    // the project-config home (rules dir → home dir → its parent); Managed/
    // User rules match relative to the session's original cwd.
    const baseDir =
      type === 'Project'
        ? dirname(dirname(rulesDir))
        : getOriginalCwd()

    const relativePath = isAbsolute(targetPath)
      ? relative(baseDir, targetPath)
      : targetPath
    // Pre-filter what the ignore library would THROW on: the empty string,
    // a base-escaping ../ path, and an absolute path (Windows cross-drive
    // relative() yields absolutes). None of these could match a
    // baseDir-relative glob anyway — false is the honest answer.
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
