/**
 * THE file read/write permission engine: dangerous-path detection,
 * working-directory containment, gitignore-style rule matching, internal-path
 * carve-outs, and suggestion generation. All of it is fail-closed and
 * ordered — deny beats ask beats allow, and safety checks run before allow
 * rules.
 */
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { sep as platformSep, posix as posixPath } from 'node:path'
import ignore from 'ignore'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../cwd.js'
import { permissionRuleValueFromString } from './permissionRuleParser.js'
import { getMercuryHome } from '../envUtils.js'
import { getFsImplementation, getPathsForPermissionCheck, safeResolvePath } from '../fsOperations.js'
import { logForDebugging } from '../debug.js'
import {
  containsPathTraversal,
  expandPath,
  getDirectoryForPath,
  sanitizePath,
} from '../path.js'
import { getPlatform } from '../platform.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { PROJECT_CONFIG_DIR_NAMES, apolloSpecDirectory } from '../projectConfig.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import type { PermissionRule, PermissionUpdate } from '../../types/permissions.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionDecision, PermissionResult } from './PermissionResult.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'

// ─────────────────────────────────────────────────────────────────────────────
// Contract data: dangerous files and directories
// ─────────────────────────────────────────────────────────────────────────────

/** Auto-editing is refused for any path whose final segment is one of these. */
export const DANGEROUS_FILES: string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
  '.mercury.json',
]

/** Auto-editing is refused for any path containing one of these segments. */
export const DANGEROUS_DIRECTORIES: string[] = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.mercury',
]

const CONFIG_HOME_SEGMENTS = ['.claude', '.mercury']

// ─────────────────────────────────────────────────────────────────────────────
// Path normalisation primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Case-fold a path for every security comparison (all platforms). */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

/** Convert a native path to POSIX form on Windows; pass through elsewhere. */
export function toPosixPath(path: string): string {
  return getPlatform() === 'windows' ? windowsPathToPosixPath(path) : path
}

/** The POSIX relative path from `from` to `to` (Windows-aware). */
export function relativePath(from: string, to: string): string {
  const a = toPosixPath(from)
  const b = toPosixPath(to)
  // Both operands are POSIX-normalised above, so split on the POSIX separator.
  const aParts = a.split(posixPath.sep).filter(Boolean)
  const bParts = b.split(posixPath.sep).filter(Boolean)
  let i = 0
  while (i < aParts.length && i < bParts.length && aParts[i] === bParts[i]) i++
  const up = aParts.slice(i).map(() => '..')
  const down = bParts.slice(i)
  return [...up, ...down].join('/')
}

/** macOS symlink folding, applied at the START of the string only. */
function foldMacSymlinks(path: string): string {
  let folded = path
  if (folded.startsWith('/private/var/')) {
    folded = '/var/' + folded.slice('/private/var/'.length)
  }
  if (folded === '/private/tmp' || folded.startsWith('/private/tmp/')) {
    folded = '/tmp' + folded.slice('/private/tmp'.length)
  }
  return folded
}

/** Normalise both sides for a working-directory comparison. */
function normalizeForWorkingDirCompare(path: string): string {
  return normalizeCaseForComparison(toPosixPath(foldMacSymlinks(path)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Working-directory containment
// ─────────────────────────────────────────────────────────────────────────────

/** All allowed working directories: the launch cwd plus registered extras. */
export function allWorkingDirectories(context: ToolPermissionContext): Set<string> {
  const dirs = new Set<string>([getOriginalCwd()])
  const additional = (context as unknown as { additionalWorkingDirectories?: ReadonlyMap<string, unknown> })
    .additionalWorkingDirectories
  if (additional) {
    for (const dir of additional.keys()) dirs.add(dir)
  }
  return dirs
}

/** Whether a path sits inside a working path (same path or a contained child). */
export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const rel = relativePath(normalizeForWorkingDirCompare(workingPath), normalizeForWorkingDirCompare(path))
  if (rel === '') return true // same path
  if (rel.startsWith('..')) return false // traversal
  if (rel.startsWith('/')) return false // absolute
  return true
}

let workingDirResolutionCache = new Map<string, string[]>()

/** Resolve a path to its full symlink resolution set (memoised for the session). */
export function getResolvedWorkingDirPaths(path: string): string[] {
  const cached = workingDirResolutionCache.get(path)
  if (cached) return cached
  const resolved = getPathsForPermissionCheck(path)
  workingDirResolutionCache.set(path, resolved)
  return resolved
}
getResolvedWorkingDirPaths.clearCache = (): void => {
  workingDirResolutionCache = new Map()
}

/**
 * Whether a path lands inside SOME allowed working directory. The REAL
 * targets decide: every symlink-resolved form of the path must be inside
 * (one escaping form denies — a link inside the tree pointing out is an
 * escape). The spelling as typed is an alias of those targets and counts on
 * its own only when nothing resolved past it — so a path spelled through a
 * symlinked ancestor (macOS `/var` → `/private/var`, a linked project root)
 * whose real target sits in the tree is inside, not an escape. Working
 * directories are themselves expanded so the two sides are symmetric.
 */
export function pathInAllowedWorkingPath(
  path: string,
  context: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  const resolvedInputs = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(path)
  const workingDirs = [...allWorkingDirectories(context)].flatMap(getResolvedWorkingDirPaths)
  const inside = (candidate: string): boolean =>
    workingDirs.some(workingDir => pathInWorkingPath(candidate, workingDir))
  const [spelled, ...realForms] = resolvedInputs
  if (realForms.length === 0) return spelled !== undefined && inside(spelled)
  return realForms.every(inside)
}

// ─────────────────────────────────────────────────────────────────────────────
// Dangerous + suspicious paths
// ─────────────────────────────────────────────────────────────────────────────

/** A path starting with `\\` or `//` is a defence-in-depth UNC block. The
 *  `\\?\` / `\\.\` device prefixes are LOCAL spellings, not network shares —
 *  they classify under the suspicious-pattern ask (their true reason) —
 *  except `\\?\UNC\…`, the extended spelling of a real network share. */
function isRawUnc(rawPath: string): boolean {
  if (/^(?:\\\\|\/\/)[?.][\\/]/.test(rawPath)) {
    return /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/]/i.test(rawPath)
  }
  return rawPath.startsWith('\\\\') || rawPath.startsWith('//')
}

/**
 * Whether the UNC block applies to a path: a raw UNC spelling is refused as
 * an incidental network reach EXCEPT when it resolves inside an allowed
 * working directory. A share-hosted workspace (\\fileserver\dev\proj — a
 * UNC cwd is ordinary in PowerShell and Windows Terminal; an enterprise
 * redirected home makes the config home itself UNC) is the operator's own
 * tree, and the blanket block prompted per file with no grant able to
 * clear it, because the rungs that consult rules sat below the block
 * (FN-015 rank 31). Without a context there is nothing to exempt against
 * and the block stands.
 */
function uncBlockApplies(
  path: string,
  resolutionSet: readonly string[],
  context: ToolPermissionContext | undefined,
): boolean {
  if (!resolutionSet.some(isRawUnc)) return false
  if (context === undefined) return true
  return !pathInAllowedWorkingPath(path, context, resolutionSet)
}

/** Whether an expanded path targets a dangerous file or directory. The UNC
 *  arm stands down only when the caller has established the exemption. */
function isDangerousFileOrDirectory(rawPath: string, expandedPath: string, uncExempt = false): boolean {
  if (!uncExempt && isRawUnc(rawPath)) return true

  const segments = expandedPath.split(platformSep)
  const lastSegment = segments[segments.length - 1] ?? ''
  // File-name test on the last segment of the expanded path.
  if (DANGEROUS_FILES.some(name => name.toLowerCase() === lastSegment.toLowerCase())) {
    return true
  }
  // Directory-segment test, with the config-home/worktrees carve-out.
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]?.toLowerCase() ?? ''
    if (CONFIG_HOME_SEGMENTS.includes(segment) && segments[i + 1]?.toLowerCase() === 'worktrees') {
      continue // structural worktree path, not a config directory
    }
    if (DANGEROUS_DIRECTORIES.some(name => name.toLowerCase() === segment)) {
      return true
    }
  }
  return false
}

const DOS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** Suspicious Windows path patterns (checked on all platforms except where noted). */
function suspiciousWindowsPattern(path: string): string | null {
  const platform = getPlatform()
  const onWindows = platform === 'windows' || platform === 'wsl'

  // NTFS alternate data streams — a colon at index >= 2 (skipping drive letters).
  if (onWindows && /^.{2,}?:/.test(path.slice(2)) === false) {
    // fallthrough handled below via explicit scan
  }
  if (onWindows) {
    for (let i = 2; i < path.length; i++) {
      if (path[i] === ':') return 'NTFS alternate data stream'
    }
  }
  // 8.3 short name — a tilde followed by a digit.
  if (/~\d/.test(path)) return '8.3 short name'
  // Long-path / device prefixes.
  if (/^(?:\\\\\?\\|\\\\\.\\|\/\/\?\/|\/\/\.\/)/.test(path)) return 'long-path or device prefix'
  // Trailing dots or whitespace.
  if (/[.\s]$/.test(path)) return 'trailing dot or whitespace'
  // DOS device name as the final extension.
  const finalExt = path.split(/[./\\]/).pop()?.toLowerCase() ?? ''
  if (DOS_DEVICE_NAMES.has(finalExt)) return 'DOS device name'
  // Three or more consecutive dots as a whole path component.
  if (/(?:^|[/\\])\.{3,}(?:[/\\]|$)/.test(path)) return 'consecutive dots as a path component'
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Temp / scratch directories
// ─────────────────────────────────────────────────────────────────────────────

/** The per-user temp directory name (post-rename). */
export function getMercuryTempDirName(): string {
  if (getPlatform() === 'windows') return 'mercury'
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `mercury-${uid}`
}

let tempDirCache: string | null = null

/** The temp directory root (resolved, Mercury-named, ending in a separator).
 *
 *  Mercury-named ONLY. The pre-rename root (`claude` on Windows,
 *  `claude-<uid>` elsewhere) used to be adopted when the Mercury root was
 *  absent — but that name is the LIVE temp root of another harness on the
 *  same box, so a fresh Mercury adopted a foreign program's directory and
 *  printed that vendor-lineage path back to the model (TASK-014 w4-f01-02).
 *  Nothing durable ever lived under a temp root (task outputs, shell
 *  snapshots — all regenerated), so the honor carried no state worth the
 *  collision; identity ruling 3 is amended to this. */
export function getMercuryTempDir(): string {
  if (tempDirCache) return tempDirCache
  const envBase = process.env.MERCURY_TMPDIR
  const base = envBase ?? (getPlatform() === 'windows' ? tmpdir() : '/tmp')
  let resolvedBase = base
  try {
    resolvedBase = safeResolvePath(getFsImplementation(), base).resolvedPath
  } catch {
    resolvedBase = base
  }
  tempDirCache = ensureTrailingSep(joinWithSep(resolvedBase, getMercuryTempDirName()))
  return tempDirCache
}

/** The project temp directory: temp root + sanitised cwd, trailing separator. */
export function getProjectTempDir(): string {
  return ensureTrailingSep(joinWithSep(getMercuryTempDir(), sanitizePath(getOriginalCwd())))
}

/** The scratchpad directory: project temp + session id + `scratchpad`, no trailing separator. */
export function getScratchpadDir(): string {
  return joinWithSep(joinWithSep(getProjectTempDir(), getSessionId()), 'scratchpad')
}

/** Whether the scratchpad feature is enabled (cached gate `mercury_scratch`). */
export function isScratchpadEnabled(): boolean {
  return checkFeatureGate_CACHED_MAY_BE_STALE('mercury_scratch')
}

/** Ensure the scratchpad directory exists; throws when the feature is disabled. */
export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('The scratchpad feature is disabled.')
  }
  const dir = getScratchpadDir()
  await getFsImplementation().mkdir(dir, { mode: 0o700 })
  try {
    const { registerScratchLease } = await import('../scratchLeases.js')
    registerScratchLease(getSessionId() as never, dir, {
      recovery: 'Scratch space for a single Mercury session; safe to remove once that session is over.',
    })
  } catch {
    // The directory already exists at this point; a failure to record its
    // lease is bookkeeping, not a reason to withhold the scratchpad.
  }
  return dir
}

/** The session-memory directory (trailing separator). */
export function getSessionMemoryDir(): string {
  const projectDir = joinWithSep(getProjectTempDir(), getSessionId())
  return ensureTrailingSep(joinWithSep(projectDir, 'session-memory'))
}

/** The session-memory summary file. */
export function getSessionMemoryPath(): string {
  return joinWithSep(getSessionMemoryDir(), 'summary.md')
}

let bundledSkillsRootCache: string | null = null

/** The bundled-skills extraction root: temp root + version + a random 16-byte nonce. */
export function getBundledSkillsRoot(): string {
  if (bundledSkillsRootCache) return bundledSkillsRootCache
  const version = (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ?? '0.0.0'
  const nonce = randomBytes(16).toString('hex')
  bundledSkillsRootCache = joinWithSep(joinWithSep(getMercuryTempDir(), `bundled-skills`), `${version}-${nonce}`)
  return bundledSkillsRootCache
}

// ─────────────────────────────────────────────────────────────────────────────
// Path safety for auto-edit + settings/config paths
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a normalised path ends with a settings-json suffix under a config home. */
export function isClaudeSettingsPath(filePath: string): boolean {
  const expanded = expandPath(filePath)
  const folded = normalizeCaseForComparison(expanded)
  const sep = platformSep.toLowerCase()
  for (const home of CONFIG_HOME_SEGMENTS) {
    for (const file of ['settings.json', 'settings.local.json']) {
      if (folded.endsWith(`${sep}${home}${sep}${file}`)) return true
    }
  }
  // An exact match against any current settings source's resolved path.
  for (const source of getEnabledSettingSources()) {
    try {
      const path = getSettingsFilePathForSource(source as never)
      if (path && normalizeCaseForComparison(expandPath(path)) === folded) return true
    } catch {
      // ignore sources without a file path
    }
  }
  return false
}

/** Whether a path is a product config-file path (settings or config-estate subtree). */
function isProductConfigPath(expandedPath: string): boolean {
  if (isClaudeSettingsPath(expandedPath)) return true
  const cwd = getOriginalCwd()
  const folded = normalizeCaseForComparison(expandedPath)
  for (const home of PROJECT_CONFIG_DIR_NAMES) {
    for (const sub of ['commands', 'agents', 'skills']) {
      const base = normalizeCaseForComparison(joinWithSep(joinWithSep(cwd, home), sub))
      if (pathHasSegmentContainment(folded, base)) return true
    }
  }
  return false
}

/** True when `path` equals `base` or sits under it with proper segment boundary. */
function pathHasSegmentContainment(path: string, base: string): boolean {
  if (path === base) return true
  const baseWithSep = base.endsWith(platformSep.toLowerCase()) ? base : base + platformSep.toLowerCase()
  return path.startsWith(baseWithSep)
}

/** The result of the auto-edit safety check. */
type PathSafetyResult =
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean }

/**
 * Check path safety for an auto-edit. The three checks sweep the whole
 * resolution set one at a time; every message names the ORIGINAL argument.
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
  context?: ToolPermissionContext,
): PathSafetyResult {
  const resolvedForms = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(path)
  // The UNC exemption: a share-hosted path inside an allowed working
  // directory is the operator's own tree (see uncBlockApplies).
  const uncExempt = !uncBlockApplies(path, resolvedForms, context)

  // 1. Suspicious Windows patterns → unsafe, NOT classifier-approvable.
  for (const resolved of resolvedForms) {
    const pattern = suspiciousWindowsPattern(resolved)
    if (pattern) {
      return {
        safe: false,
        classifierApprovable: false,
        message: `Mercury requested permission to write to ${path}, which contains a suspicious Windows path pattern (${pattern}) and requires manual approval.`,
      }
    }
  }
  // 2. Product config-file paths → unsafe, classifier-approvable.
  for (const resolved of resolvedForms) {
    if (isProductConfigPath(expandPath(resolved))) {
      return {
        safe: false,
        classifierApprovable: true,
        message: `Permission to write to ${path} was requested but not yet granted.`,
      }
    }
  }
  // 3. Dangerous files/directories → unsafe, classifier-approvable.
  for (const resolved of resolvedForms) {
    if (isDangerousFileOrDirectory(path, expandPath(resolved), uncExempt)) {
      return {
        safe: false,
        classifierApprovable: true,
        message: `Mercury requested permission to edit ${path}, which is a sensitive file.`,
      }
    }
  }
  return { safe: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill scoping
// ─────────────────────────────────────────────────────────────────────────────

/** Locate a skill directory for a path and produce a narrowed session pattern. */
export function getClaudeSkillScope(filePath: string): { skillName: string; pattern: string } | null {
  const cwd = getOriginalCwd()
  const globalConfigHome = getMercuryHome()
  const bases: Array<{ dir: string; prefix: string }> = [
    { dir: joinWithSep(joinWithSep(cwd, '.mercury'), 'skills'), prefix: '/.mercury/skills/' },
    { dir: joinWithSep(globalConfigHome, 'skills'), prefix: '~/.mercury/skills/' },
  ]

  const expanded = expandPath(filePath)
  const foldedPath = normalizeCaseForComparison(expanded)

  for (const { dir, prefix } of bases) {
    for (const separator of [platformSep, '/']) {
      const baseWithSep = normalizeCaseForComparison(dir) + separator
      if (!foldedPath.startsWith(baseWithSep)) continue
      // The skill name is the first segment under the base, sliced from the
      // ORIGINAL (case-preserving) path.
      const afterBase = expanded.slice(dir.length + separator.length)
      const nextSep = afterBase.search(/[/\\]/)
      if (nextSep === -1) return null // no separator after the base
      const skillName = afterBase.slice(0, nextSep)
      if (skillName === '' || skillName === '.' || skillName.includes('..')) return null
      if (/[*?[\]]/.test(skillName)) return null // a glob-metachar name would widen the rule
      return { skillName, pattern: `${prefix}${skillName}/**` }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal path carve-outs
// ─────────────────────────────────────────────────────────────────────────────

/** Editable-without-permission classifier. Allow or passthrough. */
export function checkEditableInternalPath(absolutePath: string, _input: unknown): PermissionResult {
  const path = expandPath(absolutePath)
  const category = editableInternalCategory(path)
  if (category) {
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: category },
    } as unknown as PermissionResult
  }
  return { behavior: 'passthrough', message: '' } as unknown as PermissionResult
}

/** Readable-without-permission classifier. Allow or passthrough. */
export function checkReadableInternalPath(absolutePath: string, _input: unknown): PermissionResult {
  const path = expandPath(absolutePath)
  const category = readableInternalCategory(path)
  if (category) {
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: category },
    } as unknown as PermissionResult
  }
  return { behavior: 'passthrough', message: '' } as unknown as PermissionResult
}

/** Whether a path sits under the session's plan directory. */
function isPlanFilePath(folded: string): boolean {
  try {
    const plans = normalizeCaseForComparison((require('../plans.js') as { getPlansDirectory(): string }).getPlansDirectory())
    return folded === plans || folded.startsWith(plans + platformSep.toLowerCase()) || folded.startsWith(plans + '/')
  } catch {
    return false
  }
}
function isAgentMemory(path: string): boolean {
  try {
    return (require('../../tools/AgentTool/agentMemory.js') as { isAgentMemoryPath(p: string): boolean }).isAgentMemoryPath(path)
  } catch {
    return false
  }
}
function isAutoMemory(path: string): boolean {
  try {
    return (require('../../memdir/paths.js') as { isAutoMemPath(p: string): boolean }).isAutoMemPath(path)
  } catch {
    return false
  }
}
function autoMemoryOverridden(): boolean {
  try {
    return (require('../../memdir/paths.js') as { hasAutoMemPathOverride(): boolean }).hasAutoMemPathOverride()
  } catch {
    return false
  }
}

function editableInternalCategory(path: string): string | null {
  if (isSessionScratchpad(path)) return 'session scratchpad'
  const folded = normalizeCaseForComparison(path)
  const cwd = getOriginalCwd()
  for (const home of ['.mercury', '.claude']) {
    if (folded === normalizeCaseForComparison(joinWithSep(joinWithSep(cwd, home), 'launch.json'))) {
      return 'preview launch config'
    }
  }
  if (isPlanFilePath(folded)) return 'session plan file'
  if (isAgentMemory(path)) return 'agent-memory directory'
  // The auto-memory directory gets no write carve-out when a path override is
  // set — that path goes through the normal flow (a hostile override must not
  // gain silent write access).
  if (!autoMemoryOverridden() && isAutoMemory(path)) return 'auto-memory directory'
  return null
}

function readableInternalCategory(path: string): string | null {
  if (isSessionScratchpad(path)) return 'session scratchpad'
  const folded = normalizeCaseForComparison(path)
  const projectTemp = normalizeCaseForComparison(getProjectTempDir())
  if (folded.startsWith(projectTemp)) return 'project temp directory'
  const sessionMemory = normalizeCaseForComparison(getSessionMemoryDir())
  if (folded.startsWith(sessionMemory)) return 'session memory directory'
  const tasksDir = normalizeCaseForComparison(joinWithSep(getMercuryHome(), 'tasks'))
  if (pathHasSegmentContainment(folded, tasksDir)) return 'tasks directory'
  const teamsDir = normalizeCaseForComparison(joinWithSep(getMercuryHome(), 'teams'))
  if (pathHasSegmentContainment(folded, teamsDir)) return 'teams directory'
  const bundledRoot = normalizeCaseForComparison(getBundledSkillsRoot())
  if (folded.startsWith(bundledRoot)) return 'bundled-skill extraction root'
  // Past-session memory reads live in the per-project session-storage
  // directory (projects/<slug> under the user config home), so that is the
  // anchor — the working tree needs no carve-out here, the working-path
  // rules already allow reading it.
  try {
    const projectStore = normalizeCaseForComparison(
      (require('../sessionStoragePortable.js') as { getProjectDir(p: string): string }).getProjectDir(getCwd()),
    )
    if (folded === projectStore || folded.startsWith(projectStore + platformSep.toLowerCase()) || folded.startsWith(projectStore + '/')) {
      return 'project directory'
    }
  } catch {
    // predicate unavailable — fall through
  }
  if (isPlanFilePath(folded)) return 'session plan file'
  try {
    const toolResults = normalizeCaseForComparison((require('../toolResultStorage.js') as { getToolResultsDir(): string }).getToolResultsDir())
    if (folded.startsWith(toolResults)) return 'tool-results directory'
  } catch {
    // predicate unavailable — fall through
  }
  if (isAgentMemory(path)) return 'agent-memory directory'
  if (isAutoMemory(path)) return 'auto-memory directory'
  return null
}

/** A path equal to, or a proper child of, the scratchpad directory. */
function isSessionScratchpad(path: string): boolean {
  if (!isScratchpadEnabled()) return false
  const scratch = normalizeCaseForComparison(getScratchpadDir())
  const folded = normalizeCaseForComparison(path)
  if (folded === scratch) return true
  return folded.startsWith(scratch + platformSep.toLowerCase()) || folded.startsWith(scratch + '/')
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule pattern matching against paths
// ─────────────────────────────────────────────────────────────────────────────

// Deferred names avoid a static cycle with the tool modules. Each list is
// the schema's own filePatternTools set split by capability: a rule spelled
// with ANY member's name governs paths of that type — the validator declares
// Write(<glob>) / NotebookEdit(<glob>) / Glob(<glob>) valid and hands them
// out as examples, so the matcher must consult them (FC-003: they were
// inert). The canonical member sits LAST so it wins same-pattern collisions.
function fileEditRuleToolNames(): string[] {
  return ['Write', 'NotebookEdit', 'Edit']
}
function fileReadRuleToolNames(): string[] {
  return ['Glob', 'NotebookRead', 'Read']
}

/** The pattern→rule map for a whole tool family (merged member maps). */
function rulesForToolFamilyAndBehavior(
  context: ToolPermissionContext,
  toolNames: string[],
  behavior: 'allow' | 'deny' | 'ask',
): Map<string, PermissionRule> {
  const merged = new Map<string, PermissionRule>()
  for (const name of toolNames) {
    for (const [pattern, rule] of rulesForToolAndBehavior(context, name, behavior)) {
      merged.set(pattern, rule)
    }
  }
  return merged
}

/** Fetch a pattern→rule map for a tool name and behaviour. */
function rulesForToolAndBehavior(
  context: ToolPermissionContext,
  toolName: string,
  behavior: 'allow' | 'deny' | 'ask',
): Map<string, PermissionRule> {
  const map = new Map<string, PermissionRule>()
  const key = behavior === 'allow' ? 'alwaysAllowRules' : behavior === 'deny' ? 'alwaysDenyRules' : 'alwaysAskRules'
  const bySource = (context as unknown as Record<string, Record<string, string[]>>)[key] ?? {}
  for (const [source, rules] of Object.entries(bySource)) {
    for (const ruleString of rules) {
      // Parse with the module's faithful rule-value parser: it locates the
      // first UNESCAPED `(` and last UNESCAPED `)`, UNESCAPES the content, and
      // treats empty / bare-`*` content as the tool-wide form (no ruleContent),
      // which the path matcher must exclude. A naive first-`(`/trailing-`)`
      // splitter would mis-resolve an escaped path and inject `Edit(*)` as a
      // match-all pattern.
      const parsed = permissionRuleValueFromString(ruleString)
      if (parsed.toolName !== toolName || parsed.ruleContent === undefined) continue
      // A later rule wins the map slot on a pattern collision under one root.
      map.set(parsed.ruleContent, {
        source: source as PermissionRule['source'],
        ruleBehavior: behavior,
        ruleValue: parsed,
      })
    }
  }
  return map
}

/** The root a pattern is anchored to and the relative pattern under it.
 *  `platform` is explicit so the spellings prove off-Windows. */
export function rootForPattern(
  pattern: string,
  source: PermissionRule['source'],
  platform: ReturnType<typeof getPlatform> = getPlatform(),
): { root: string | null; relative: string } {
  if (platform === 'windows') {
    // The drive-letter spellings an operator (or an older build's writer)
    // puts in a rule — `C:/proj/**`, `C:\proj\**`, `/C:/proj/**` — anchor at
    // the drive root exactly like the canonical `//C/proj/**`. Read as a
    // relative pattern they matched nothing: allow, deny and ask were all
    // inert unless spelled `//<letter>/…` (TASK-014 w4-f10-01).
    const drive = pattern.replace(/\\/g, '/').match(/^\/?([A-Za-z]):\/(.*)$/)
    if (drive) {
      return { root: `${(drive[1] as string).toUpperCase()}:${platformSep}`, relative: drive[2] as string }
    }
  }
  if (pattern.startsWith('//')) {
    // Windows POSIX-drive spelling `//<letter>/rest` anchors at the drive root.
    if (platform === 'windows') {
      const drive = pattern.match(/^\/\/([A-Za-z])\/(.*)$/)
      if (drive) {
        return { root: `${(drive[1] as string).toUpperCase()}:${platformSep}`, relative: drive[2] as string }
      }
    }
    return { root: '/', relative: pattern.slice(1) } // minus one leading slash
  }
  if (pattern.startsWith('~/')) {
    return { root: normalizeNfc(getHomeDir()), relative: pattern.slice(1) } // minus the ~
  }
  if (pattern.startsWith('/')) {
    return { root: rootForSource(source) ?? null, relative: pattern }
  }
  if (pattern.startsWith('./')) {
    return { root: null, relative: pattern.slice(2) }
  }
  return { root: null, relative: pattern }
}

const RUNTIME_SOURCES = new Set(['cliArg', 'command', 'session', 'toolsNarrowing', 'mcpServerPolicy'])

function rootForSource(source: PermissionRule['source']): string | undefined {
  if (RUNTIME_SOURCES.has(source)) return expandPath(getOriginalCwd())
  try {
    const path = getSettingsFilePathForSource(source as never)
    return path ? getDirectoryForPath(path) : undefined
  } catch {
    return undefined
  }
}

/**
 * Find the first matching rule for a path across all root groups, resolving
 * the tool TYPE (edit/read) to the file-edit / file-read tool name.
 */
export function matchingRuleForInput(
  path: string,
  context: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  const toolNames = toolType === 'edit' ? fileEditRuleToolNames() : fileReadRuleToolNames()
  const rules = rulesForToolFamilyAndBehavior(context, toolNames, behavior)

  // Group patterns by root.
  const groups = new Map<string | null, Array<{ pattern: string; rule: PermissionRule }>>()
  for (const [pattern, rule] of rules) {
    const { root } = rootForPattern(pattern, rule.source)
    // A source with no root yields undefined — its rules vanish silently.
    if (root === undefined) continue
    const list = groups.get(root) ?? []
    list.push({ pattern, rule })
    groups.set(root, list)
  }

  const expanded = expandPath(path)
  const candidatePath = getPlatform() === 'windows' && expanded.includes('\\') ? toPosixPath(expanded) : expanded

  for (const [root, entries] of groups) {
    // Null root ("matches anywhere") bases on the SESSION cwd (honouring `cd`
    // inside Bash and any per-agent async-local override), not the OS process
    // cwd — a relative rule must resolve against where the agent is working.
    const base = root === null ? getCwd() : root
    const relative = relativePath(base, candidatePath === '' ? getCwd() : candidatePath)
    if (relative.startsWith('..')) continue // outside this root group
    if (relative === '') continue // empty relative path is skipped

    const matcher = ignore()
    const patternToRule = new Map<string, PermissionRule>()
    for (const { pattern, rule } of entries) {
      const { relative: rel } = rootForPattern(pattern, rule.source)
      const stripped = rel.endsWith('/**') ? rel.slice(0, -3) : rel
      matcher.add(stripped)
      patternToRule.set(stripped, rule)
      patternToRule.set(rel, rule)
    }
    const result = matcher.test(relative)
    if (result.ignored) {
      // Recover the matching rule; the ignore library does not expose which
      // pattern matched, so re-test each until one ignores this path.
      for (const { pattern, rule } of entries) {
        const { relative: rel } = rootForPattern(pattern, rule.source)
        const stripped = rel.endsWith('/**') ? rel.slice(0, -3) : rel
        if (ignore().add(stripped).test(relative).ignored) return rule
      }
    }
  }
  return null
}

/** Rewrite a root→patterns map relative to a reference root, de-duplicated. */
export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  const results = new Set<string>()
  const refRoot = getPlatform() === 'windows' ? toPosixPath(root) : root
  for (const [patternRoot, patterns] of patternsByRoot) {
    for (const pattern of patterns) {
      if (patternRoot === null) {
        results.add(pattern) // included as-is
        continue
      }
      const pr = getPlatform() === 'windows' ? toPosixPath(patternRoot) : patternRoot
      const refCmp = getPlatform() === 'windows' ? refRoot.toLowerCase() : refRoot
      const prCmp = getPlatform() === 'windows' ? pr.toLowerCase() : pr
      if (prCmp === refCmp) {
        results.add(`/${pattern}`) // emitted with a leading slash
        continue
      }
      const combined = joinPosix(pr, pattern)
      if (combined.toLowerCase().startsWith(refCmp.toLowerCase() + '/')) {
        results.add('/' + combined.slice(refRoot.length).replace(/^\/+/, '')) // portion after ref root
        continue
      }
      const rel = relativePath(refRoot, pr)
      if (rel.startsWith('..')) continue // outside the reference root: skip
      results.add(joinPosix(rel, pattern))
    }
  }
  return [...results]
}

/** The file-read deny patterns grouped by root (for the search/listing tools). */
export function getFileReadIgnorePatterns(context: ToolPermissionContext): Map<string | null, string[]> {
  const rules = rulesForToolFamilyAndBehavior(context, fileReadRuleToolNames(), 'deny')
  const byRoot = new Map<string | null, string[]>()
  for (const [pattern, rule] of rules) {
    const { root, relative } = rootForPattern(pattern, rule.source)
    if (root === undefined) continue
    const list = byRoot.get(root) ?? []
    list.push(relative)
    byRoot.set(root, list)
  }
  return byRoot
}

// ─────────────────────────────────────────────────────────────────────────────
// Read + write decision ladders
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolLike = { getPath?: (input: any) => string | undefined; name: string }

function ask(message: string, reason: PermissionDecision['decisionReason']): PermissionDecision {
  return { behavior: 'ask', message, decisionReason: reason } as unknown as PermissionDecision
}
function deny(message: string, reason: PermissionDecision['decisionReason']): PermissionDecision {
  return { behavior: 'deny', message, decisionReason: reason } as unknown as PermissionDecision
}
function allow(input: unknown, reason: PermissionDecision['decisionReason']): PermissionDecision {
  return { behavior: 'allow', updatedInput: input, decisionReason: reason } as unknown as PermissionDecision
}

/** The read permission decision ladder. */
export function checkReadPermissionForTool(
  tool: ToolLike,
  input: unknown,
  context: ToolPermissionContext,
): PermissionDecision {
  const path = tool.getPath?.(input)
  if (path === undefined) {
    return ask(`Permission to use ${tool.name} has not been granted.`, { type: 'other', reason: 'no path accessor' })
  }

  const resolutionSet = getResolvedWorkingDirPaths(path)

  // 2. UNC block — for an INCIDENTAL network path; a UNC path inside an
  //    allowed working directory is the operator's own share-hosted tree.
  if (uncBlockApplies(path, resolutionSet, context)) {
    return ask(
      `${path} appears to be a network (UNC) path that could reach remote resources.`,
      { type: 'other', reason: 'defence-in-depth UNC block' },
    )
  }
  // 3. Suspicious Windows patterns.
  for (const resolved of resolutionSet) {
    if (suspiciousWindowsPattern(resolved)) {
      return ask(
        `${path} contains a suspicious Windows path pattern requiring manual approval.`,
        { type: 'other', reason: 'suspicious Windows path pattern' },
      )
    }
  }
  // 4. Read-specific deny rules (before any allow path).
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'read', 'deny')
    if (rule) return deny(`Permission to read ${path} has been denied.`, { type: 'rule', rule } as never)
  }
  // 5. Read-specific ask rules.
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'read', 'ask')
    if (rule) return ask(`Permission to read ${path} requires confirmation.`, { type: 'rule', rule } as never)
  }
  // 6. Edit implies read.
  const writeDecision = checkWritePermissionForTool(tool, input, context, resolutionSet)
  if (writeDecision.behavior === 'allow') return writeDecision
  // 7. Working-directory allow.
  if (pathInAllowedWorkingPath(path, context, resolutionSet)) {
    return allow(input, { type: 'mode', mode: 'default' } as never)
  }
  // 8. Internal readable paths.
  const internal = checkReadableInternalPath(expandPath(path), input)
  if ((internal as { behavior: string }).behavior !== 'passthrough') return internal as unknown as PermissionDecision
  // 9. Read allow rules (original path).
  const allowRule = matchingRuleForInput(path, context, 'read', 'allow')
  if (allowRule) return allow(input, { type: 'rule', rule: allowRule } as never)
  // 10. Otherwise ask.
  return {
    behavior: 'ask',
    message: `Permission to read from ${path} has not been granted.`,
    decisionReason: { type: 'workingDir', reason: 'the path is outside the allowed working directories' },
    suggestions: generateSuggestions(path, 'read', context, resolutionSet),
  } as unknown as PermissionDecision
}

/** The write permission decision ladder. */
export function checkWritePermissionForTool(
  tool: ToolLike,
  input: unknown,
  context: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  const path = tool.getPath?.(input)
  if (path === undefined) {
    return ask(`Permission to use ${tool.name} has not been granted.`, { type: 'other', reason: 'no path accessor' })
  }
  const resolutionSet = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(path)

  // 1. Edit deny rules.
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'edit', 'deny')
    if (rule) return deny(`Permission to edit ${path} has been denied.`, { type: 'rule', rule } as never)
  }
  // 2. Internal editable paths — BEFORE the safety checks.
  const internal = checkEditableInternalPath(expandPath(path), input)
  if ((internal as { behavior: string }).behavior !== 'passthrough') return internal as unknown as PermissionDecision
  // 3. Session-scoped config-estate allow.
  const estate = sessionEstateAllow(path, context, input)
  if (estate) return estate
  // 3a. Apollo spec-artifact consent: in the interview mode (apollo) and
  // the build posture it hands off to (implement), the mode's OWN working
  // artifacts — spec files under <project>/.mercury/apollo/ — ride the
  // mode's consent (asking for every spec write interrupts the interview
  // the mode exists to run). Sits with the estate allow ABOVE the safety
  // rung: the spec directory lives inside the product-config home, whose
  // settings-estate ask would otherwise intercept it. Scoped hard: those
  // two modes only, the project's own spec directory only (every symlink
  // resolution inside it), and the deny rules above still win. Real
  // project files keep the full ladder.
  if (
    (context.mode === 'apollo' || context.mode === 'implement') &&
    pathInAllowedWorkingPath(path, context, resolutionSet)
  ) {
    const specForms = getResolvedWorkingDirPaths(apolloSpecDirectory(getOriginalCwd()))
    const inSpecDir = (candidate: string): boolean =>
      specForms.some(form => pathInWorkingPath(candidate, form))
    if (resolutionSet.length > 0 && resolutionSet.every(inSpecDir)) {
      return allow(input, { type: 'mode', mode: context.mode } as never)
    }
  }
  // 4. Safety checks — before allow rules (the session context carries the
  //    share-hosted-workspace exemption for the UNC arm).
  const safety = checkPathSafetyForAutoEdit(path, resolutionSet, context)
  if (!safety.safe) {
    const skill = getClaudeSkillScope(path)
    const suggestions = skill
      ? [narrowedSkillGrant(skill.pattern)]
      : generateSuggestions(path, 'write', context, resolutionSet)
    return {
      behavior: 'ask',
      message: safety.message,
      decisionReason: {
        type: 'safetyCheck',
        message: safety.message,
        classifierApprovable: safety.classifierApprovable,
      },
      suggestions,
    } as unknown as PermissionDecision
  }
  // 5. Edit ask rules.
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'edit', 'ask')
    if (rule) return ask(`Permission to edit ${path} requires confirmation.`, { type: 'rule', rule } as never)
  }
  // 6. implement fast path.
  if (context.mode === 'implement' && pathInAllowedWorkingPath(path, context, resolutionSet)) {
    return allow(input, { type: 'mode', mode: 'implement' } as never)
  }
  // 7. Edit allow rules (original path).
  const allowRule = matchingRuleForInput(path, context, 'edit', 'allow')
  if (allowRule) return allow(input, { type: 'rule', rule: allowRule } as never)
  // 8. Otherwise ask.
  const outsideWorkingDir = !pathInAllowedWorkingPath(path, context, resolutionSet)
  return {
    behavior: 'ask',
    message: `Permission to write to ${path} has not been granted.`,
    suggestions: generateSuggestions(path, 'write', context, resolutionSet),
    decisionReason: outsideWorkingDir
      ? { type: 'workingDir', reason: 'the path is outside the allowed working directories' }
      : undefined,
  } as unknown as PermissionDecision
}

/** The session-scoped config-estate allow (step 3). */
function sessionEstateAllow(
  path: string,
  context: ToolPermissionContext,
  input: unknown,
): PermissionDecision | null {
  const narrowed = {
    ...(context as object),
    alwaysAllowRules: {
      session: ((context as unknown as Record<string, Record<string, string[]>>).alwaysAllowRules ?? {}).session ?? [],
    },
  } as unknown as ToolPermissionContext
  const rule = matchingRuleForInput(path, narrowed, 'edit', 'allow')
  if (!rule) return null
  const content = rule.ruleValue.ruleContent ?? ''
  if (!content.endsWith('/**')) return null
  if (content.includes('..')) return null
  if (!estatePrefixes().some(prefix => content.startsWith(prefix))) return null
  return allow(input, { type: 'rule', rule } as never)
}

function estatePrefixes(): string[] {
  const prefixes: string[] = []
  for (const home of PROJECT_CONFIG_DIR_NAMES) {
    prefixes.push(`/${home}/`, `~/${home}/`)
  }
  const globalHome = getMercuryHome()
  const home = getHomeDir()
  if (normalizeCaseForComparison(globalHome).startsWith(normalizeCaseForComparison(home))) {
    const rel = globalHome.slice(home.length).replace(/^[/\\]/, '')
    prefixes.push(`~/${rel}/`)
  } else {
    prefixes.push(`${globalHome}/`)
  }
  return prefixes
}

function narrowedSkillGrant(pattern: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName: 'Edit', ruleContent: pattern }],
    behavior: 'allow',
    destination: 'session',
  } as unknown as PermissionUpdate
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion generation
// ─────────────────────────────────────────────────────────────────────────────

/** Generate permission suggestions for a path operation. */
export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  context: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const outside = !pathInAllowedWorkingPath(filePath, context, precomputedPathsToCheck)
  const parent = getDirectoryForPath(filePath)

  if (operationType === 'read') {
    if (outside) {
      const suggestions: PermissionUpdate[] = []
      for (const resolved of getResolvedWorkingDirPaths(parent)) {
        const suggestion = createReadRuleSuggestion(resolved, 'session')
        if (suggestion) suggestions.push(suggestion)
      }
      return suggestions
    }
    return modeSuggestion(context)
  }

  // write/create.
  const suggestions = modeSuggestion(context)
  if (outside) {
    suggestions.push({
      type: 'addDirectories',
      directories: getResolvedWorkingDirPaths(parent),
      destination: 'session',
    } as unknown as PermissionUpdate)
  }
  return suggestions
}

/** A setMode(implement) suggestion, only when it would be an upgrade.
 *  Apollo belongs with the two ask-posture modes: the file dialog's session
 *  tier promises "allow all edits for this session", and honouring that from
 *  the interview requires completing the transition to implement — without
 *  it the grant was a silent no-op and the session stayed trapped in the
 *  interview posture whichever yes the user chose. */
function modeSuggestion(context: ToolPermissionContext): PermissionUpdate[] {
  if (context.mode === 'default' || context.mode === 'strategy' || context.mode === 'apollo') {
    return [{ type: 'setMode', mode: 'implement', destination: 'session' } as unknown as PermissionUpdate]
  }
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// small path utilities
// ─────────────────────────────────────────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || tmpdir()
}

function normalizeNfc(path: string): string {
  return path.normalize('NFC')
}

function joinWithSep(a: string, b: string): string {
  const trimmed = a.endsWith(platformSep) ? a.slice(0, -1) : a
  return `${trimmed}${platformSep}${b}`
}

function joinPosix(a: string, b: string): string {
  const trimmed = a.endsWith('/') ? a.slice(0, -1) : a
  return `${trimmed}/${b}`
}

function ensureTrailingSep(path: string): string {
  return path.endsWith(platformSep) ? path : path + platformSep
}
