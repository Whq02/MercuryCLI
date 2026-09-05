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
import { APOLLO_REVIEW_TOOL_NAME } from '../../tools/ApolloReviewTool/constants.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import { getEnabledSettingSources } from '../settings/constants.js'
import type { PermissionRule, PermissionUpdate } from '../../types/permissions.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionDecision, PermissionResult } from './PermissionResult.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'


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

export const DANGEROUS_DIRECTORIES: string[] = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.mercury',
]

const CONFIG_HOME_SEGMENTS = ['.claude', '.mercury']


export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

export function toPosixPath(path: string): string {
  return getPlatform() === 'windows' ? windowsPathToPosixPath(path) : path
}

export function relativePath(from: string, to: string): string {
  const a = toPosixPath(from)
  const b = toPosixPath(to)
  const aParts = a.split(posixPath.sep).filter(Boolean)
  const bParts = b.split(posixPath.sep).filter(Boolean)
  let i = 0
  while (i < aParts.length && i < bParts.length && aParts[i] === bParts[i]) i++
  const up = aParts.slice(i).map(() => '..')
  const down = bParts.slice(i)
  return [...up, ...down].join('/')
}

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

function normalizeForWorkingDirCompare(path: string): string {
  return normalizeCaseForComparison(toPosixPath(foldMacSymlinks(path)))
}


export function allWorkingDirectories(context: ToolPermissionContext): Set<string> {
  const dirs = new Set<string>([getOriginalCwd()])
  const additional = (context as unknown as { additionalWorkingDirectories?: ReadonlyMap<string, unknown> })
    .additionalWorkingDirectories
  if (additional) {
    for (const dir of additional.keys()) dirs.add(dir)
  }
  return dirs
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const rel = relativePath(normalizeForWorkingDirCompare(workingPath), normalizeForWorkingDirCompare(path))
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  if (rel.startsWith('/')) return false
  return true
}

let workingDirResolutionCache = new Map<string, string[]>()

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


function isRawUnc(rawPath: string): boolean {
  if (/^(?:\\\\|\/\/)[?.][\\/]/.test(rawPath)) {
    return /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/]/i.test(rawPath)
  }
  return rawPath.startsWith('\\\\') || rawPath.startsWith('//')
}

function uncBlockApplies(
  path: string,
  resolutionSet: readonly string[],
  context: ToolPermissionContext | undefined,
): boolean {
  if (!resolutionSet.some(isRawUnc)) return false
  if (context === undefined) return true
  return !pathInAllowedWorkingPath(path, context, resolutionSet)
}

function isDangerousFileOrDirectory(rawPath: string, expandedPath: string, uncExempt = false): boolean {
  if (!uncExempt && isRawUnc(rawPath)) return true

  const segments = expandedPath.split(platformSep)
  const lastSegment = segments[segments.length - 1] ?? ''
  if (DANGEROUS_FILES.some(name => name.toLowerCase() === lastSegment.toLowerCase())) {
    return true
  }
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]?.toLowerCase() ?? ''
    if (CONFIG_HOME_SEGMENTS.includes(segment) && segments[i + 1]?.toLowerCase() === 'worktrees') {
      continue
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

function suspiciousWindowsPattern(path: string): string | null {
  const platform = getPlatform()
  const onWindows = platform === 'windows' || platform === 'wsl'

  if (onWindows && /^.{2,}?:/.test(path.slice(2)) === false) {
  }
  if (onWindows) {
    for (let i = 2; i < path.length; i++) {
      if (path[i] === ':') return 'NTFS alternate data stream'
    }
  }
  if (/~\d/.test(path)) return '8.3 short name'
  if (/^(?:\\\\\?\\|\\\\\.\\|\/\/\?\/|\/\/\.\/)/.test(path)) return 'long-path or device prefix'
  if (/[.\s]$/.test(path)) return 'trailing dot or whitespace'
  const finalExt = path.split(/[./\\]/).pop()?.toLowerCase() ?? ''
  if (DOS_DEVICE_NAMES.has(finalExt)) return 'DOS device name'
  if (/(?:^|[/\\])\.{3,}(?:[/\\]|$)/.test(path)) return 'consecutive dots as a path component'
  return null
}


export function getMercuryTempDirName(): string {
  if (getPlatform() === 'windows') return 'mercury'
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `mercury-${uid}`
}

let tempDirCache: string | null = null

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

export function getProjectTempDir(): string {
  return ensureTrailingSep(joinWithSep(getMercuryTempDir(), sanitizePath(getOriginalCwd())))
}

export function getScratchpadDir(): string {
  return joinWithSep(joinWithSep(getProjectTempDir(), getSessionId()), 'scratchpad')
}

export function isScratchpadEnabled(): boolean {
  return checkFeatureGate_CACHED_MAY_BE_STALE('mercury_scratch')
}

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
  }
  return dir
}

export function getSessionMemoryDir(): string {
  const projectDir = joinWithSep(getProjectTempDir(), getSessionId())
  return ensureTrailingSep(joinWithSep(projectDir, 'session-memory'))
}

export function getSessionMemoryPath(): string {
  return joinWithSep(getSessionMemoryDir(), 'summary.md')
}

let bundledSkillsRootCache: string | null = null

export function getBundledSkillsRoot(): string {
  if (bundledSkillsRootCache) return bundledSkillsRootCache
  const version = (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ?? '0.0.0'
  const nonce = randomBytes(16).toString('hex')
  bundledSkillsRootCache = joinWithSep(joinWithSep(getMercuryTempDir(), `bundled-skills`), `${version}-${nonce}`)
  return bundledSkillsRootCache
}


export function isClaudeSettingsPath(filePath: string): boolean {
  const expanded = expandPath(filePath)
  const folded = normalizeCaseForComparison(expanded)
  const sep = platformSep.toLowerCase()
  for (const home of CONFIG_HOME_SEGMENTS) {
    for (const file of ['settings.json', 'settings.local.json']) {
      if (folded.endsWith(`${sep}${home}${sep}${file}`)) return true
    }
  }
  for (const source of getEnabledSettingSources()) {
    try {
      const path = getSettingsFilePathForSource(source as never)
      if (path && normalizeCaseForComparison(expandPath(path)) === folded) return true
    } catch {
    }
  }
  return false
}

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

function pathHasSegmentContainment(path: string, base: string): boolean {
  if (path === base) return true
  const baseWithSep = base.endsWith(platformSep.toLowerCase()) ? base : base + platformSep.toLowerCase()
  return path.startsWith(baseWithSep)
}

type PathSafetyResult =
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean }

export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
  context?: ToolPermissionContext,
): PathSafetyResult {
  const resolvedForms = precomputedPathsToCheck ?? getResolvedWorkingDirPaths(path)
  const uncExempt = !uncBlockApplies(path, resolvedForms, context)

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
  for (const resolved of resolvedForms) {
    if (isProductConfigPath(expandPath(resolved))) {
      return {
        safe: false,
        classifierApprovable: true,
        message: `Permission to write to ${path} was requested but not yet granted.`,
      }
    }
  }
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
      const afterBase = expanded.slice(dir.length + separator.length)
      const nextSep = afterBase.search(/[/\\]/)
      if (nextSep === -1) return null
      const skillName = afterBase.slice(0, nextSep)
      if (skillName === '' || skillName === '.' || skillName.includes('..')) return null
      if (/[*?[\]]/.test(skillName)) return null
      return { skillName, pattern: `${prefix}${skillName}/**` }
    }
  }
  return null
}


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
  try {
    const projectStore = normalizeCaseForComparison(
      (require('../sessionStoragePortable.js') as { getProjectDir(p: string): string }).getProjectDir(getCwd()),
    )
    if (folded === projectStore || folded.startsWith(projectStore + platformSep.toLowerCase()) || folded.startsWith(projectStore + '/')) {
      return 'project directory'
    }
  } catch {
  }
  if (isPlanFilePath(folded)) return 'session plan file'
  try {
    const toolResults = normalizeCaseForComparison((require('../toolResultStorage.js') as { getToolResultsDir(): string }).getToolResultsDir())
    if (folded.startsWith(toolResults)) return 'tool-results directory'
  } catch {
  }
  if (isAgentMemory(path)) return 'agent-memory directory'
  if (isAutoMemory(path)) return 'auto-memory directory'
  return null
}

function isSessionScratchpad(path: string): boolean {
  if (!isScratchpadEnabled()) return false
  const scratch = normalizeCaseForComparison(getScratchpadDir())
  const folded = normalizeCaseForComparison(path)
  if (folded === scratch) return true
  return folded.startsWith(scratch + platformSep.toLowerCase()) || folded.startsWith(scratch + '/')
}


function fileEditRuleToolNames(): string[] {
  return ['Write', 'NotebookEdit', 'Edit']
}
function fileReadRuleToolNames(): string[] {
  return ['Glob', 'NotebookRead', 'Read']
}

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
      const parsed = permissionRuleValueFromString(ruleString)
      if (parsed.toolName !== toolName || parsed.ruleContent === undefined) continue
      map.set(parsed.ruleContent, {
        source: source as PermissionRule['source'],
        ruleBehavior: behavior,
        ruleValue: parsed,
      })
    }
  }
  return map
}

export function rootForPattern(
  pattern: string,
  source: PermissionRule['source'],
  platform: ReturnType<typeof getPlatform> = getPlatform(),
): { root: string | null; relative: string } {
  if (platform === 'windows') {
    const drive = pattern.replace(/\\/g, '/').match(/^\/?([A-Za-z]):\/(.*)$/)
    if (drive) {
      return { root: `${(drive[1] as string).toUpperCase()}:${platformSep}`, relative: drive[2] as string }
    }
  }
  if (pattern.startsWith('//')) {
    if (platform === 'windows') {
      const drive = pattern.match(/^\/\/([A-Za-z])\/(.*)$/)
      if (drive) {
        return { root: `${(drive[1] as string).toUpperCase()}:${platformSep}`, relative: drive[2] as string }
      }
    }
    return { root: '/', relative: pattern.slice(1) }
  }
  if (pattern.startsWith('~/')) {
    return { root: normalizeNfc(getHomeDir()), relative: pattern.slice(1) }
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

export function matchingRuleForInput(
  path: string,
  context: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  const toolNames = toolType === 'edit' ? fileEditRuleToolNames() : fileReadRuleToolNames()
  const rules = rulesForToolFamilyAndBehavior(context, toolNames, behavior)

  const groups = new Map<string | null, Array<{ pattern: string; rule: PermissionRule }>>()
  for (const [pattern, rule] of rules) {
    const { root } = rootForPattern(pattern, rule.source)
    if (root === undefined) continue
    const list = groups.get(root) ?? []
    list.push({ pattern, rule })
    groups.set(root, list)
  }

  const expanded = expandPath(path)
  const candidatePath = getPlatform() === 'windows' && expanded.includes('\\') ? toPosixPath(expanded) : expanded

  for (const [root, entries] of groups) {
    const base = root === null ? getCwd() : root
    const relative = relativePath(base, candidatePath === '' ? getCwd() : candidatePath)
    if (relative.startsWith('..')) continue
    if (relative === '') continue

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
      for (const { pattern, rule } of entries) {
        const { relative: rel } = rootForPattern(pattern, rule.source)
        const stripped = rel.endsWith('/**') ? rel.slice(0, -3) : rel
        if (ignore().add(stripped).test(relative).ignored) return rule
      }
    }
  }
  return null
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  const results = new Set<string>()
  const refRoot = getPlatform() === 'windows' ? toPosixPath(root) : root
  for (const [patternRoot, patterns] of patternsByRoot) {
    for (const pattern of patterns) {
      if (patternRoot === null) {
        results.add(pattern)
        continue
      }
      const pr = getPlatform() === 'windows' ? toPosixPath(patternRoot) : patternRoot
      const refCmp = getPlatform() === 'windows' ? refRoot.toLowerCase() : refRoot
      const prCmp = getPlatform() === 'windows' ? pr.toLowerCase() : pr
      if (prCmp === refCmp) {
        results.add(`/${pattern}`)
        continue
      }
      const combined = joinPosix(pr, pattern)
      if (combined.toLowerCase().startsWith(refCmp.toLowerCase() + '/')) {
        results.add('/' + combined.slice(refRoot.length).replace(/^\/+/, ''))
        continue
      }
      const rel = relativePath(refRoot, pr)
      if (rel.startsWith('..')) continue
      results.add(joinPosix(rel, pattern))
    }
  }
  return [...results]
}

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

  if (uncBlockApplies(path, resolutionSet, context)) {
    return ask(
      `${path} appears to be a network (UNC) path that could reach remote resources.`,
      { type: 'other', reason: 'defence-in-depth UNC block' },
    )
  }
  for (const resolved of resolutionSet) {
    if (suspiciousWindowsPattern(resolved)) {
      return ask(
        `${path} contains a suspicious Windows path pattern requiring manual approval.`,
        { type: 'other', reason: 'suspicious Windows path pattern' },
      )
    }
  }
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'read', 'deny')
    if (rule) return deny(`Permission to read ${path} has been denied.`, { type: 'rule', rule } as never)
  }
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'read', 'ask')
    if (rule) return ask(`Permission to read ${path} requires confirmation.`, { type: 'rule', rule } as never)
  }
  const writeDecision = checkWritePermissionForTool(tool, input, context, resolutionSet)
  if (writeDecision.behavior === 'allow') return writeDecision
  if (pathInAllowedWorkingPath(path, context, resolutionSet)) {
    return allow(input, { type: 'mode', mode: 'default' } as never)
  }
  const internal = checkReadableInternalPath(expandPath(path), input)
  if ((internal as { behavior: string }).behavior !== 'passthrough') return internal as unknown as PermissionDecision
  const allowRule = matchingRuleForInput(path, context, 'read', 'allow')
  if (allowRule) return allow(input, { type: 'rule', rule: allowRule } as never)
  return {
    behavior: 'ask',
    message: `Permission to read from ${path} has not been granted.`,
    decisionReason: { type: 'workingDir', reason: 'the path is outside the allowed working directories' },
    suggestions: generateSuggestions(path, 'read', context, resolutionSet),
  } as unknown as PermissionDecision
}

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

  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'edit', 'deny')
    if (rule) return deny(`Permission to edit ${path} has been denied.`, { type: 'rule', rule } as never)
  }
  const internal = checkEditableInternalPath(expandPath(path), input)
  if ((internal as { behavior: string }).behavior !== 'passthrough') return internal as unknown as PermissionDecision
  const estate = sessionEstateAllow(path, context, input)
  if (estate) return estate
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
  if (context.mode === 'apollo') {
    return deny(apolloWriteRefusal(path), { type: 'mode', mode: 'apollo' } as never)
  }
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
  for (const resolved of resolutionSet) {
    const rule = matchingRuleForInput(resolved, context, 'edit', 'ask')
    if (rule) return ask(`Permission to edit ${path} requires confirmation.`, { type: 'rule', rule } as never)
  }
  if (context.mode === 'implement' && pathInAllowedWorkingPath(path, context, resolutionSet)) {
    return allow(input, { type: 'mode', mode: 'implement' } as never)
  }
  const allowRule = matchingRuleForInput(path, context, 'edit', 'allow')
  if (allowRule) return allow(input, { type: 'rule', rule: allowRule } as never)
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

export function apolloWriteRefusal(path: string): string {
  return `Apollo Mode refused writing ${path}: during the pre-flight interview the only files that may be written are the spec files under ${apolloSpecDirectory(getOriginalCwd())}/ — the build begins only after the user approves the closing review (${APOLLO_REVIEW_TOOL_NAME}). Write the spec there, then present the review.`
}

function modeSuggestion(context: ToolPermissionContext): PermissionUpdate[] {
  if (context.mode === 'default' || context.mode === 'strategy') {
    return [{ type: 'setMode', mode: 'implement', destination: 'session' } as unknown as PermissionUpdate]
  }
  return []
}


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
