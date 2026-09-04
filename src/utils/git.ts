import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { LRUCache } from 'lru-cache'
import { memoize } from 'lodash-es'

import { hasBinaryExtension, isBinaryContent } from '../constants/files.js'
import { getCwd } from './cwd.js'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'
import { projectScopePathspec } from './projectBoundary.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getWorktreeCountFromFs,
  isShallowClone,
  resolveGitDir,
} from './git/gitFilesystem.js'
import { logError } from './log.js'
import { whichSync } from './which.js'


const ROOT_CACHE_ENTRIES = 50


type RootMemo = { root: string | null }
type CachedFinder = ((startPath: string) => string | null) & { cache: LRUCache<string, RootMemo> }

function makeCachedFinder(compute: (startPath: string) => string | null): CachedFinder {
  const cache = new LRUCache<string, RootMemo>({ max: ROOT_CACHE_ENTRIES })
  const finder = ((startPath: string): string | null => {
    const memo = cache.get(startPath)
    if (memo) return memo.root
    const root = compute(startPath)
    cache.set(startPath, { root })
    return root
  }) as CachedFinder
  finder.cache = cache
  return finder
}

export const findGitRoot: CachedFinder = makeCachedFinder(startPath => {
  const startedAt = Date.now()
  let stats = 0
  logForDiagnosticsNoPII('debug', 'git_root_discovery_started')
  let current = resolve(startPath)
  for (;;) {
    stats++
    try {
      const entry = statSync(join(current, '.git'))
      if (entry.isDirectory() || entry.isFile()) {
        logForDiagnosticsNoPII('debug', 'git_root_discovery_completed', { found: true, stats, duration_ms: Date.now() - startedAt })
        return current.normalize('NFC')
      }
    } catch {
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  logForDiagnosticsNoPII('debug', 'git_root_discovery_completed', { found: false, stats, duration_ms: Date.now() - startedAt })
  return null
})

export const findCanonicalGitRoot: CachedFinder = makeCachedFinder(startPath => {
  const inputRoot = findGitRoot(startPath)
  if (inputRoot === null) return null
  try {
    let gitEntry: string
    try {
      gitEntry = readFileSync(join(inputRoot, '.git'), 'utf8').trim()
    } catch {
      return inputRoot
    }
    if (!gitEntry.startsWith('gitdir:')) return inputRoot
    const declared = gitEntry.slice('gitdir:'.length).trim()
    const gitDir = resolve(inputRoot, declared)
    const resolvedGitDir = realpathSync(gitDir)
    let commonDirPointer: string
    try {
      commonDirPointer = readFileSync(join(resolvedGitDir, 'commondir'), 'utf8').trim()
    } catch {
      return inputRoot
    }
    const commonDir = realpathSync(resolve(resolvedGitDir, commonDirPointer))
    if (dirname(resolvedGitDir) !== join(commonDir, 'worktrees')) return inputRoot
    const backLink = readFileSync(join(resolvedGitDir, 'gitdir'), 'utf8').trim()
    const expectedBackLink = join(realpathSync(inputRoot), '.git')
    if (resolve(backLink) !== expectedBackLink) return inputRoot
    const identity = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
    return identity.normalize('NFC')
  } catch {
    return inputRoot
  }
})

export const gitExe = memoize((): string => whichSync('git') ?? 'git')


export const getIsGit = memoize(async (): Promise<boolean> => {
  const startedAt = Date.now()
  logForDiagnosticsNoPII('debug', 'is_git_check_started')
  const result = findGitRoot(getCwd()) !== null
  logForDiagnosticsNoPII('debug', 'is_git_check_completed', { result, duration_ms: Date.now() - startedAt })
  return result
})

export async function dirIsInGitRepo(cwd: string): Promise<boolean> {
  return findGitRoot(cwd) !== null
}

export async function isAtGitRoot(): Promise<boolean> {
  const cwd = getCwd()
  const root = findGitRoot(cwd)
  if (!root) return false
  try {
    return realpathSync(cwd) === realpathSync(root)
  } catch {
    return cwd === root
  }
}

export async function getGitDir(cwd: string): Promise<string | null> {
  return (await resolveGitDir(cwd)) ?? null
}


export async function getHead(): Promise<string> {
  return getCachedHead()
}

export async function getBranch(cwd?: string): Promise<string> {
  if (cwd === undefined) return getCachedBranch()
  const result = await execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (result.code !== 0) return 'HEAD'
  const branch = result.stdout.trim()
  return branch === '' ? 'HEAD' : branch
}

export async function getDefaultBranch(cwd?: string): Promise<string> {
  if (cwd === undefined) return getCachedDefaultBranch()
  const symbolic = await execFileNoThrowWithCwd(gitExe(), ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd, preserveOutputOnError: false })
  const resolved = symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : ''
  const candidates = resolved ? [resolved, 'main', 'master'] : ['main', 'master']
  for (const candidate of candidates) {
    const probe = await execFileNoThrowWithCwd(gitExe(), ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], {
      cwd,
      preserveOutputOnError: false,
    })
    if (probe.code === 0) return candidate
  }
  return 'main'
}

export async function getRemoteUrl(): Promise<string | null> {
  return (await getCachedRemoteUrl()) || null
}

export async function getRemoteUrlForBridge(): Promise<string | null> {
  try {
    const root = findGitRoot(getCwd())
    if (root && root === homedir()) return null
  } catch {
  }
  return getRemoteUrl()
}

export function redactGitRemoteCredentials<T extends string | null | undefined>(url: T): T {
  if (url === null || url === undefined) return url
  return (url as string).replace(/:\/\/[^/@]+@/, '://***@') as T
}

export function normalizeGitRemoteUrl(url: string): string | null {
  let host: string | undefined
  let path: string | undefined
  const ssh = /^git@([^:]+):(.+)$/.exec(url)
  if (ssh) {
    host = ssh[1] as string
    path = ssh[2] as string
  } else {
    const parsed = /^(https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(url)
    if (!parsed) return null
    host = parsed[2] as string
    path = parsed[3] as string
  }
  path = path.replace(/\.git$/, '').replace(/\/+$/, '')
  const bareHost = host.replace(/:\d+$/, '')
  if ((bareHost === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(bareHost)) && path.startsWith('git/')) {
    const remainder = path.slice('git/'.length)
    const segments = remainder.split('/')
    if (segments.length >= 3 && (segments[0] as string).includes('.')) {
      host = segments[0] as string
      path = segments.slice(1).join('/')
    } else {
      host = 'github.com'
      path = remainder
    }
  }
  return `${host}/${path}`.toLowerCase()
}

export async function getRepoRemoteHash(): Promise<string | null> {
  const url = await getRemoteUrl()
  if (!url) return null
  const normalized = normalizeGitRemoteUrl(url)
  if (!normalized) return null
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}


export async function getIsHeadOnRemote(): Promise<boolean> {
  const result = await execFileNoThrow(gitExe(), ['rev-parse', '--verify', '@{upstream}'], { preserveOutputOnError: false })
  return result.code === 0
}

export async function getUnpushedCount(): Promise<number> {
  try {
    const result = await execFileNoThrow(gitExe(), ['rev-list', '--count', '@{upstream}..HEAD'], { preserveOutputOnError: false })
    if (result.code !== 0) return 0
    const count = parseInt(result.stdout.trim(), 10)
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  }
}

export async function hasUnpushedCommits(): Promise<boolean> {
  return (await getUnpushedCount()) > 0
}

export async function getIsClean(options?: {
  ignoreUntracked?: boolean
  untrackedFiles?: 'all' | 'normal'
}): Promise<boolean> {
  const args = ['status', '--porcelain']
  const mode = options?.ignoreUntracked ? 'no' : (options?.untrackedFiles ?? 'all')
  args.push(`--untracked-files=${mode}`)
  args.push(...projectScopePathspec(getCwd()))
  const result = await execFileNoThrow(gitExe(), args, { preserveOutputOnError: false, env: { GIT_OPTIONAL_LOCKS: '0' } })
  if (result.code !== 0) return false
  const meaningful = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .filter(line => {
      const path = line.replace(/^..\s+/, '').replace(/^"|"$/g, '')
      if (path.startsWith(`${MERCURY_PROJECT_DIR}/doctor/`)) return false
      return !(mode === 'normal' && path === `${MERCURY_PROJECT_DIR}/`)
    })
  return meaningful.length === 0
}

export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

export async function getFileStatus(): Promise<GitFileStatus> {
  const result = await execFileNoThrow(
    gitExe(),
    ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', ...projectScopePathspec(getCwd())],
    { preserveOutputOnError: false },
  )
  const tracked: string[] = []
  const untracked: string[] = []
  if (result.code !== 0) return { tracked, untracked }
  const tokens = result.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === '') continue
    const status = token.slice(0, 2)
    const path = token.slice(3)
    if (status[0] === 'R' || status[0] === 'C') {
      i++
    }
    if (status === '??') {
      untracked.push(path)
    } else if (path.length > 0) {
      tracked.push(path)
    }
  }
  return { tracked, untracked }
}

export async function getWorktreeCount(): Promise<number> {
  return getWorktreeCountFromFs()
}

export function isLinkedWorktree(startPath: string): boolean {
  const root = findGitRoot(startPath)
  if (!root) return false
  return findCanonicalGitRoot(root) !== root
}

export async function getGitWorktreeName(cwd: string): Promise<string | null> {
  if (isUncRoot(cwd)) return null
  const gitDir = await resolveGitDir(cwd)
  if (!gitDir) return null
  if (basename(dirname(gitDir)) === 'worktrees' && basename(gitDir) !== '.git') {
    return basename(gitDir)
  }
  return null
}

export async function stashToCleanState(message?: string): Promise<boolean> {
  try {
    const status = await getFileStatus()
    if (status.untracked.length > 0) {
      const add = await execFileNoThrow(gitExe(), ['add', '--', ...status.untracked], { preserveOutputOnError: false })
      if (add.code !== 0) return false
    }
    const stashMessage = message ?? `Mercury stash ${new Date().toISOString()}`
    const stash = await execFileNoThrow(gitExe(), ['stash', 'push', '-m', stashMessage], { preserveOutputOnError: false })
    return stash.code === 0
  } catch {
    return false
  }
}

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
  unpushedCount: number
}

export async function getGitState(options?: { untrackedFiles?: 'all' | 'normal' }): Promise<GitRepoState | null> {
  try {
    const [commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount, unpushedCount] =
      await Promise.all([
        getHead(),
        getBranch(),
        getRemoteUrl(),
        getIsHeadOnRemote(),
        getIsClean(options),
        getWorktreeCount(),
        getUnpushedCount(),
      ])
    if (!commitHash && (!branchName || branchName === 'HEAD')) return null
    return { commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount, unpushedCount }
  } catch {
    return null
  }
}

export async function getGithubRepo(): Promise<string | null> {
  const url = await getRemoteUrl()
  if (!url) {
    logForDebugging('getGithubRepo: no remote url')
    return null
  }
  const { parseGitRemote } = await import('./detectRepository.js')
  const parsed = parseGitRemote(url)
  if (!parsed || parsed.host !== 'github.com') {
    logForDebugging(`getGithubRepo: not a github.com remote (${redactGitRemoteCredentials(url)})`)
    return null
  }
  logForDebugging(`getGithubRepo: ${parsed.owner}/${parsed.name}`)
  return `${parsed.owner}/${parsed.name}`
}


export type PreservedGitState = {
  remote_base_sha: string | null
  remote_base: string | null
  patch: string
  untracked_files: Array<{ path: string; content: string }>
  format_patch: string | null
  head_sha: string | null
  branch_name: string | null
}

export async function findRemoteBase(): Promise<string | null> {
  const upstream = await execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    preserveOutputOnError: false,
  })
  if (upstream.code === 0 && upstream.stdout.trim() !== '') return upstream.stdout.trim()
  const symbolic = await execFileNoThrow(gitExe(), ['symbolic-ref', 'refs/remotes/origin/HEAD'], { preserveOutputOnError: false })
  const candidates: string[] = []
  if (symbolic.code === 0 && symbolic.stdout.trim() !== '') {
    candidates.push(symbolic.stdout.trim().replace(/^refs\/remotes\//, ''))
  }
  candidates.push('origin/main', 'origin/staging', 'origin/master')
  for (const candidate of candidates) {
    const probe = await execFileNoThrow(gitExe(), ['rev-parse', '--verify', candidate], { preserveOutputOnError: false })
    if (probe.code === 0) return candidate
  }
  return null
}

const UNTRACKED_FILE_CAP = 20000
const UNTRACKED_PER_FILE_MAX_BYTES = 500 * 1024 * 1024
const UNTRACKED_TOTAL_MAX_BYTES = 5 * 1024 * 1024 * 1024
const UNTRACKED_SNIFF_BYTES = 64 * 1024

async function captureUntrackedFiles(): Promise<Array<{ path: string; content: string }>> {
  const listing = await execFileNoThrow(gitExe(), ['ls-files', '--others', '--exclude-standard'], { preserveOutputOnError: false })
  if (listing.code !== 0 || listing.stdout.trim() === '') return []
  const files = listing.stdout.split('\n').filter(line => line.length > 0)
  const collected: Array<{ path: string; content: string }> = []
  let totalBytes = 0
  const fsImpl = getFsImplementation()
  for (const file of files) {
    if (collected.length >= UNTRACKED_FILE_CAP) {
      logForDebugging(`preserveGitState: untracked file cap (${UNTRACKED_FILE_CAP}) reached`)
      break
    }
    if (hasBinaryExtension(file)) continue
    try {
      const stats = fsImpl.statSync(file)
      if (stats.size > UNTRACKED_PER_FILE_MAX_BYTES) {
        logForDebugging(`preserveGitState: skipping oversized untracked file ${file}`)
        continue
      }
      if (totalBytes + stats.size > UNTRACKED_TOTAL_MAX_BYTES) {
        logForDebugging('preserveGitState: untracked total size cap reached')
        break
      }
      if (stats.size === 0) {
        collected.push({ path: file, content: '' })
        continue
      }
      const { buffer, bytesRead } = fsImpl.readSync(file, { length: Math.min(UNTRACKED_SNIFF_BYTES, stats.size) })
      const sniff = buffer.subarray(0, bytesRead)
      if (isBinaryContent(sniff)) continue
      const content = stats.size <= bytesRead ? sniff.toString('utf8') : fsImpl.readFileSync(file, { encoding: 'utf8' })
      collected.push({ path: file, content })
      totalBytes += stats.size
    } catch (err) {
      logForDebugging(`preserveGitState: unreadable untracked file ${file}: ${String(err)}`)
    }
  }
  return collected
}

export async function preserveGitStateForIssue(): Promise<PreservedGitState | null> {
  try {
    if (!(await getIsGit())) return null
    const headOnly = async (): Promise<PreservedGitState> => {
      const [patch, untracked] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch.stdout,
        untracked_files: untracked,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }
    if (await isShallowClone()) return headOnly()
    const remoteBase = await findRemoteBase()
    if (!remoteBase) return headOnly()
    const mergeBase = await execFileNoThrow(gitExe(), ['merge-base', remoteBase, 'HEAD'], { preserveOutputOnError: false })
    const mergeBaseSha = mergeBase.code === 0 ? mergeBase.stdout.trim() : ''
    if (mergeBaseSha === '') return headOnly()
    const [patch, untracked, formatPatch, head, branch] = await Promise.all([
      execFileNoThrow(gitExe(), ['diff', mergeBaseSha]),
      captureUntrackedFiles(),
      execFileNoThrow(gitExe(), ['format-patch', '--stdout', `${mergeBaseSha}..HEAD`]),
      execFileNoThrow(gitExe(), ['rev-parse', 'HEAD']),
      execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    const branchName = branch.stdout.trim()
    return {
      remote_base_sha: mergeBaseSha,
      remote_base: remoteBase,
      patch: patch.stdout,
      untracked_files: untracked,
      format_patch: formatPatch.code !== 0 || formatPatch.stdout.trim() === '' ? null : formatPatch.stdout,
      head_sha: head.stdout.trim() || null,
      branch_name: branchName === '' || branchName === 'HEAD' ? null : branchName,
    }
  } catch (err) {
    logError(err)
    return null
  }
}


export type BareRepoVerdict = false | 'gitdir-redirect-plantable' | 'gitdir-file-oversized' | 'bare-indicators'

const GITDIR_FILE_MAX_BYTES = 4096
const LEXICAL_SYMLINK_HOPS = 64

function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || /^(\\\\|\/\/)/.test(path) || (path.includes('\\') && !path.includes('/'))
}

function isUncRoot(path: string): boolean {
  return /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)
}

function resolveLexicallyHardened(path: string): string | undefined {
  let components = path.split(/[\\/]+/)
  let resolvedParts: string[] = []
  let hops = 0
  let index = 0
  while (index < components.length) {
    const component = components[index] as string
    index++
    if (component === '' || component === '.') continue
    if (component === '..') {
      resolvedParts.pop()
      continue
    }
    const candidate = sep + [...resolvedParts, component].join(sep)
    let stats
    try {
      stats = lstatSync(candidate)
    } catch {
      return undefined
    }
    if (!stats.isSymbolicLink()) {
      resolvedParts.push(component)
      continue
    }
    if (++hops > LEXICAL_SYMLINK_HOPS) return undefined
    let target: string
    try {
      target = readlinkSync(candidate)
    } catch {
      return undefined
    }
    if (process.platform !== 'win32' && looksLikeWindowsPath(target)) return undefined
    const remaining = components.slice(index)
    if (isAbsolute(target)) {
      resolvedParts = []
      components = [...target.split(/[\\/]+/), ...remaining]
    } else {
      components = [...target.split(/[\\/]+/), ...remaining]
    }
    index = 0
  }
  return sep + resolvedParts.join(sep)
}

function canonicalizeForGate(path: string): string {
  const lexical = resolveLexicallyHardened(path) ?? path
  let real = lexical
  try {
    real = realpathSync(lexical)
  } catch {
  }
  return real.normalize('NFC').toLowerCase()
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep)
}

function hasValidHead(gitDir: string): boolean {
  try {
    const headPath = join(gitDir, 'HEAD')
    const stats = lstatSync(headPath)
    if (!stats.isFile() || stats.size > GITDIR_FILE_MAX_BYTES) return false
    const head = readFileSync(headPath, 'utf8').slice(0, 255)
    return /^ref:[ \t]*refs\//.test(head) || /^([0-9a-f]{40}|[0-9a-f]{64})\s*$/.test(head)
  } catch {
    return false
  }
}

function isAccessibleDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function isTrustedGitDirectory(gitDir: string): boolean {
  if (!hasValidHead(gitDir)) return false
  if (!isAccessibleDirectory(join(gitDir, 'objects'))) return false
  if (!isAccessibleDirectory(join(gitDir, 'refs'))) return false
  if (existsSync(join(gitDir, 'commondir'))) return false
  return true
}

function hasBareIndicators(directory: string): boolean {
  try {
    const head = lstatSync(join(directory, 'HEAD'))
    if (head.isFile() || head.isSymbolicLink()) return true
  } catch {
  }
  return existsSync(join(directory, 'objects')) || existsSync(join(directory, 'refs'))
}

type GitEntryClass = 'trusted' | 'plantable' | 'oversized' | 'none'

function classifyRedirectTarget(target: string, canonicalCwd: string): GitEntryClass {
  const crossOs = process.platform !== 'win32' && looksLikeWindowsPath(target)
  if (crossOs) {
    if (!isUncRoot(target)) return 'plantable'
    return 'none'
  }
  const lexical = resolveLexicallyHardened(resolve(target))
  if (lexical === undefined) return 'plantable'
  let canonicalTarget: string
  try {
    canonicalTarget = realpathSync(lexical).normalize('NFC').toLowerCase()
  } catch {
    return 'plantable'
  }
  if (isInsideDirectory(canonicalTarget, canonicalCwd)) return 'plantable'
  const hasGitSegment = canonicalTarget.split(/[\\/]+/).some(segment => segment.toLowerCase() === '.git')
  if (!hasGitSegment) return 'plantable'
  return isTrustedGitDirectory(canonicalTarget) ? 'trusted' : 'none'
}

function classifyGitEntry(directory: string, canonicalCwd: string): GitEntryClass {
  const entryPath = join(directory, '.git')
  let stats
  try {
    stats = lstatSync(entryPath)
  } catch {
    return 'none'
  }
  if (stats.isSymbolicLink()) {
    let link: string
    try {
      link = readlinkSync(entryPath)
    } catch {
      return 'plantable'
    }
    return classifyRedirectTarget(isAbsolute(link) ? link : resolve(directory, link), canonicalCwd)
  }
  if (stats.isFile()) {
    if (stats.size > GITDIR_FILE_MAX_BYTES) return 'oversized'
    let contents: string
    try {
      contents = readFileSync(entryPath, 'utf8')
    } catch {
      return 'none'
    }
    if (contents.includes('\0')) return 'plantable'
    if (!contents.startsWith('gitdir: ')) return 'none'
    const declared = contents.slice('gitdir: '.length).replace(/[\r\n]+$/, '')
    return classifyRedirectTarget(isAbsolute(declared) ? declared : resolve(directory, declared), canonicalCwd)
  }
  if (stats.isDirectory()) {
    return isTrustedGitDirectory(entryPath) ? 'trusted' : 'none'
  }
  return 'none'
}

export function isCurrentDirectoryBareGitRepo(): BareRepoVerdict {
  const cwd = getCwd()
  const canonicalCwd = canonicalizeForGate(cwd)
  const emit = (verdict: BareRepoVerdict): BareRepoVerdict => {
    logForDiagnosticsNoPII('debug', 'bare_repo_gate', { verdict: verdict === false ? 'safe' : verdict })
    return verdict
  }
  const own = classifyGitEntry(cwd, canonicalCwd)
  if (own === 'plantable') return emit('gitdir-redirect-plantable')
  if (own === 'oversized') return emit('gitdir-file-oversized')
  if (own === 'trusted') return emit(false)

  let current = cwd
  for (;;) {
    if (hasBareIndicators(current)) return emit('bare-indicators')
    const parent = dirname(current)
    if (parent === current) return emit(false)
    current = parent
    const ancestor = classifyGitEntry(current, canonicalCwd)
    if (ancestor === 'trusted') return emit(false)
    if (ancestor === 'plantable') return emit('gitdir-redirect-plantable')
    if (ancestor === 'oversized') return emit('gitdir-file-oversized')
  }
}
