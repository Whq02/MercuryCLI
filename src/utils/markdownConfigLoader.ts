// ============================================================================
//  Markdown-defined configuration discovery: commands, agents, output
//  styles, skills and workflows across managed / user / project scopes,
//  with physical-identity dedup and a memoized cache.
//
//  Priority reads managed > user > project (concatenation order, first
//  occurrence wins at dedup); project directories are most-specific first.
//  Identity is the path plus a digest of the discovered bytes — the raw
//  bytes ride on every record.
// ============================================================================

import { statSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getMercuryHome } from './envUtils.js'
import { normalizePathForComparison } from './file.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { parseFrontmatter, type FrontmatterData } from './frontmatterParser.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { isRestrictedToExtensionsOnly } from './settings/extensionOnlyPolicy.js'
import {
  MERCURY_PROJECT_DIR,
  PROJECT_CONFIG_DIR_NAMES,
} from './projectConfig.js'
import { ripGrepAnswer } from './ripgrep.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'

/** The configuration directory names (contract data — on-disk names). */
export const MERCURY_CONFIG_DIRECTORIES = [
  'commands',
  'agents',
  'skills',
  'workflows',
] as const

export type MercuryConfigDirectory = (typeof MERCURY_CONFIG_DIRECTORIES)[number]

export type MarkdownFile = {
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  /** The exact bytes as read — identity is path + a digest of these. */
  rawContent: string
  source: 'policySettings' | 'userSettings' | 'projectSettings'
  /** Carried from parseFrontmatter: a present block that failed to parse. Loaders fail CLOSED on it. */
  parseError?: { message: string }
}

// ── description extraction ──────────────────────────────────────────────────

/** First non-empty trimmed body line; a leading heading-marker run followed
 *  by at least one space is stripped (a bare `#word` is kept whole); longer
 *  than 100 characters cuts at 97 with a three-dot ellipsis; no non-empty
 *  line yields the caller's default. */
export function extractDescriptionFromMarkdown(
  content: string,
  defaultDescription: string = 'a custom configuration',
): string {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const withoutHeading = line.replace(/^#+ +/, '')
    if (withoutHeading.length > 100) return `${withoutHeading.slice(0, 97)}...`
    return withoutHeading
  }
  return defaultDescription
}

// ── tool-list parsing ───────────────────────────────────────────────────────

function toToolStrings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return undefined
}

/** Agent frontmatter: a MISSING field means all tools (no restriction); an
 *  explicitly empty value means no tools; a wildcard anywhere collapses to
 *  all tools. A PRESENT value the parser cannot read yields NO tools — a
 *  malformed restriction must never widen to the full grant (FC-142); lanes
 *  with a refusal channel refuse the definition instead (see
 *  agentToolsFrontmatterProblem). */
export function parseAgentToolsFromFrontmatter(value: unknown): string[] | undefined {
  // The codec's law, read back exactly: an ABSENT key is all tools
  // (undefined); a PRESENT key with an empty value (`tools:` — the empty list
  // the encoder emits) is NO tools ([]). The absent arm comes FIRST: the
  // unreadable-primitive arm below narrows every shape it cannot read, and
  // `undefined` fell through to it — so a definition with no tools line at
  // all (the studio's fresh document, any discovered file naming none)
  // loaded with NO tools, and the form read "none" for "all tools".
  if (value === undefined) return undefined
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return []
  // The natural boolean spellings: `tools: false` says NO tools — the one
  // reading it must never have is the widest grant; `tools: true` says all.
  if (value === false) return []
  if (value === true) return undefined
  // The trailing-colon typo: a YAML mapping under `tools:` (`Read:` /
  // `Grep:`) carries the operator's tool names as its KEYS.
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>).filter(k => k.trim() !== '')
    if (keys.length === 0) return []
    const parsedKeys = parseToolListFromCLI(keys)
    return parsedKeys.includes('*') ? undefined : parsedKeys
  }
  const raw = toToolStrings(value)
  if (raw === undefined) return [] // unreadable primitive — narrow, never widen
  const parsed = parseToolListFromCLI(raw)
  if (parsed.includes('*')) return undefined
  return parsed
}

/**
 * A PRESENT tools/disallowedTools frontmatter value the parser cannot fully
 * read, described for a diagnostic; null for readable shapes. Callers with a
 * refusal channel (the agent document codec) refuse the whole definition on
 * a non-null answer — for an ALLOW list an unreadable value silently
 * narrowing is survivable, but for a DENY list dropping unread entries
 * WIDENS, so the definition must not activate on either (FC-142).
 */
export function agentToolsFrontmatterProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' || typeof value === 'boolean') return null
  if (Array.isArray(value)) {
    const dropped = value.filter(v => typeof v !== 'string').length
    return dropped > 0 ? `a list carrying ${dropped} non-string entr${dropped === 1 ? 'y' : 'ies'}` : null
  }
  if (typeof value === 'object') return null // mapping — keys are readable
  return `a ${typeof value} where a tool list belongs`
}

/** Slash-command frontmatter: missing or empty means no tools; a wildcard
 *  collapses to a single wildcard entry. */
export function parseSlashCommandToolsFromFrontmatter(value: unknown): string[] {
  const raw = toToolStrings(value)
  if (raw === undefined) return []
  const parsed = parseToolListFromCLI(raw)
  if (parsed.includes('*')) return ['*']
  return parsed
}

// ── the project directory walk ──────────────────────────────────────────────

/** Existence via a SYNCHRONOUS stat whose unexpected errors re-throw —
 *  only "missing or inaccessible" is swallowed. The filter is both a
 *  performance measure and a precondition for the worktree fallback. */
function configDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return false
    }
    throw error
  }
}

function isInsideTree(path: string, root: string): boolean {
  const normalizedPath = normalizePathForComparison(path)
  const normalizedRoot = normalizePathForComparison(root)
  return (
    normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
  )
}

/**
 * Walk from the working directory upward collecting
 * `<dir>/<home>/<subdir>` for every project-config home, stopping before
 * the user's home directory (loaded separately as the user scope) and
 * after the repository boundary.
 *
 * The boundary is normally the nearest repository root — but when the
 * shell has changed directory into a NESTED, DIFFERENT repository inside
 * the session's project (a submodule or vendored clone; a worktree
 * resolves back to the main repository and keeps the nearest stop), the
 * boundary widens to the session project's root so the parent project's
 * configuration stays reachable. Sibling repositories keep the nearest
 * stop.
 */
export function getProjectDirsUpToHome(subdir: string, cwd: string): string[] {
  const home = normalizePathForComparison(resolve(homedir()).normalize('NFC'))
  const nearestRoot = findGitRoot(cwd)

  let boundary = nearestRoot
  if (nearestRoot) {
    const sessionRoot = findGitRoot(getOriginalCwd())
    if (
      sessionRoot &&
      normalizePathForComparison(nearestRoot) !== normalizePathForComparison(sessionRoot)
    ) {
      const nearestCanonical = findCanonicalGitRoot(nearestRoot)
      const sessionCanonical = findCanonicalGitRoot(sessionRoot)
      if (
        nearestCanonical &&
        sessionCanonical &&
        normalizePathForComparison(nearestCanonical) !==
          normalizePathForComparison(sessionCanonical) &&
        isInsideTree(nearestRoot, sessionRoot)
      ) {
        boundary = sessionRoot
      }
    }
  }

  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    if (normalizePathForComparison(current) === home) break
    for (const homeName of PROJECT_CONFIG_DIR_NAMES) {
      const candidate = join(current, homeName, subdir)
      if (configDirExists(candidate)) dirs.push(candidate)
    }
    if (boundary && normalizePathForComparison(current) === normalizePathForComparison(boundary)) {
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

// ── file discovery ──────────────────────────────────────────────────────────

const DISCOVERY_TIMEOUT_MS = 3000

/** The native walker: follows symlinks (resolving and recursing), detects
 *  cycles by device+inode with a real-path fallback, and logs and skips
 *  anything unreadable rather than aborting the walk. Ignore files are not
 *  respected by either walker. */
async function nativeWalk(dir: string): Promise<string[]> {
  const out: string[] = []
  const visited = new Set<string>()
  const walk = async (current: string): Promise<void> => {
    let key: string
    try {
      const info = await stat(current, { bigint: true })
      key = `${info.dev}:${info.ino}`
      if (key === '0:0') {
        key = await realpath(current)
      }
    } catch {
      try {
        key = await realpath(current)
      } catch (error) {
        logForDebugging(`markdownConfigLoader: skipping unreadable ${current}: ${String(error)}`)
        return
      }
    }
    if (visited.has(key)) return
    visited.add(key)
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      logForDebugging(`markdownConfigLoader: skipping unreadable ${current}: ${String(error)}`)
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isSymbolicLink()) {
        try {
          const resolved = await realpath(full)
          const info = await stat(resolved)
          if (info.isDirectory()) await walk(resolved)
          else if (resolved.toLowerCase().endsWith('.md')) out.push(full)
        } catch (error) {
          logForDebugging(`markdownConfigLoader: skipping unreadable ${full}: ${String(error)}`)
        }
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

/** Discover markdown files under a directory. Existence is deliberately not
 *  pre-checked (a check would open a TOCTOU window); a missing or
 *  inaccessible directory yields an empty list. A missing SEARCH BINARY is
 *  not a missing directory: the native walk answers instead, so an agent,
 *  skill or command estate is never hidden by the engine's absence. */
async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const files = await (async (): Promise<string[]> => {
    try {
      const answer = await ripGrepAnswer(
        // --iglob, not --glob (FC-112): the globset is case-sensitive by
        // default, so an agent/command/skill file named Upper.MD was
        // invisible — with no diagnostic — on the very filesystems that
        // treat the two names as the same file. The native fallback walk
        // (nativeWalk) folds case the same way.
        ['--files', '--hidden', '--follow', '--no-ignore', '--iglob', '*.md'],
        dir,
        AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      )
      // A PARTIAL estate is the one answer this caller must never take: a
      // short list of agent, skill and command files reads as the whole
      // estate (FN-015 rank 10). An unfinished walk degrades to the native
      // walk, loudly — the same road a refused search takes.
      if (!answer.complete) {
        logError(new Error(`markdownConfigLoader: the discovery walk under ${dir} did not finish (${answer.reason ?? 'unknown'}) — walking natively`))
        return nativeWalk(dir)
      }
      return answer.lines
    } catch (error) {
      if (isSearchBinaryMissing(error)) {
        logForDebugging(`markdownConfigLoader: search binary unavailable — walking ${dir} natively`)
        return nativeWalk(dir)
      }
      // A search the engine REFUSED is not an empty estate (FC-041): the
      // usage error was swallowed and `mercury agents` printed a complete-
      // looking inventory with the whole discovered estate missing, exit 0.
      // With --no-config on every invocation (FC-040) the operator-rc vector
      // is gone; a residual refusal is a product bug — logged loudly, and the
      // walk degrades to the native fallback rather than an empty answer.
      logError(error)
      logForDebugging(`markdownConfigLoader: discovery refused under ${dir} — walking natively`, { level: 'error' })
      return nativeWalk(dir)
    }
  })()
  // C15 (order-is-a-fingerprint): rg's parallel walk and the native readdir
  // both list in filesystem order — nondeterministic across boots and
  // platforms — and a same-name definition's dedupe winner rode that order.
  // ONE sort makes every boot's roster identical; tier priority is the
  // caller's concatenation, untouched.
  return files.sort()
}

/** The engine's own absence (a spawn ENOENT on the binary), as opposed to a
 *  directory that is missing or unreadable. */
function isSearchBinaryMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const text = String((error as { message?: unknown } | null)?.message ?? error)
  return code === 'ENOENT' || text.includes('search binary was not found')
}

async function loadDirectory(
  dir: string,
  source: MarkdownFile['source'],
): Promise<MarkdownFile[]> {
  const paths = await discoverMarkdownFiles(dir)
  // Concurrent per-file reads (the sibling dedupeByIdentity's own shape):
  // the serial await paid N sequential seek+read latencies at every boot for
  // every scope of both subdirs. Promise.all preserves `paths` order, so
  // the C15 sorted roster — and the dedupe winner that rides it — is
  // byte-identical to the serial walk's.
  const loaded = await Promise.all(
    paths.map(async filePath => {
      try {
        const rawContent = await readFile(filePath, 'utf8')
        const parsed = parseFrontmatter(rawContent, filePath)
        return {
          filePath,
          baseDir: dir,
          frontmatter: parsed.frontmatter,
          content: parsed.content,
          rawContent,
          source,
          ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
        } satisfies MarkdownFile
      } catch (error) {
        // A read or parse failure drops that one file, never the batch.
        logForDebugging(`markdownConfigLoader: dropping ${filePath}: ${String(error)}`)
        return null
      }
    }),
  )
  return loaded.filter((f): f is MarkdownFile => f !== null)
}

// ── physical-identity dedup ─────────────────────────────────────────────────

/**
 * Deduplicate by device + inode, read as BIG INTEGERS (large inodes on some
 * filesystems collide after rounding to doubles). The identity stat does
 * not follow a FINAL symlink — a symlink file keeps its own identity; what
 * dedupes is the same real file through a symlinked directory. An
 * unobtainable identity keeps the file (fail open), and an all-zero
 * identity is unreliable and also keeps it (network/FUSE mounts report
 * zeros for everything). First occurrence wins — the highest-priority copy
 * given the managed→user→project order.
 */
async function dedupeByIdentity(files: MarkdownFile[]): Promise<MarkdownFile[]> {
  const identities = await Promise.all(
    files.map(async file => {
      try {
        const info = await lstat(file.filePath, { bigint: true })
        if (info.dev === 0n && info.ino === 0n) return null
        return `${info.dev}:${info.ino}`
      } catch {
        return null
      }
    }),
  )
  const seen = new Map<string, MarkdownFile>()
  const out: MarkdownFile[] = []
  let dropped = 0
  for (let i = 0; i < files.length; i++) {
    const identity = identities[i]
    const file = files[i]!
    if (identity === null) {
      out.push(file)
      continue
    }
    const prior = seen.get(identity)
    if (prior) {
      dropped++
      logForDebugging(
        `markdownConfigLoader: duplicate ${file.filePath} (${file.source}) already provided by ${prior.source}`,
      )
      continue
    }
    seen.set(identity, file)
    out.push(file)
  }
  if (dropped > 0) {
    logForDebugging(`markdownConfigLoader: removed ${dropped} duplicate file(s)`)
  }
  return out
}

// ── assembly (memoized on subdir + working directory) ───────────────────────

async function loadMarkdownFilesUncached(subdir: string, cwd: string): Promise<MarkdownFile[]> {
  // The managed root loads the Mercury-native layout; managed files always
  // load. getManagedFilePath() IS the managed root — the dirname it once
  // took here resolved a second, divergent root one level above it, while
  // rules and skills loaded from under the real one (field F-2.3).
  const managedRoot = getManagedFilePath()
  const managedDir = join(managedRoot, MERCURY_PROJECT_DIR, subdir)

  const agentsAllowed = subdir !== 'agents' || !isRestrictedToExtensionsOnly('agents')
  const userAllowed = isSettingSourceEnabled('userSettings') && agentsAllowed
  const projectAllowed = isSettingSourceEnabled('projectSettings') && agentsAllowed

  const projectDirs = projectAllowed ? getProjectDirsUpToHome(subdir, cwd) : []

  // The worktree fallback: when the repository root differs from its
  // canonical root, homes whose worktree copy was NOT collected append the
  // canonical repository's copy — blind, without a stat (an absent
  // directory simply loads as empty). A standard worktree checks out the
  // full tree, so an unconditional add would duplicate everything.
  if (projectAllowed) {
    const worktreeRoot = findGitRoot(cwd)
    const canonicalRoot = findCanonicalGitRoot(cwd)
    if (
      worktreeRoot &&
      canonicalRoot &&
      normalizePathForComparison(worktreeRoot) !== normalizePathForComparison(canonicalRoot)
    ) {
      for (const homeName of PROJECT_CONFIG_DIR_NAMES) {
        const worktreeCopy = join(worktreeRoot, homeName, subdir)
        if (!projectDirs.some(d => normalizePathForComparison(d) === normalizePathForComparison(worktreeCopy))) {
          projectDirs.push(join(canonicalRoot, homeName, subdir))
        }
      }
    }
  }

  const [managed, user, project] = await Promise.all([
    loadDirectory(managedDir, 'policySettings'),
    userAllowed
      ? loadDirectory(join(getMercuryHome(), subdir), 'userSettings')
      : Promise.resolve([] as MarkdownFile[]),
    Promise.all(projectDirs.map(dir => loadDirectory(dir, 'projectSettings'))).then(groups =>
      groups.flat(),
    ),
  ])

  return dedupeByIdentity([...managed, ...user, ...project])
}

/** Memoized on the (subdirectory, working directory) pair; the memoiser's
 *  cache handle rides on the function itself. */
export const loadMarkdownFilesForSubdir = memoize(
  (subdir: string, cwd: string): Promise<MarkdownFile[]> =>
    loadMarkdownFilesUncached(subdir, cwd),
  (subdir: string, cwd: string) => `${subdir}|${cwd}`,
)

/** Clear the whole memo. The underlying cache cannot enumerate its keys —
 *  other subdirectories simply re-scan lazily. Hot-reload watchers must
 *  call this; clearing only a higher-level definition cache would keep
 *  serving stale file lists from here. */
export function clearMarkdownFileCache(): void {
  loadMarkdownFilesForSubdir.cache.clear?.()
}
