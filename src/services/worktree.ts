import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import chalk from 'chalk'

import { getSessionId } from '../bootstrap/state.js'
import type { ToolPermissionContext } from '../Tool.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { findCanonicalGitRoot, findGitRoot, gitExe } from '../utils/git.js'
import { readGitHead, readWorktreeHeadSha, resolveGitDir, getCommonDir } from '../utils/git/gitFilesystem.js'
import { parseGitConfigValue } from '../utils/git/gitConfigParser.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { saveCurrentProjectConfig } from '../utils/config.js'
import { containsPathTraversal } from '../utils/path.js'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, resolveProjectConfigPath } from '../utils/projectConfig.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { startCommandHook } from '../utils/hooks/commandRunner.js'
import { logError } from '../utils/log.js'
import { symlinkDeniedByPrivilege } from '../utils/platform/files.js'
import { projectLocalPath } from '../utils/projectLocal/paths.js'
import { getInitialSettings, getRelativeSettingsFilePathForSource, getSettingsFilePathForSource } from '../utils/settings/settings.js'
import { sleep } from '../utils/sleep.js'
import { isInITerm2, isInsideTmuxSync } from '../utils/terminalDetection.js'
import { canCloneHere, carryEntries, cloneIntoWorktree, cloneRefusedBetween, discardSetAside, recordWorktreeClones, returnWorktreeFromAside, setWorktreeAside, sweepSetAside, worktreeHoldsClones, type HeldBack } from '../utils/worktreeClone.js'
import { readWorktreeBaseline, resolveWorktreeAdminDir, writeWorktreeBaseline } from '../utils/worktree/baseline.js'
import { deltaBlocksSettlement, readWorktreeDelta, worktreeRemovalSafe } from '../utils/worktree/delta.js'
import { runGit } from '../utils/worktree/git.js'
import { getCurrentWorktreeSession, restoreWorktreeSession, type WorktreeSession } from '../utils/worktree/session.js'
import { passedOver, passedOverAs } from '../utils/passedOver.js'
import { hostEnv } from '../utils/hostEnv.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'


const MAX_SLUG_LENGTH = 64

export function validateWorktreeSlug(slug: string): void {
  return notBuilt('src/services/worktree.ts:41')
}


function worktreesHome(gitRoot: string): string {
  return projectLocalPath(gitRoot, 'worktrees')
}

function flattenSlug(slug: string): string {
  return slug.replace(/\//g, '+')
}

export function worktreeBranchName(slug: string): string {
  return notBuilt('src/services/worktree.ts:66')
}

function worktreePathForSlug(gitRoot: string, slug: string): string {
  return join(worktreesHome(gitRoot), flattenSlug(slug))
}

const creationChainByRepository = new Map<string, Promise<unknown>>()

function serialiseWorktreeCreation<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
  const key = findCanonicalGitRoot(repoRoot) ?? repoRoot
  const previous = creationChainByRepository.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  creationChainByRepository.set(
    key,
    run.then(
      () => undefined,
      passedOverAs(undefined),
    ),
  )
  return run
}

const GIT_LOCK_REFUSAL = /could not lock|cannot lock|unable to create '[^']*\.lock'/i

const LOCK_RETRY_DELAY_MS = 500

async function runWorktreeAdd(args: string[], repoRoot: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const first = await runGit(args, repoRoot)
  if (first.code === 0 || !GIT_LOCK_REFUSAL.test(first.stderr)) return first
  logForDebugging(`git worktree add waited on a lock and retries once: ${first.stderr.trim().split('\n')[0] ?? ''}`)
  await sleep(LOCK_RETRY_DELAY_MS)
  return runGit(args, repoRoot)
}


type CreateOrResumeResult = {
  worktreePath: string
  worktreeBranch?: string
  headCommit: string | null
  existed: boolean
  baseBranch?: string
}

type CreateOrResumeOptions = {
  prNumber?: number
  at?: string
  baseFrom?: string
}

function createOrResumeWorktree(repoRoot: string, slug: string, options?: CreateOrResumeOptions): Promise<CreateOrResumeResult> {
  return serialiseWorktreeCreation(repoRoot, () => createOrResumeWorktreeNow(repoRoot, slug, options))
}

async function createOrResumeWorktreeNow(
  repoRoot: string,
  slug: string,
  options?: CreateOrResumeOptions,
): Promise<CreateOrResumeResult> {
  return notBuilt('src/services/worktree.ts:121')
}


async function copyWorktreeIncludeFiles(repoRoot: string, worktreePath: string, preserveExisting?: boolean): Promise<string[]> {
  return notBuilt('src/services/worktree.ts:232')
}

const DEPENDENCY_LINK_ROOT = 'node_modules'
const PACK_LINK_DIRECTORY = 'vendor'

async function isDirectoryAt(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    passedOver(error)
    return false
  }
}

async function ignoredIn(root: string, relPath: string): Promise<boolean> {
  const probe = await runGit(['check-ignore', '-q', '--', relPath], root)
  return probe.code === 0
}

async function dependencyLinkCandidates(sourceRoot: string): Promise<string[]> {
  const names: string[] = []
  if (await isDirectoryAt(join(sourceRoot, DEPENDENCY_LINK_ROOT))) names.push(DEPENDENCY_LINK_ROOT)
  let packs: string[] = []
  try {
    packs = await readdir(join(sourceRoot, PACK_LINK_DIRECTORY))
  } catch {
    packs = []
  }
  for (const pack of packs.sort()) {
    if (await isDirectoryAt(join(sourceRoot, PACK_LINK_DIRECTORY, pack))) names.push(`${PACK_LINK_DIRECTORY}/${pack}`)
  }
  const ignored: string[] = []
  for (const name of names) {
    if (await ignoredIn(sourceRoot, name)) ignored.push(name)
  }
  return ignored
}

function checkoutRelativeName(relPath: string): string {
  return relPath.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.').join('/')
}

type SessionRules = ToolPermissionContext | 'unknown'

async function sameFile(one: string, other: string): Promise<boolean> {
  try {
    return (await realpath(one)) === (await realpath(other))
  } catch {
    return resolve(one) === resolve(other)
  }
}

async function ownSettingsDenyReads(sourceRoot: string): Promise<boolean> {
  const { getEmptyToolPermissionContext } = await import('../Tool.js')
  const { applyPermissionRulesToPermissionContext } = await import('../utils/permissions/permissions.js')
  const { permissionRuleValueFromString } = await import('../utils/permissions/permissionRuleParser.js')
  const { ruleMatcherFor } = await import('../utils/permissions/filesystem.js')
  for (const [source, name] of [['projectSettings', 'settings.json'], ['localSettings', 'settings.local.json']] as const) {
    const theirs = resolveProjectConfigPath(sourceRoot, name) ?? join(sourceRoot, MERCURY_PROJECT_DIR, name)
    const ours = getSettingsFilePathForSource(source)
    if (ours !== undefined && (await sameFile(ours, theirs))) continue
    let text: string
    try {
      text = await readFile(theirs, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      logForDebugging(`worktree clone: ${theirs} could not be read (${code ?? String(error)}), so its Read rules are unknown; every folder is held back`, { level: 'warn' })
      return true
    }
    try {
      const deny = (JSON.parse(text) as { guardrails?: { deny?: unknown } } | null)?.guardrails?.deny
      if (deny === undefined) continue
      if (!Array.isArray(deny)) return true
      const rules = deny.filter((entry): entry is string => typeof entry === 'string').map(entry => ({ source: 'session' as const, ruleBehavior: 'deny' as const, ruleValue: permissionRuleValueFromString(entry) }))
      if (ruleMatcherFor(applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), rules), 'read', 'deny') !== null) return true
    } catch (error) {
      passedOver(error)
      return true
    }
  }
  return false
}

const allHeld = (): HeldBack => () => true

async function heldBackUnder(permission: SessionRules | undefined, sourceRoot: string, always = false): Promise<((root: string) => HeldBack) | undefined> {
  if (permission === 'unknown') return allHeld
  try {
    const { readDenialFilter, ruleMatcherFor } = await import('../utils/permissions/filesystem.js')
    let rules = permission
    if (rules === undefined) {
      if (await ownSettingsDenyReads(sourceRoot)) return allHeld
      const { getEmptyToolPermissionContext } = await import('../Tool.js')
      const { applyPermissionRulesToPermissionContext } = await import('../utils/permissions/permissions.js')
      const { loadAllPermissionRulesFromDisk } = await import('../utils/permissions/permissionsLoader.js')
      rules = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk())
    }
    const narrowing = (rules.alwaysAllowRules as Record<string, readonly string[] | undefined>).toolsNarrowing ?? []
    if (!always && ruleMatcherFor(rules, 'read', 'deny') === null && narrowing.length === 0) {
      const { mercurySecretReadIgnores } = await import('../utils/permissions/protectedPaths.js')
      const fold = (path: string): string => path.normalize('NFC').toLowerCase()
      const root = fold(await realpath(sourceRoot))
      if (![...mercurySecretReadIgnores().keys()].some(home => fold(home) === root || fold(home).startsWith(root.endsWith(sep) ? root : root + sep))) return undefined
    }
    const read = rules
    return root => readDenialFilter(read, root)
  } catch (error) {
    logForDebugging(`worktree clone: the Read rules could not be read (${String(error)}); the folders are linked as before`, { level: 'warn' })
    return allHeld
  }
}

async function cloneCheckoutDirectories(sourceRoot: string, worktreePath: string, relPaths: readonly string[], held: ((root: string) => HeldBack) | undefined): Promise<string[] | null> {
  if (relPaths.length === 0) return []
  const before = canCloneHere() ? await lstat(worktreePath).catch(passedOverAs(null)) : undefined
  if (before === null || (before !== undefined && !before.isDirectory())) return null
  let checked: Promise<boolean> | undefined
  const stillHere = before === undefined ? undefined : (): Promise<boolean> => checked ??= lstat(worktreePath).then(after => after.isDirectory() && after.dev === before.dev && after.ino === before.ino, passedOverAs(false))
  const outcomes = await cloneIntoWorktree(relPaths.map(relPath => ({ source: join(sourceRoot, relPath), target: join(worktreePath, relPath) })), sourceRoot, worktreePath, undefined, held, stillHere)
  if (stillHere !== undefined && !(await stillHere())) return null
  return relPaths.filter((_, index) => outcomes[index] === 'cloned')
}

const CARRY_LISTING_BYTES = 64 * 1024 * 1024

async function instructionFileTest(): Promise<HeldBack> {
  const { conventionsForProfile, isInstructionFilePath } = await import('./instructions/engine.js')
  const conventions = conventionsForProfile('auto')
  const names = new Set(conventions.flatMap(convention => convention.instructionFileNames))
  return path => names.has(basename(path)) || conventions.some(convention => (convention.folderOf?.(path) ?? null) !== null) || isInstructionFilePath(path, conventions)
}

async function ignoredEntriesOf(sourceRoot: string, worktreePath: string): Promise<string[]> {
  const options = { cwd: sourceRoot, maxBuffer: CARRY_LISTING_BYTES }
  const [listing, rules] = await Promise.all([
    execFileNoThrowWithCwd(gitExe(), ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], options),
    execFileNoThrowWithCwd(gitExe(), ['ls-files', '--modified', '--others', '--exclude-standard', '-z', '--', ':(glob)**/.gitignore'], options),
  ])
  if (listing.code !== 0) return []
  const entries = listing.stdout.split('\0').filter(entry => entry !== '')
  if (rules.code === 0 && rules.stdout === '' && !entries.some(entry => basename(entry) === '.gitignore')) {
    return entries.filter((entry, at) => !(entry.endsWith('/') && entries[at + 1]?.startsWith(entry) === true))
  }
  const checked = await execFileNoThrowWithCwd(gitExe(), ['check-ignore', '--stdin', '-z'], { cwd: worktreePath, maxBuffer: CARRY_LISTING_BYTES, input: entries.join('\0') })
  return checked.code === 0 ? checked.stdout.split('\0').filter(entry => entry !== '') : []
}

async function holdsUserHome(sourceRoot: string): Promise<boolean> {
  try {
    const [checkout, home] = await Promise.all([realpath(sourceRoot), realpath(homedir())])
    return home === checkout || home.startsWith(checkout.endsWith(sep) ? checkout : checkout + sep)
  } catch (error) {
    passedOver(error)
    return true
  }
}

async function carryIgnoredEntries(sourceRoot: string, worktreePath: string, placed: readonly string[], permission: SessionRules | undefined): Promise<boolean> {
  if (await cloneRefusedBetween(sourceRoot, worktreePath)) return false
  if (await holdsUserHome(sourceRoot)) return false
  const [here, there] = await Promise.all([runGit(['rev-parse', 'HEAD'], worktreePath), runGit(['rev-parse', 'HEAD'], sourceRoot)])
  if (here.code !== 0 || there.code !== 0 || here.stdout.trim() === '' || here.stdout.trim() !== there.stdout.trim()) return false
  const entries = (await ignoredEntriesOf(sourceRoot, worktreePath)).filter(entry => {
    const name = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (PROJECT_CONFIG_DIR_NAMES.some(folder => name === folder || name.startsWith(`${folder}/`))) return false
    return !placed.some(kept => name === kept || name.startsWith(`${kept}/`) || kept.startsWith(`${name}/`))
  })
  const refusedUnder = (await heldBackUnder(permission, sourceRoot, true)) as (root: string) => HeldBack
  const instructions = await instructionFileTest()
  const { mercurySecretReadIgnores } = await import('../utils/permissions/protectedPaths.js')
  const fold = (path: string): string => path.normalize('NFC').toLowerCase()
  const ownHomes = [...mercurySecretReadIgnores().keys()].map(fold)
  const staysBehind = (root: string): HeldBack => {
    const refused = refusedUnder(root)
    const checkout = fold(root)
    if (ownHomes.some(own => checkout === own || checkout.startsWith(`${own}/`))) return () => true
    const inside = ownHomes.filter(own => own.startsWith(`${checkout}/`))
    if (inside.length === 0) return path => refused(path) || instructions(path)
    return path => {
      if (refused(path) || instructions(path)) return true
      const folded = fold(path)
      return inside.some(own => folded === own || folded.startsWith(`${own}/`))
    }
  }
  recordWorktreeClones(worktreePath, await carryEntries(entries, sourceRoot, worktreePath, staysBehind))
  return true
}

async function linkCheckoutDirectories(sourceRoot: string, worktreePath: string, relPaths: readonly string[], heldUnder: () => Promise<((root: string) => HeldBack) | undefined>): Promise<string[]> {
  return notBuilt('src/services/worktree.ts:496')
}

async function hideLinksFromGit(repoRoot: string, worktreePath: string, sourceRoot: string, linked: readonly string[]): Promise<void> {
  return notBuilt('src/services/worktree.ts:547')
}

async function propagateLocalSettings(repoRoot: string, worktreePath: string, preserveExisting: boolean): Promise<void> {
  try {
    const relativeSettingsPath = getRelativeSettingsFilePathForSource('localSettings')
    const target = join(worktreePath, relativeSettingsPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repoRoot, relativeSettingsPath), target, preserveExisting ? constants.COPYFILE_EXCL : 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && !(preserveExisting && code === 'EEXIST')) {
      throw new Error('The worktree local settings could not be copied: ' + String(error))
    }
  }
}

async function placeCheckoutFolders(repoRoot: string, worktreePath: string, dependencyLinksFrom: string | undefined, preserveExisting: boolean, permission?: SessionRules, carry = false): Promise<boolean> {
  const symlinkDirectories = getInitialSettings().workspace?.worktree?.symlinkDirectories ?? []
  const sourceRoot = dependencyLinksFrom !== undefined ? (findGitRoot(dependencyLinksFrom) ?? repoRoot) : repoRoot
  const dependencyLinks = dependencyLinksFrom !== undefined ? await dependencyLinkCandidates(sourceRoot) : []
  const keptAsLinks = new Set(symlinkDirectories.map(checkoutRelativeName))
  const toClone = dependencyLinks.filter(name => !keptAsLinks.has(name))
  const carries = carry && dependencyLinksFrom !== undefined && canCloneHere() && (getInitialSettings().workspace?.worktree?.sparsePaths ?? []).length === 0
  let held: Promise<((root: string) => HeldBack) | undefined> | undefined
  const heldUnder = (): Promise<((root: string) => HeldBack) | undefined> => held ??= heldBackUnder(permission, sourceRoot)
  const cloned = await cloneCheckoutDirectories(sourceRoot, worktreePath, toClone, canCloneHere() && toClone.length > 0 ? await heldUnder() : undefined)
  if (cloned === null) return false
  recordWorktreeClones(worktreePath, cloned)
  const linked = await linkCheckoutDirectories(sourceRoot, worktreePath, [...new Set([...dependencyLinks, ...symlinkDirectories])].filter(name => !cloned.includes(name)), heldUnder)
  if (dependencyLinksFrom !== undefined) await hideLinksFromGit(repoRoot, worktreePath, sourceRoot, [...cloned, ...linked])
  const carried = carries && (await carryIgnoredEntries(sourceRoot, worktreePath, [...new Set([...dependencyLinks, ...keptAsLinks])], permission))
  await copyWorktreeIncludeFiles(repoRoot, worktreePath, preserveExisting || carried)
  return true
}

export async function prepareWorktreeFiles(repoRoot: string, worktreePath: string, dependencyLinksFrom?: string, preserveExisting = false, permission?: SessionRules, carry = false): Promise<boolean> {
  await propagateLocalSettings(repoRoot, worktreePath, preserveExisting)
  return placeCheckoutFolders(repoRoot, worktreePath, dependencyLinksFrom, preserveExisting, permission, carry)
}

async function setWorktreeHooksPath(repoRoot: string, worktreePath: string): Promise<void> {
  return notBuilt('src/services/worktree.ts:620')
}

async function runPostCreationSetup(repoRoot: string, worktreePath: string, dependencyLinksFrom?: string, permission?: SessionRules, carry = false): Promise<string | undefined> {
  if (!(await prepareWorktreeFiles(repoRoot, worktreePath, dependencyLinksFrom, false, permission, carry))) return undefined
  await setWorktreeHooksPath(repoRoot, worktreePath)
  return runWorktreePrepareCommand(worktreePath)
}

async function launchWaitsForFolders(repoRoot: string): Promise<boolean> {
  const command = getInitialSettings().workspace?.worktree?.prepare
  if (command !== undefined && command.trim() !== '') return true
  try {
    await stat(join(repoRoot, '.worktreeinclude'))
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

function placeFoldersBehindLaunch(repoRoot: string, worktreePath: string, from: string, permission: ToolPermissionContext | undefined, carry: boolean): Promise<void> {
  const placing = (async () => {
    if (!(await placeCheckoutFolders(repoRoot, worktreePath, from, false, permission, carry))) return
    await setWorktreeHooksPath(repoRoot, worktreePath)
  })().catch(error => {
    logForDebugging(`the folders of ${worktreePath} were not placed: ${String(error)}`, { level: 'warn' })
  })
  const forget = registerCleanup(() => placing)
  void placing.then(forget)
  return placing
}

const WORKTREE_PREPARE_TIMEOUT_MS = 10 * 60 * 1000

async function runWorktreePrepareCommand(worktreePath: string): Promise<string | undefined> {
  const command = getInitialSettings().workspace?.worktree?.prepare
  if (command === undefined || command.trim() === '') return undefined
  const process = await startCommandHook({ command, shell: 'bash', name: 'workspace.worktree.prepare', event: 'workspace.worktree.prepare', index: 0, payloadJson: '', timeoutMs: WORKTREE_PREPARE_TIMEOUT_MS, source: { kind: 'settings' }, cwd: worktreePath })
  const end = await process.result
  if (end.kind === 'ended') return `workspace.worktree.prepare ${end.ending.class === 'timed_out' ? `timed out after ${end.ending.detail ?? ''} and was killed` : end.ending.class === 'spawn' ? `could not run${end.ending.detail ? `: ${end.ending.detail}` : ''}` : end.ending.class.replace('_', ' ')}`
  if (end.code === 0) return undefined
  return `workspace.worktree.prepare failed with exit ${end.code}${end.stderr.trim() ? `: ${end.stderr.trim()}` : ''}`
}


export { getCurrentWorktreeSession, restoreWorktreeSession, type WorktreeSession }

function persistWorktreeSession(session: WorktreeSession | null): void {
  saveCurrentProjectConfig(config => {
    if (session === null) {
      const { activeWorktreeSession: _dropped, ...rest } = config
      return rest
    }
    return {
      ...config,
      activeWorktreeSession: {
        originalCwd: session.originalCwd,
        worktreePath: session.worktreePath,
        worktreeName: session.worktreeName,
        ...(session.originalBranch !== undefined ? { originalBranch: session.originalBranch } : {}),
        sessionId: session.sessionId,
        ...(session.prepareFailure !== undefined ? { prepareFailure: session.prepareFailure } : {}),
      },
    }
  })
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number; gitRoot?: string; permission?: ToolPermissionContext },
): Promise<WorktreeSession> {
  return notBuilt('src/services/worktree.ts:714')
}

export async function keepWorktree(): Promise<void> {
  return notBuilt('src/services/worktree.ts:763')
}

async function removeWorktreeTree(worktreePath: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const aside = worktreeHoldsClones(worktreePath) ? setWorktreeAside(worktreePath) : null
  if (aside !== null) {
    const dropped = await runGit(['worktree', 'remove', '--force', worktreePath], cwd)
    if (dropped.code === 0) {
      discardSetAside(aside)
      return dropped
    }
    returnWorktreeFromAside(aside, worktreePath)
  }
  return runGit(['worktree', 'remove', '--force', worktreePath], cwd)
}

export async function cleanupWorktree(): Promise<void> {
  return notBuilt('src/services/worktree.ts:792')
}


type WorktreeCapability = Unbuilt

const refusalCountsByDirectory = new Map<string, number>()

export function _resetWorktreeRefusalCountsForTesting(): void {
  refusalCountsByDirectory.clear()
}

export function preflightWorktreeCapability(cwd: string = getCwd()): WorktreeCapability {
  const gitRoot = findCanonicalGitRoot(cwd)
  if (gitRoot) {
    return { available: true, detail: `git repository at ${gitRoot}`, repeatCount: 0 } as WorktreeCapability
  }
  const repeatCount = (refusalCountsByDirectory.get(cwd) ?? 0) + 1
  refusalCountsByDirectory.set(cwd, repeatCount)
  let detail =
    `Worktree isolation is unavailable in ${cwd}: not a git repository. ` +
    'For read-only work, retry the same call WITHOUT the isolation parameter. ' +
    'For write work, start Mercury inside the repository. ' +
    'This refusal is deterministic for this directory — an identical relaunch will refuse again.'
  if (repeatCount >= 2) {
    detail += ` (repeat refusal #${repeatCount}; the parameters have not changed)`
  }
  return {
    available: false,
    detail,
    prerequisite: 'git-repository',
    repeatCount,
  }
}

export async function createAgentWorktree(
  slug: string,
  options?: {
    at?: string
    from?: string
    foldersBehindLaunch?: boolean
    permission?: ToolPermissionContext
  },
): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  prepareFailure?: string
  ready?: Promise<void>
}> {
  return notBuilt('src/services/worktree.ts:860')
}

export async function unlockAgentWorktree(worktreePath: string, gitRoot: string): Promise<void> {
  return notBuilt('src/services/worktree.ts:923')
}


export { classifyPorcelainRecords, hasWorktreeChanges, readWorktreeDelta, worktreeRemovalSafe } from '../utils/worktree/delta.js'


const AGENT_LANE_SLUG = /^agent-a[0-9a-f]{7,32}$/
const CREWMATE_LANE_SLUG = /^agent-a[0-9a-z]{7}$/
const LANE_MARKER_FILENAME = 'WORKTREE_LANE'

async function markAgentLane(worktreePath: string, slug: string): Promise<void> {
  if (!AGENT_LANE_SLUG.test(slug) && !CREWMATE_LANE_SLUG.test(slug)) return
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return
  try {
    await writeFile(join(adminDir, LANE_MARKER_FILENAME), `agent ${slug}\n`)
  } catch (error) {
    logForDebugging(`worktree lane marker not written for ${worktreePath}: ${String(error)}`)
  }
}

export async function isAgentLane(slug: string, worktreePath: string): Promise<boolean> {
  if (AGENT_LANE_SLUG.test(slug)) return true
  if (!CREWMATE_LANE_SLUG.test(slug)) return false
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return false
  try {
    await stat(join(adminDir, LANE_MARKER_FILENAME))
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

const EPHEMERAL_SLUG_PATTERNS: RegExp[] = [
  AGENT_LANE_SLUG,
  /^parcel-[0-9a-f]{6,32}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  /^wf-\d+$/,
  /^bridge-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/,
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

function isEphemeralSlug(slug: string): boolean {
  return EPHEMERAL_SLUG_PATTERNS.some(pattern => pattern.test(slug))
}

const EPHEMERAL_RETENTION_FLOOR_MS = 7 * 24 * 60 * 60 * 1000

async function isDisownedWorktree(worktreePath: string): Promise<boolean> {
  let adminDir: string | null
  try {
    adminDir = await resolveWorktreeAdminDir(worktreePath, { throwOnReadError: true })
  } catch (error) {
    logForDebugging(`worktree janitor could not read .git in ${worktreePath}: ${String(error)}`, { level: 'warn' })
    return false
  }
  if (adminDir === null) {
    try {
      if ((await lstat(join(worktreePath, '.git'))).isDirectory()) return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logForDebugging(`worktree janitor could not stat .git in ${worktreePath}: ${String(error)}`, { level: 'warn' })
        return false
      }
    }
    return true
  }
  try {
    const returnLeg = (await readFile(join(adminDir, 'gitdir'), 'utf8')).trim()
    const canonicalReturn = await realpath(returnLeg)
    const canonicalOwn = await realpath(join(worktreePath, '.git'))
    return canonicalReturn !== canonicalOwn
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return true
    logForDebugging(`worktree janitor could not verify ownership of ${worktreePath}: ${String(error)}`, { level: 'warn' })
    return false
  }
}

export async function cleanupStaleAgentWorktrees(cutoffDate: Date): Promise<number> {
  return notBuilt('src/services/worktree.ts:1032')
}


export async function createBaselineWorktree(
  revision: string,
  root?: string,
): Promise<
  | { ok: true; path: string; revision: string; leaseId: string; dispose: () => Promise<void> }
  | { ok: false; reason: string }
> {
  const repoRoot = root ?? getCwd()
  const verify = await execFileNoThrowWithCwd('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd: repoRoot,
  })
  const sha = verify.stdout.trim()
  if (verify.code !== 0 || sha === '') {
    return { ok: false, reason: `"${revision}" is not a commit in this repository` }
  }

  const { getProjectTempDir } = await import('../utils/permissions/filesystem.js')
  const { registerScratchLease, releaseScratchLease } = await import('../utils/scratchLeases.js')

  const targetPath = join(getProjectTempDir(), 'baselines', sha.slice(0, 12))

  let alreadyThere = false
  const probe = await execFileNoThrowWithCwd('git', ['-C', targetPath, 'rev-parse', 'HEAD'], { cwd: repoRoot })
  if (probe.code === 0 && probe.stdout.trim() === sha) alreadyThere = true

  if (!alreadyThere) {
    const add = await execFileNoThrowWithCwd('git', ['worktree', 'add', '--detach', '--force', targetPath, sha], {
      cwd: repoRoot,
    })
    if (add.code !== 0) {
      const firstLine = (add.stderr.trim() !== '' ? add.stderr : add.stdout).trim().split('\n')[0] ?? ''
      return { ok: false, reason: firstLine }
    }
  }

  let lease: ReturnType<typeof registerScratchLease>
  try {
    lease = registerScratchLease({ kind: 'session', id: getSessionId() }, targetPath, {
      cleanupPolicy: 'on-complete',
      recovery: `baseline worktree at ${sha}; remove with: git worktree remove --force ${targetPath}`,
    })
  } catch (error) {
    if (!alreadyThere) {
      await execFileNoThrowWithCwd('git', ['worktree', 'remove', '--force', targetPath], { cwd: repoRoot })
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  return {
    ok: true,
    path: targetPath,
    revision: sha,
    leaseId: lease.leaseId,
    dispose: async () => {
      await execFileNoThrowWithCwd('git', ['worktree', 'remove', '--force', targetPath], { cwd: repoRoot })
      releaseScratchLease(lease.leaseId)
    },
  }
}


function parsePRReference(input: string): number | null {
  const urlMatch = input.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/)
  if (urlMatch) return parseInt(urlMatch[1] as string, 10)
  const shortMatch = input.match(/^#(\d+)$/)
  if (shortMatch) return parseInt(shortMatch[1] as string, 10)
  return null
}


export async function isTmuxAvailable(): Promise<boolean> {
  const result = await execFileNoThrowWithCwd('tmux', ['-V'], {})
  return result.code === 0
}

export function getTmuxInstallInstructions(): string {
  return notBuilt('src/services/worktree.ts:1214')
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  return notBuilt('src/services/worktree.ts:1227')
}

export function generateTmuxSessionName(repoPath: string, branch: string): string {
  return notBuilt('src/services/worktree.ts:1238')
}

export async function execIntoTmuxWorktree(args: string[]): Promise<{ handled: boolean; error?: string }> {
  return notBuilt('src/services/worktree.ts:1270')
}
