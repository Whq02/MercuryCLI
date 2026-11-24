import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import chalk from 'chalk'
import ignore from 'ignore'
import { getSessionId } from '../../../boot/process-state/processState.js'
import type { ToolPermissionContext } from '../../../tools/kit/tool.js'
import { getCwd } from '../../files/cwd.js'
import { logForDebugging } from '../../logs/debugLog.js'
import { findCanonicalGitRoot, findGitRoot, gitExe } from '../git.js'
import { readGitHead, readWorktreeHeadSha, resolveGitDir, getCommonDir } from '../gitFilesystem.js'
import { parseGitConfigValue } from '../gitConfigParser.js'
import { registerCleanup } from '../../processes/cleanupRegistry.js'
import { saveCurrentProjectConfig } from '../../settings/config.js'
import { containsPathTraversal } from '../../files/path.js'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, resolveProjectConfigPath } from '../../settings/projectConfig.js'
import { execFileNoThrowWithCwd } from '../../processes/execFileNoThrow.js'
import { startCommandHook } from '../../../integrations/event-hooks/commandRunner.js'
import { symlinkDeniedByPrivilege } from '../../host-os/files.js'
import { projectLocalPath } from '../../project-local/paths.js'
import { getInitialSettings, getRelativeSettingsFilePathForSource, getSettingsFilePathForSource } from '../../settings/settings.js'
import { sleep } from '../../async/sleep.js'
import { isInITerm2, isInsideTmuxSync } from '../../environment/terminalDetection.js'
import { canCloneHere, carryEntries, cloneIntoWorktree, cloneRefusedBetween, discardSetAside, recordWorktreeClones, returnWorktreeFromAside, setWorktreeAside, sweepSetAside, worktreeHoldsClones, type HeldBack } from './worktreeClone.js'
import { readWorktreeBaseline, resolveWorktreeAdminDir, writeWorktreeBaseline } from './baseline.js'
import { deltaBlocksSettlement, readWorktreeDelta, worktreeRemovalSafe } from './delta.js'
import { runGit } from './git.js'
import { getCurrentWorktreeSession, restoreWorktreeSession, type WorktreeSession } from './session.js'
import { getErrnoCode } from '../../errors/errors.js'
import { passedOver, passedOverAs } from '../../errors/passedOver.js'
import { hostEnv } from '../../environment/hostEnv.js'


const MAX_SLUG_LENGTH = 64

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`Worktree name exceeds the ${MAX_SLUG_LENGTH}-character limit (${slug.length})`)
  }
  for (const segment of slug.split(/\//)) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Worktree name "${slug}" contains a "." or ".." segment`)
    }
    if (segment.length === 0 || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `Worktree name "${slug}" is invalid: each slash-separated segment must be non-empty and may contain only letters, digits, dots, underscores and dashes`,
      )
    }
  }
}


function worktreesHome(gitRoot: string): string {
  return projectLocalPath(gitRoot, 'worktrees')
}

function flattenSlug(slug: string): string {
  return slug.replace(/\//g, '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
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

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const COMMIT_SPELLING_PATTERN = /^[A-Za-z0-9._/~^-]+$/

async function createOrResumeWorktreeNow(repoRoot: string, slug: string, options?: CreateOrResumeOptions): Promise<CreateOrResumeResult> {
  const worktreePath = worktreePathForSlug(repoRoot, slug)
  const home = worktreesHome(repoRoot)
  const baseCwd = options?.baseFrom ?? repoRoot
  if (options?.at !== undefined) {
    const ref = options.at
    if (!COMMIT_SPELLING_PATTERN.test(ref)) throw new Error(`The worktree commit ${JSON.stringify(ref)} is not a commit spelling`)
    const verified = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], baseCwd)
    const resolvedSha = verified.stdout.trim()
    if (verified.code !== 0 || !FULL_SHA_PATTERN.test(resolvedSha)) throw new Error(`The worktree commit ${ref} does not resolve to a commit in this repository`)
    const existingHead = await readWorktreeHeadSha(worktreePath)
    if (existingHead !== null) {
      if (existingHead === resolvedSha) return { worktreePath, headCommit: existingHead, existed: true }
      throw new Error(`The worktree ${worktreePath} already exists at ${existingHead.slice(0, 12)}, not at ${resolvedSha.slice(0, 12)}`)
    }
    await mkdir(home, { recursive: true })
    const add = await runWorktreeAdd(['worktree', 'add', '--detach', worktreePath, resolvedSha], repoRoot)
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`)
    await writeWorktreeBaseline(worktreePath, resolvedSha)
    return { worktreePath, headCommit: resolvedSha, existed: false }
  }
  const worktreeBranch = worktreeBranchName(slug)
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead !== null) {
    const baseline = await readWorktreeBaseline(worktreePath).catch(passedOverAs(null))
    return { worktreePath, worktreeBranch, headCommit: baseline ?? existingHead, existed: true }
  }
  await mkdir(home, { recursive: true })
  let baseCommit: string
  let baseBranch: string | undefined
  if (options?.prNumber !== undefined) {
    const fetched = await runGit(['fetch', 'origin', `pull/${options.prNumber}/head`], repoRoot, { suppressPrompts: true })
    if (fetched.code !== 0) {
      const detail = fetched.stderr.trim() || 'the PR may not exist, or this repository may have no origin remote'
      throw new Error(`Could not fetch PR #${options.prNumber}: ${detail}`)
    }
    const ref = 'FETCH_HEAD'
    const resolved = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], repoRoot)
    const sha = resolved.stdout.trim()
    if (resolved.code !== 0 || !FULL_SHA_PATTERN.test(sha)) throw new Error(`Could not resolve the worktree base ref ${ref}`)
    baseCommit = sha
  } else {
    const ref = 'HEAD'
    const resolved = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], baseCwd)
    const sha = resolved.stdout.trim()
    if (resolved.code !== 0 || !FULL_SHA_PATTERN.test(sha)) throw new Error(`Could not resolve the worktree base ref ${ref}`)
    baseCommit = sha
    const baseGitDir = await resolveGitDir(baseCwd)
    const head = baseGitDir !== null ? await readGitHead(baseGitDir) : null
    baseBranch = head?.type === 'branch' ? head.name : 'HEAD'
  }
  const sparsePaths = getInitialSettings().workspace?.worktree?.sparsePaths ?? []
  const useSparse = sparsePaths.length > 0
  const addArgs = ['worktree', 'add', ...(useSparse ? ['--no-checkout'] : []), '--no-track', '-b', worktreeBranch, worktreePath, baseCommit]
  const add = await runWorktreeAdd(addArgs, repoRoot)
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`)
  if (useSparse) {
    const sparse = await runGit(['sparse-checkout', 'set', '--cone', ...sparsePaths], worktreePath)
    if (sparse.code !== 0) {
      await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot)
      throw new Error(`git sparse-checkout failed: ${sparse.stderr.trim()}`)
    }
    const checkout = await runGit(['checkout', 'HEAD'], worktreePath)
    if (checkout.code !== 0) {
      await runGit(['worktree', 'remove', '--force', worktreePath], repoRoot)
      throw new Error(`git checkout failed in the sparse worktree: ${checkout.stderr.trim()}`)
    }
  }
  await writeWorktreeBaseline(worktreePath, baseCommit)
  return { worktreePath, worktreeBranch, headCommit: baseCommit, existed: false, ...(baseBranch !== undefined ? { baseBranch } : {}) }
}

function isDirJustifiedByPatterns(dirNoSlash: string, patterns: readonly string[], matcher: ReturnType<typeof ignore>): boolean {
  if (matcher.ignores(dirNoSlash)) return true
  const dirSlash = `${dirNoSlash}/`
  for (const rawRule of patterns) {
    if (rawRule.startsWith('!')) continue
    const rule = rawRule.startsWith('/') ? rawRule.slice(1) : rawRule
    const globIndex = rule.search(/[*?[{]/)
    if (globIndex === -1) {
      const clean = rule.replace(/\/+$/, '')
      if (clean === dirNoSlash || clean.startsWith(dirSlash) || dirNoSlash.startsWith(`${clean}/`)) return true
      continue
    }
    const literalPrefix = rule.slice(0, globIndex)
    if (literalPrefix.length > 0 && (literalPrefix.startsWith(dirSlash) || dirSlash.startsWith(literalPrefix))) return true
  }
  return false
}

async function copyWorktreeIncludeFiles(repoRoot: string, worktreePath: string, preserveExisting?: boolean): Promise<string[]> {
  let content: string
  try {
    content = await readFile(join(repoRoot, '.worktreeinclude'), 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logForDebugging(`.worktreeinclude could not be read (${String(error)}), so the files it lists were not copied into ${worktreePath}`, { level: 'warn' })
    }
    return []
  }
  const patterns = content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'))
  if (patterns.length === 0) return []
  const listed = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], repoRoot)
  if (listed.code !== 0 || listed.stdout === '') return []
  const matcher = ignore().add(content)
  const selected: string[] = []
  const dirsToExpand: string[] = []
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue
    if (entry.endsWith('/')) {
      const dirNoSlash = entry.slice(0, -1)
      if (dirNoSlash !== '' && isDirJustifiedByPatterns(dirNoSlash, patterns, matcher)) dirsToExpand.push(entry)
    } else if (matcher.ignores(entry)) {
      selected.push(entry)
    }
  }
  for (const dirEntry of dirsToExpand) {
    const expanded = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', dirEntry], repoRoot)
    if (expanded.code !== 0 || expanded.stdout === '') continue
    for (const file of expanded.stdout.split('\0')) {
      if (file !== '' && !file.endsWith('/') && matcher.ignores(file)) selected.push(file)
    }
  }
  const copied: string[] = []
  const copyMode = preserveExisting ? constants.COPYFILE_EXCL : 0
  for (const relative of selected) {
    const dest = join(worktreePath, relative)
    try {
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(join(repoRoot, relative), dest, copyMode)
      copied.push(relative)
    } catch (error) {
      if (preserveExisting && getErrnoCode(error) === 'EEXIST') continue
      logForDebugging(`worktreeinclude copy failed for ${relative}: ${String(error)}`, { level: 'warn' })
    }
  }
  if (copied.length > 0) logForDebugging(`worktreeinclude copied ${copied.length} files: ${copied.join(', ')}`)
  return copied
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
  const { getEmptyToolPermissionContext } = await import('../../../tools/kit/tool.js')
  const { applyPermissionRulesToPermissionContext } = await import('../../../permissions/rules/permissionDoor.js')
  const { permissionRuleValueFromString } = await import('../../../permissions/rules/permissionRuleParser.js')
  const { ruleMatcherFor } = await import('../../../permissions/rules/filesystem.js')
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
    const { readDenialFilter, ruleMatcherFor } = await import('../../../permissions/rules/filesystem.js')
    let rules = permission
    if (rules === undefined) {
      if (await ownSettingsDenyReads(sourceRoot)) return allHeld
      const { getEmptyToolPermissionContext } = await import('../../../tools/kit/tool.js')
      const { applyPermissionRulesToPermissionContext } = await import('../../../permissions/rules/permissionDoor.js')
      const { loadAllPermissionRulesFromDisk } = await import('../../../permissions/rules/permissionsLoader.js')
      rules = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk())
    }
    const narrowing = (rules.alwaysAllowRules as Record<string, readonly string[] | undefined>).toolsNarrowing ?? []
    if (!always && ruleMatcherFor(rules, 'read', 'deny') === null && narrowing.length === 0) {
      const { mercurySecretReadIgnores } = await import('../../../permissions/rules/protectedPaths.js')
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
  const { conventionsForProfile, isInstructionFilePath } = await import('../../../sessions/instructions/instructionFiles.js')
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
  const { mercurySecretReadIgnores } = await import('../../../permissions/rules/protectedPaths.js')
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

async function copyDirectoryWithHoldback(sourceRoot: string, source: string, target: string, relPath: string, heldUnder: () => Promise<((root: string) => HeldBack) | undefined>): Promise<boolean> {
  const heldFactory = await heldUnder()
  if (heldFactory === allHeld) {
    logForDebugging(`worktree copy skipped (the Read rules could not be read, and this account may not link it): ${relPath}`, { level: 'warn' })
    return false
  }
  let isHeld: ((entryPath: string) => Promise<boolean>) | undefined
  if (heldFactory !== undefined) {
    let sourceRootReal: string
    try {
      sourceRootReal = await realpath(sourceRoot)
    } catch (error) {
      passedOver(error)
      logForDebugging(`worktree copy skipped (the Read rules could not be read, and this account may not link it): ${relPath}`, { level: 'warn' })
      return false
    }
    const heldAtSpelling = heldFactory(resolve(sourceRoot))
    const heldAtReal = heldFactory(sourceRootReal)
    isHeld = async (entryPath: string): Promise<boolean> => {
      if (heldAtSpelling(entryPath) || heldAtReal(entryPath)) return true
      try {
        const resolved = await realpath(entryPath)
        return heldAtSpelling(resolved) || heldAtReal(resolved)
      } catch (error) {
        passedOver(error)
        return true
      }
    }
    if (await isHeld(source)) {
      logForDebugging(`worktree copy skipped (it stays behind, and this account may not link it): ${relPath}`, { level: 'warn' })
      return false
    }
  }
  try {
    await cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true, ...(isHeld !== undefined ? { filter: async (src: string) => !(await isHeld(src)) } : {}) })
    return true
  } catch (copyError) {
    await rm(target, { recursive: true, force: true }).catch(passedOver)
    const copyCode = getErrnoCode(copyError)
    if (copyCode !== 'ENOENT' && copyCode !== 'EEXIST') logForDebugging(`worktree symlink failed for ${relPath}: ${copyCode ?? String(copyError)}`, { level: 'warn' })
    return false
  }
}

async function linkCheckoutDirectories(sourceRoot: string, worktreePath: string, relPaths: readonly string[], heldUnder: () => Promise<((root: string) => HeldBack) | undefined>): Promise<string[]> {
  const placed: string[] = []
  for (const relPath of relPaths) {
    if (containsPathTraversal(relPath)) {
      logForDebugging(`worktree symlink entry skipped (path traversal): ${relPath}`, { level: 'warn' })
      continue
    }
    const segments = relPath.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
    if (segments.length === 0) continue
    const source = join(sourceRoot, ...segments)
    const target = join(worktreePath, ...segments)
    try {
      await stat(source)
    } catch (error) {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') logForDebugging(`worktree symlink failed for ${relPath}: ${code ?? String(error)}`, { level: 'warn' })
      continue
    }
    let targetExists = false
    try {
      await lstat(target)
      targetExists = true
    } catch (error) {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logForDebugging(`worktree symlink failed for ${relPath}: ${code ?? String(error)}`, { level: 'warn' })
        continue
      }
    }
    if (targetExists) continue
    try {
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, 'dir')
      placed.push(relPath)
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT' || code === 'EEXIST') continue
      if (symlinkDeniedByPrivilege(error)) {
        if (await copyDirectoryWithHoldback(sourceRoot, source, target, relPath, heldUnder)) placed.push(relPath)
        continue
      }
      logForDebugging(`worktree symlink failed for ${relPath}: ${code ?? String(error)}`, { level: 'warn' })
    }
  }
  return placed
}

async function hideLinksFromGit(repoRoot: string, worktreePath: string, sourceRoot: string, linked: readonly string[]): Promise<void> {
  if (linked.length === 0) return
  const toHide: string[] = []
  for (const raw of linked) {
    const rel = checkoutRelativeName(raw)
    if (rel !== '' && (await ignoredIn(sourceRoot, rel)) && !(await ignoredIn(worktreePath, rel))) toHide.push(`/${rel}`)
  }
  if (toHide.length === 0) return
  const gitDir = await resolveGitDir(repoRoot)
  if (gitDir === null) return
  const excludePath = join((await getCommonDir(gitDir)) ?? gitDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      logForDebugging(`worktree exclude read failed: ${String(error)}`, { level: 'warn' })
      return
    }
  }
  const existingLines = new Set(existing.split(/\r?\n/))
  const additions: string[] = []
  for (const line of toHide) {
    if (!existingLines.has(line)) {
      existingLines.add(line)
      additions.push(line)
    }
  }
  if (additions.length === 0) return
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  try {
    await mkdir(dirname(excludePath), { recursive: true })
    await writeFile(excludePath, `${existing}${separator}${additions.join('\n')}\n`, 'utf8')
  } catch (error) {
    logForDebugging(`worktree exclude write failed: ${String(error)}`, { level: 'warn' })
  }
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
  try {
    let hooksPath: string | null = null
    for (const candidate of [join(repoRoot, '.husky'), join(repoRoot, '.git', 'hooks')]) {
      try {
        if ((await stat(candidate)).isDirectory()) {
          hooksPath = candidate
          break
        }
      } catch (error) {
        passedOver(error)
      }
    }
    if (hooksPath === null) return
    const gitDir = await resolveGitDir(repoRoot)
    const commonDir = gitDir !== null ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = commonDir !== null ? await parseGitConfigValue(commonDir, 'core', null, 'hooksPath') : null
    if (existing === hooksPath) return
    const set = await runGit(['config', 'core.hooksPath', hooksPath], worktreePath)
    if (set.code === 0) {
      logForDebugging(`worktree hooksPath set to ${hooksPath}`)
    } else {
      logForDebugging(`worktree hooksPath set failed: ${set.stderr.trim()}`, { level: 'warn' })
    }
  } catch (error) {
    logForDebugging(`worktree hooks-path setup failed: ${String(error)}`, { level: 'warn' })
  }
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

export async function createWorktreeForSession(sessionId: string, slug: string, tmuxSessionName?: string, options?: { prNumber?: number; gitRoot?: string; permission?: ToolPermissionContext }): Promise<WorktreeSession> {
  validateWorktreeSlug(slug)
  const originalCwd = getCwd()
  const gitRoot = options?.gitRoot ?? findCanonicalGitRoot(originalCwd)
  if (!gitRoot) throw new Error('Cannot create a worktree: this is not a git repository.')
  const baseFrom = findGitRoot(originalCwd) ?? gitRoot
  const gitDir = await resolveGitDir(baseFrom)
  const head = gitDir !== null ? await readGitHead(gitDir) : null
  const originalBranch = head?.type === 'branch' ? head.name : undefined
  const startedAt = Date.now()
  const created = await createOrResumeWorktree(gitRoot, slug, { ...(options?.prNumber !== undefined ? { prNumber: options.prNumber } : {}), baseFrom })
  const creationDurationMs = Date.now() - startedAt
  logForDebugging(created.existed ? `resumed worktree ${created.worktreePath}` : `created worktree ${created.worktreePath} from ${created.baseBranch ?? 'HEAD'}`)
  const prepareFailure = created.existed ? undefined : await runPostCreationSetup(gitRoot, created.worktreePath, originalCwd, options?.permission, options?.prNumber === undefined)
  const usedSparsePaths = !created.existed && (getInitialSettings().workspace?.worktree?.sparsePaths ?? []).length > 0
  const session: WorktreeSession = {
    originalCwd,
    worktreePath: created.worktreePath,
    worktreeName: slug,
    worktreeBranch: created.worktreeBranch,
    ...(originalBranch !== undefined ? { originalBranch } : {}),
    ...(created.headCommit !== null ? { originalHeadCommit: created.headCommit } : {}),
    sessionId,
    ...(tmuxSessionName !== undefined ? { tmuxSessionName } : {}),
    ...(!created.existed ? { creationDurationMs } : {}),
    ...(usedSparsePaths ? { usedSparsePaths: true } : {}),
    ...(prepareFailure !== undefined ? { prepareFailure } : {}),
  }
  restoreWorktreeSession(session)
  persistWorktreeSession(session)
  return session
}

export async function keepWorktree(): Promise<void> {
  const session = getCurrentWorktreeSession()
  if (session === null) return
  try {
    process.chdir(session.originalCwd)
    restoreWorktreeSession(null)
    persistWorktreeSession(null)
    const branchNote = session.worktreeBranch !== undefined ? ` (branch ${session.worktreeBranch})` : ''
    logForDebugging(`worktree preserved at ${session.worktreePath}${branchNote}; cd there to continue working in it`)
  } catch (error) {
    logForDebugging(`keepWorktree failed: ${String(error)}`, { level: 'warn' })
    throw error
  }
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
  const session = getCurrentWorktreeSession()
  if (session === null) return
  try {
    process.chdir(session.originalCwd)
  } catch (error) {
    logForDebugging(`cleanupWorktree chdir failed: ${String(error)}`, { level: 'warn' })
    throw error
  }
  try {
    const repoCwd = findCanonicalGitRoot(session.originalCwd) ?? session.originalCwd
    const removed = await removeWorktreeTree(session.worktreePath, repoCwd)
    if (removed.code !== 0) {
      throw new Error(removed.stderr.trim() || removed.stdout.trim() || `git worktree remove exited ${removed.code}`)
    }
    restoreWorktreeSession(null)
    persistWorktreeSession(null)
    if (session.worktreeBranch !== undefined) {
      await sleep(100)
      const deleted = await runGit(['branch', '-D', session.worktreeBranch], repoCwd)
      if (deleted.code !== 0) logForDebugging(`worktree branch delete failed: ${deleted.stderr.trim()}`, { level: 'warn' })
    }
  } catch (error) {
    logForDebugging(`cleanupWorktree failed: ${String(error)}`, { level: 'warn' })
    throw error
  }
}


type WorktreeCapability = {
  available: boolean
  detail: string
  prerequisite?: 'git-repository'
  repeatCount?: number
}

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

export async function createCrewmateWorktree(
  slug: string,
  options?: { at?: string; from?: string; foldersBehindLaunch?: boolean; permission?: ToolPermissionContext },
): Promise<{ worktreePath: string; worktreeBranch?: string; headCommit?: string; gitRoot?: string; prepareFailure?: string; ready?: Promise<void> }> {
  validateWorktreeSlug(slug)
  const sourceDir = options?.from ?? getCwd()
  const gitRoot = findCanonicalGitRoot(sourceDir)
  if (!gitRoot) {
    throw new Error(
      'Worktree isolation is unavailable here: this is not a git repository. ' +
        'Retry the same Crewmate call WITHOUT the isolation parameter; the crewmate will run in the current directory.',
    )
  }
  const baseFrom = findGitRoot(sourceDir) ?? gitRoot
  const created = await createOrResumeWorktree(gitRoot, slug, { ...(options?.at !== undefined ? { at: options.at } : {}), baseFrom })
  if (created.existed) {
    const now = new Date()
    await utimes(created.worktreePath, now, now).catch(passedOver)
    logForDebugging(`resumed agent worktree ${created.worktreePath}`)
    return { worktreePath: created.worktreePath, worktreeBranch: created.worktreeBranch, ...(created.headCommit !== null ? { headCommit: created.headCommit } : {}), gitRoot }
  }
  await markCrewmateLane(created.worktreePath, slug)
  const behindLaunch = options?.foldersBehindLaunch === true && !(await launchWaitsForFolders(gitRoot))
  let prepareFailure: string | undefined
  if (behindLaunch) {
    await propagateLocalSettings(gitRoot, created.worktreePath, false)
  } else {
    prepareFailure = await runPostCreationSetup(gitRoot, created.worktreePath, baseFrom, options?.permission, options?.at === undefined)
  }
  const lock = await runGit(['worktree', 'lock', created.worktreePath, '--reason', `agent ${slug} (pid ${process.pid})`], gitRoot)
  if (lock.code !== 0) logForDebugging(`worktree lock failed for ${created.worktreePath}: ${lock.stderr.trim()}`, { level: 'warn' })
  const ready = behindLaunch ? placeFoldersBehindLaunch(gitRoot, created.worktreePath, baseFrom, options?.permission, options?.at === undefined) : undefined
  return {
    worktreePath: created.worktreePath,
    worktreeBranch: created.worktreeBranch,
    ...(created.headCommit !== null ? { headCommit: created.headCommit } : {}),
    gitRoot,
    ...(prepareFailure !== undefined ? { prepareFailure } : {}),
    ...(ready !== undefined ? { ready } : {}),
  }
}

export async function unlockCrewmateWorktree(worktreePath: string, gitRoot: string): Promise<void> {
  await runGit(['worktree', 'unlock', worktreePath], gitRoot)
}

async function removeCrewmateWorktree(worktreePath: string, worktreeBranch?: string, repoRoot?: string): Promise<boolean> {
  const gitRoot = repoRoot ?? findCanonicalGitRoot(worktreePath)
  if (!gitRoot) {
    logForDebugging(`removeAgentWorktree: no git root for ${worktreePath}`, { level: 'warn' })
    return false
  }
  await unlockCrewmateWorktree(worktreePath, gitRoot)
  const removed = await removeWorktreeTree(worktreePath, gitRoot)
  if (removed.code !== 0) {
    logForDebugging(`agent worktree remove failed: ${removed.stderr.trim()}`, { level: 'warn' })
    return false
  }
  if (worktreeBranch !== undefined) {
    const deleted = await runGit(['branch', '-D', worktreeBranch], gitRoot)
    if (deleted.code !== 0) logForDebugging(`agent worktree branch delete failed: ${deleted.stderr.trim()}`, { level: 'warn' })
  }
  return true
}


export { classifyPorcelainRecords, hasWorktreeChanges, readWorktreeDelta, worktreeRemovalSafe } from './delta.js'


const CREWMATE_LANE_HEX_SLUG = /^agent-a[0-9a-f]{7,32}$/
const CREWMATE_LANE_SLUG = /^agent-a[0-9a-z]{7}$/
const LANE_MARKER_FILENAME = 'WORKTREE_LANE'

async function markCrewmateLane(worktreePath: string, slug: string): Promise<void> {
  if (!CREWMATE_LANE_HEX_SLUG.test(slug) && !CREWMATE_LANE_SLUG.test(slug)) return
  const adminDir = await resolveWorktreeAdminDir(worktreePath)
  if (adminDir === null) return
  try {
    await writeFile(join(adminDir, LANE_MARKER_FILENAME), `agent ${slug}\n`)
  } catch (error) {
    logForDebugging(`worktree lane marker not written for ${worktreePath}: ${String(error)}`)
  }
}

export async function isCrewmateLane(slug: string, worktreePath: string): Promise<boolean> {
  if (CREWMATE_LANE_HEX_SLUG.test(slug)) return true
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
  CREWMATE_LANE_HEX_SLUG,
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

type JanitorCandidate = {
  path: string
  branch?: string
  registered: boolean
}

const MIN_VALID_DATE_MS = -8_640_000_000_000_000

async function collectJanitorCandidates(
  gitRoot: string,
  home: string,
): Promise<{ candidates: Map<string, JanitorCandidate>; registryAvailable: boolean }> {
  const candidates = new Map<string, JanitorCandidate>()
  const registeredPaths = new Set<string>()
  const listResult = await runGit(['worktree', 'list', '--porcelain'], gitRoot)
  const registryAvailable = listResult.code === 0
  const canonicalGitRoot = await realpath(gitRoot).catch(passedOverAs(resolve(gitRoot)))

  if (registryAvailable) {
    for (const block of listResult.stdout.split(/\n\n+/)) {
      let wtPath: string | undefined
      let wtBranch: string | undefined
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length).trim()
        } else if (line.startsWith('branch refs/heads/')) {
          wtBranch = line.slice('branch refs/heads/'.length).trim()
        }
      }
      if (!wtPath) continue
      const resolvedWt = resolve(wtPath)
      const canonicalWt = await realpath(resolvedWt).catch(passedOverAs(resolvedWt))
      registeredPaths.add(resolvedWt)
      registeredPaths.add(canonicalWt)
      if (canonicalWt === canonicalGitRoot) continue
      if (basename(dirname(resolvedWt)) !== 'worktrees') continue
      candidates.set(resolvedWt, {
        path: resolvedWt,
        branch: wtBranch,
        registered: true,
      })
    }
  }

  let homeEntries: string[] = []
  try {
    homeEntries = await readdir(home)
  } catch (error) {
    passedOver(error)
  }
  for (const entry of homeEntries) {
    const entryPath = resolve(home, entry)
    const canonicalEntry = await realpath(entryPath).catch(passedOverAs(entryPath))
    const existing = candidates.get(entryPath)
    const registered = existing?.registered ?? (registeredPaths.has(entryPath) || registeredPaths.has(canonicalEntry))
    candidates.set(entryPath, {
      path: entryPath,
      branch: existing?.branch,
      registered,
    })
  }

  return { candidates, registryAvailable }
}

async function sweepAdoptingSiblings(home: string, effectiveCutoffMs: number): Promise<number> {
  const parent = dirname(home)
  const prefix = `${basename(home)}.adopting-`
  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch (error) {
    passedOver(error)
    return 0
  }
  let swept = 0
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const siblingPath = join(parent, entry)
    try {
      const info = await lstat(siblingPath)
      if (info.mtimeMs >= effectiveCutoffMs) continue
      await rm(siblingPath, { recursive: true, force: true })
      swept++
    } catch (error) {
      passedOver(error)
    }
  }
  return swept
}

export async function cleanupStaleCrewmateWorktrees(cutoffDate: Date): Promise<number> {
  const requestedCutoffMs = cutoffDate.getTime()
  if (!Number.isFinite(requestedCutoffMs) || requestedCutoffMs <= MIN_VALID_DATE_MS) return 0
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) return 0

  const effectiveCutoffMs = Math.max(requestedCutoffMs, Date.now() - EPHEMERAL_RETENTION_FLOOR_MS)
  const home = worktreesHome(gitRoot)
  const { candidates, registryAvailable } = await collectJanitorCandidates(gitRoot, home)
  const activeSession = getCurrentWorktreeSession()
  const activePath = activeSession ? resolve(activeSession.worktreePath) : null

  let removed = 0
  for (const candidate of candidates.values()) {
    const slug = basename(candidate.path)
    if (activePath !== null && resolve(candidate.path) === activePath) continue
    const agentLane = await isCrewmateLane(slug, candidate.path)
    if (!agentLane && !isEphemeralSlug(slug)) continue

    let mtimeMs: number
    try {
      mtimeMs = (await stat(candidate.path)).mtimeMs
    } catch (error) {
      passedOver(error)
      continue
    }
    if (mtimeMs >= effectiveCutoffMs) continue

    if (agentLane) {
      if (registryAvailable && !candidate.registered && (await isDisownedWorktree(candidate.path))) {
        continue
      }
      const verdict = await worktreeRemovalSafe(candidate.path, candidate.branch)
      if (!verdict.safe) {
        logForDebugging(`worktree janitor keeps ${candidate.path}: ${verdict.detail}`)
        continue
      }
      if (await removeCrewmateWorktree(candidate.path, candidate.branch, gitRoot)) {
        removed++
      }
      continue
    }

    if (registryAvailable && !candidate.registered && (await isDisownedWorktree(candidate.path))) {
      try {
        await rm(candidate.path, { recursive: true, force: true })
        removed++
      } catch (error) {
        passedOver(error)
      }
      continue
    }

    const delta = await readWorktreeDelta(candidate.path)
    if (deltaBlocksSettlement(delta)) continue
    const unpushed = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], candidate.path)
    if (unpushed.code !== 0) continue
    const unpushedCount = parseInt(unpushed.stdout.trim(), 10)
    if (Number.isNaN(unpushedCount) || unpushedCount > 0) continue
    if (await removeCrewmateWorktree(candidate.path, candidate.branch, gitRoot)) {
      removed++
    }
  }

  removed += sweepSetAside(home)
  removed += await sweepAdoptingSiblings(home, effectiveCutoffMs)

  if (removed > 0) {
    await runGit(['worktree', 'prune'], gitRoot)
    logForDebugging(`worktree janitor removed ${removed} stale lanes`)
  }
  return removed
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

  const { getProjectTempDir } = await import('../../../permissions/rules/filesystem.js')
  const { registerScratchLease, releaseScratchLease } = await import('../../files/scratchLeases.js')

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

const THROWAWAY_ADJECTIVES = ['quick', 'calm', 'brisk', 'quiet', 'bright', 'spare'] as const
const THROWAWAY_NOUNS = ['lane', 'bench', 'desk', 'nook', 'yard', 'shed'] as const

function generateThrowawaySlug(): string {
  const adjective = THROWAWAY_ADJECTIVES[Math.floor(Math.random() * THROWAWAY_ADJECTIVES.length)]!
  const noun = THROWAWAY_NOUNS[Math.floor(Math.random() * THROWAWAY_NOUNS.length)]!
  const suffix = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')
  return `${adjective}-${noun}-${suffix}`
}

function runTmuxSync(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean },
): { status: number; stdout: string } {
  const result = spawnSync('tmux', args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: 'utf8',
    stdio: options?.inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    ...(options?.inherit ? {} : { timeout: 15_000 }),
    windowsHide: options?.inherit !== true,
  })
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  }
}

export function getTmuxInstallInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install tmux with: brew install tmux'
    case 'linux':
      return 'Install tmux with: sudo apt install tmux (or: sudo dnf install tmux)'
    case 'win32':
      return 'tmux is not natively available on Windows; consider WSL or Cygwin'
    default:
      return 'Install tmux through your system package manager'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const result = await execFileNoThrowWithCwd('tmux', ['new-session', '-d', '-s', sessionName, '-c', worktreePath], {})
  if (result.code === 0) return { created: true }
  return { created: false, error: result.stderr.trim() }
}

export function generateTmuxSessionName(repoPath: string, branch: string): string {
  return `${basename(repoPath)}_${branch}`.replace(/[/.]/g, '_')
}

function filterRelaunchArgs(args: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--multiplex' || arg.startsWith('--multiplex=')) continue
    if (arg.startsWith('--worktree=')) continue
    if (arg === '-w' || arg === '--worktree') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) i++
      continue
    }
    kept.push(arg)
  }
  return kept
}

export async function execIntoTmuxWorktree(args: string[]): Promise<{ handled: boolean; error?: string }> {
  if (process.platform === 'win32') {
    return { handled: false, error: '--multiplex is not supported on Windows' }
  }

  if (runTmuxSync(['-V']).status !== 0) {
    const hint =
      process.platform === 'darwin'
        ? 'Install it with: brew install tmux'
        : 'Install it with: sudo apt install tmux'
    return { handled: false, error: `tmux is not installed. ${hint}` }
  }

  let requestedName: string | undefined
  let classicMode = false
  let hasPendingBlockTools = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--multiplex=classic') {
      classicMode = true
    } else if (arg === '--block-tools' || arg.startsWith('--block-tools=')) {
      hasPendingBlockTools = true
    } else if (arg === '-w' || arg === '--worktree') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        requestedName = next
        i++
      }
    } else if (arg.startsWith('--worktree=')) {
      const value = arg.slice('--worktree='.length)
      if (value !== '') requestedName = value
    }
  }

  let prNumber: number | undefined
  let slug: string
  if (requestedName !== undefined) {
    const parsedPr = parsePRReference(requestedName)
    if (parsedPr !== null) {
      prNumber = parsedPr
      slug = `pr-${parsedPr}`
    } else {
      slug = requestedName
    }
  } else {
    slug = generateThrowawaySlug()
  }

  try {
    validateWorktreeSlug(slug)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { handled: false, error: `✕ ${message}` }
  }

  const cwd = getCwd()
  const gitRoot = findCanonicalGitRoot(cwd)
  if (!gitRoot) {
    return { handled: false, error: '--worktree requires a git repository' }
  }

  const baseCheckout = findGitRoot(cwd) ?? gitRoot
  let created: CreateOrResumeResult
  try {
    created = await createOrResumeWorktree(gitRoot, slug, {
      ...(prNumber !== undefined ? { prNumber } : {}),
      baseFrom: baseCheckout,
    })
    if (!created.existed) {
      process.stdout.write(`Created worktree ${created.worktreePath} (based on ${created.baseBranch ?? 'HEAD'})\n`)
      const prepareFailure = await runPostCreationSetup(
        gitRoot,
        created.worktreePath,
        baseCheckout,
        hasPendingBlockTools ? 'unknown' : undefined,
        prNumber === undefined,
      )
      if (prepareFailure !== undefined) {
        process.stderr.write(`${prepareFailure}\n`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { handled: false, error: message }
  }

  const sessionName = generateTmuxSessionName(gitRoot, created.worktreeBranch ?? worktreeBranchName(slug))
  const relaunchArgs = filterRelaunchArgs(args)
  const childCommand = [process.execPath, ...(process.argv[1] ? [process.argv[1]] : []), ...relaunchArgs]
  const sessionExists = runTmuxSync(['has-session', '-t', sessionName]).status === 0
  const insideTmux = isInsideTmuxSync()
  const useControlMode = !insideTmux && !classicMode && isInITerm2()
  if (!sessionExists && useControlMode) {
    const noticeLines = [
      '┌─ iTerm2 tip ─────────────────────────────────────────┐',
      '│ Set "Preferences > General > tmux > open tmux windows │',
      '│ as tabs in the attaching window" to open this session │',
      '│ as a tab instead of a new window.                     │',
      '└───────────────────────────────────────────────────────┘',
    ]
    for (const line of noticeLines) {
      process.stdout.write(`${chalk.yellow(line)}\n`)
    }
  }
  const childEnv: NodeJS.ProcessEnv = { ...hostEnv() }

  if (insideTmux) {
    if (!sessionExists) {
      runTmuxSync(
        ['new-session', '-d', '-s', sessionName, '-c', created.worktreePath, '--', ...childCommand],
        { cwd: created.worktreePath, env: childEnv },
      )
    }
    runTmuxSync(['switch-client', '-t', sessionName], {
      cwd: created.worktreePath,
      env: childEnv,
      inherit: true,
    })
    return { handled: true }
  }

  runTmuxSync(
    [
      ...(useControlMode ? ['-CC'] : []),
      'new-session',
      '-A',
      '-s',
      sessionName,
      '-c',
      created.worktreePath,
      '--',
      ...childCommand,
    ],
    { cwd: created.worktreePath, env: childEnv, inherit: true },
  )
  return { handled: true }
}
