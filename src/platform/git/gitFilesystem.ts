import { unwatchFile, watchFile, type StatsListener } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { waitForScrollIdle } from '../../boot/process-state/processState.js'
import { registerCleanup } from '../processes/cleanupRegistry.js'
import { getCwd } from '../files/cwd.js'
import { parseGitConfigValue } from './gitConfigParser.js'
import { findGitRoot } from './gitRoot.js'
import { getErrnoCode, isENOENT } from '../errors/errors.js'
import { passedOver } from '../errors/passedOver.js'


const gitDirCache = new Map<string, string | null>()

export function clearResolveGitDirCache(): void {
  gitDirCache.clear()
}

export async function resolveGitDir(startPath?: string): Promise<string | null> {
  const key = resolve(startPath ?? getCwd())
  if (gitDirCache.has(key)) return gitDirCache.get(key) ?? null
  const root = findGitRoot(key)
  if (root === null) {
    gitDirCache.set(key, null)
    return null
  }
  const dotGit = join(root, '.git')
  try {
    const info = await stat(dotGit)
    let result = dotGit
    if (info.isFile()) {
      const content = (await readFile(dotGit, 'utf8')).trim()
      if (content.startsWith('gitdir:')) {
        const target = content.slice('gitdir:'.length).trim()
        if (target) {
          result = resolve(root, target)
        }
      }
    }
    gitDirCache.set(key, result)
    return result
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      gitDirCache.set(key, null)
    } else {
      passedOver(error)
    }
    return null
  }
}

const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function isValidSha(value: string): boolean {
  return HEX_SHA_RE.test(value)
}

function isSafeRefName(name: string): boolean {
  if (!name || name.startsWith('-') || name.startsWith('/') || name.includes('..')) return false
  if (!/^[A-Za-z0-9/._+@-]+$/.test(name)) return false
  return !name.split('/').some(part => part === '' || part === '.')
}


export async function readGitHead(
  gitDir: string,
): Promise<{ type: 'branch'; name: string } | { type: 'detached'; sha: string } | null> {
  try {
    const raw = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (raw.startsWith('ref:')) {
      const target = raw.slice('ref:'.length).trim()
      if (!isSafeRefName(target)) return null
      if (target.startsWith('refs/heads/')) {
        const name = target.slice('refs/heads/'.length)
        if (!isSafeRefName(name)) return null
        return { type: 'branch', name }
      }
      const sha = (await resolveRef(gitDir, target)) ?? ''
      return { type: 'detached', sha }
    }
    if (isValidSha(raw)) {
      return { type: 'detached', sha: raw }
    }
    return null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export async function getCommonDir(gitDir: string): Promise<string | null> {
  try {
    const raw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    if (!raw) return null
    return resolve(gitDir, raw)
  } catch (error) {
    passedOver(error)
    return null
  }
}

async function resolveRefInDir(dir: string, ref: string, visited = new Set<string>()): Promise<string | null> {
  if (!isSafeRefName(ref) || visited.has(ref)) return null
  visited.add(ref)
  try {
    const raw = (await readFile(join(dir, ref), 'utf8')).trim()
    if (raw.startsWith('ref:')) {
      const target = raw.slice('ref:'.length).trim()
      if (!isSafeRefName(target)) return null
      return resolveRefInDir(dir, target, visited)
    }
    return isValidSha(raw) ? raw : null
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  let packed: string
  try {
    packed = await readFile(join(dir, 'packed-refs'), 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  for (const line of packed.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue
    const spaceIndex = trimmed.indexOf(' ')
    if (spaceIndex === -1) continue
    const sha = trimmed.slice(0, spaceIndex)
    const name = trimmed.slice(spaceIndex + 1)
    if (name === ref && isValidSha(sha)) return sha
  }
  return null
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  if (!isSafeRefName(ref)) return null
  const direct = await resolveRefInDir(gitDir, ref)
  if (direct !== null) return direct
  const commonDir = await getCommonDir(gitDir)
  if (commonDir !== null && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref)
  }
  return null
}

async function readRawSymref(gitDir: string, refPath: string, branchPrefix: string): Promise<string | null> {
  if (!isSafeRefName(refPath)) return null
  let raw: string
  try {
    raw = (await readFile(join(gitDir, refPath), 'utf8')).trim()
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  if (!raw.startsWith('ref:')) return null
  const target = raw.slice('ref:'.length).trim()
  if (!target.startsWith(branchPrefix)) return null
  const suffix = target.slice(branchPrefix.length)
  return isSafeRefName(suffix) ? suffix : null
}


const POLL_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 1000

type WatchListener = StatsListener

let watcherStarted = false
let watcherStarting: Promise<void> | null = null
let generation = 0
let watchedGitDir: string | null = null
let watchedCommonDir: string | null = null
let watchedBranchRefPath: string | null = null
let watchedUpstreamRefPath: string | null = null
let cleanupRegistered = false
const watchedPaths = new Map<string, WatchListener>()
type CacheEntry = { value: unknown; dirty: boolean; inflight: Promise<unknown> | null }
const cacheEntries = new Map<string, CacheEntry>()


export type GitChangeSignal =
  | 'head'
  | 'config'
  | 'branch-ref'
  | 'upstream-ref'
  | 'packed-refs'
  | 'index'
  | 'worktrees'
  | 'reground'

type ChangeListener = (signal: GitChangeSignal) => void
const changeListeners = new Set<ChangeListener>()

export function subscribeGitChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function signalChange(signal: GitChangeSignal): void {
  for (const listener of changeListeners) {
    try {
      listener(signal)
    } catch (error) {
      passedOver(error)
    }
  }
}

function watchPath(path: string, listener: WatchListener): void {
  const guarded: WatchListener = (curr, prev) => {
    if (!(curr.ino || curr.mtimeMs) && !(prev.ino || prev.mtimeMs)) return
    listener(curr, prev)
  }
  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, guarded)
  watchedPaths.set(path, guarded)
}

function unwatchPath(path: string): void {
  const listener = watchedPaths.get(path)
  if (listener !== undefined) {
    unwatchFile(path, listener)
    watchedPaths.delete(path)
  }
}

function invalidateAllEntries(): void {
  for (const entry of cacheEntries.values()) entry.dirty = true
}

async function reattachBranchWatch(): Promise<void> {
  const startGeneration = generation
  if (watchedGitDir === null) return
  const head = await readGitHead(watchedGitDir)
  if (generation !== startGeneration) return
  const refsDir = watchedCommonDir ?? watchedGitDir
  const nextRefPath = head?.type === 'branch' ? join(refsDir, 'refs', 'heads', head.name) : null
  const nextUpstreamPath = head?.type === 'branch' ? await upstreamRefPath(watchedGitDir, refsDir, head.name) : null
  if (generation !== startGeneration) return
  if (nextUpstreamPath !== watchedUpstreamRefPath) {
    if (watchedUpstreamRefPath !== null) unwatchPath(watchedUpstreamRefPath)
    watchedUpstreamRefPath = nextUpstreamPath
    if (nextUpstreamPath !== null) {
      watchPath(nextUpstreamPath, () => signalChange('upstream-ref'))
    }
  }
  if (nextRefPath === watchedBranchRefPath) return
  if (watchedBranchRefPath !== null) unwatchPath(watchedBranchRefPath)
  watchedBranchRefPath = nextRefPath
  if (nextRefPath !== null) {
    watchPath(nextRefPath, () => {
      invalidateAllEntries()
      signalChange('branch-ref')
    })
  }
}

async function upstreamRefPath(gitDir: string, refsDir: string, branch: string): Promise<string | null> {
  const read = async (key: string): Promise<string | null> => {
    const own = await parseGitConfigValue(gitDir, 'branch', branch, key)
    if (own !== null) return own
    if (watchedCommonDir !== null && watchedCommonDir !== gitDir) {
      return parseGitConfigValue(watchedCommonDir, 'branch', branch, key)
    }
    return null
  }
  const remote = await read('remote')
  const merge = await read('merge')
  if (remote === null || merge === null || !isSafeRefName(merge)) return null
  if (remote === '.') return join(refsDir, merge)
  if (!isSafeRefName(remote)) return null
  const tail = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : merge
  return join(refsDir, 'refs', 'remotes', remote, tail)
}

async function onHeadChange(): Promise<void> {
  invalidateAllEntries()
  signalChange('head')
  await waitForScrollIdle()
  await reattachBranchWatch()
}

export function regroundGitWatch(): void {
  generation++
  teardownWatches()
  watcherStarted = false
  watcherStarting = null
  watchedGitDir = null
  watchedCommonDir = null
  watchedBranchRefPath = null
  watchedUpstreamRefPath = null
  cacheEntries.clear()
  clearResolveGitDirCache()
  signalChange('reground')
}

function teardownWatches(): void {
  for (const [path, listener] of watchedPaths) {
    unwatchFile(path, listener)
  }
  watchedPaths.clear()
}

async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return
  if (watcherStarting !== null) return watcherStarting
  watcherStarting = (async () => {
    const startGeneration = generation
    const gitDir = await resolveGitDir()
    if (generation !== startGeneration) return
    watcherStarted = true
    if (!cleanupRegistered) {
      cleanupRegistered = true
      registerCleanup(async () => teardownWatches())
    }
    if (gitDir === null) return
    watchedGitDir = gitDir
    watchedCommonDir = await getCommonDir(gitDir)
    if (generation !== startGeneration) return
    const commonDir = watchedCommonDir ?? gitDir
    watchPath(join(gitDir, 'HEAD'), () => void onHeadChange().catch(passedOver))
    watchPath(join(commonDir, 'config'), () => {
      invalidateAllEntries()
      signalChange('config')
      void reattachBranchWatch().catch(passedOver)
    })
    watchPath(join(gitDir, 'index'), () => signalChange('index'))
    watchPath(join(commonDir, 'packed-refs'), () => {
      invalidateAllEntries()
      signalChange('packed-refs')
    })
    watchPath(join(commonDir, 'worktrees'), () => signalChange('worktrees'))
    await reattachBranchWatch()
  })().finally(() => {
    watcherStarting = null
  })
  return watcherStarting
}

async function cachedRead<T>(key: string, compute: () => Promise<T>): Promise<T> {
  await ensureWatcherStarted()
  while (!watcherStarted) {
    await ensureWatcherStarted()
  }
  const startGen = generation
  const existing = cacheEntries.get(key)
  if (existing !== undefined && !existing.dirty) {
    if (existing.inflight !== null) {
      return existing.inflight as Promise<T>
    }
    return existing.value as T
  }
  const entry: CacheEntry = existing ?? { value: undefined, dirty: false, inflight: null }
  entry.dirty = false
  cacheEntries.set(key, entry)
  let promise: Promise<T> | null = null
  promise = (async () => {
    try {
      const value = await compute()
      if (generation !== startGen) {
        if (entry.inflight === promise) entry.inflight = null
        return cachedRead(key, compute)
      }
      if (entry.inflight === promise) {
        entry.inflight = null
        if (!entry.dirty && cacheEntries.get(key) === entry) {
          entry.value = value
        }
      }
      return value
    } catch (error) {
      if (entry.inflight === promise) {
        entry.inflight = null
        entry.dirty = true
      }
      throw error
    }
  })()
  entry.inflight = promise
  return promise
}

export async function getCachedBranch(): Promise<string> {
  return cachedRead('branch', async () => {
    if (watchedGitDir === null) return 'HEAD'
    const head = await readGitHead(watchedGitDir)
    if (head === null || head.type !== 'branch') return 'HEAD'
    return head.name
  })
}

export async function getCachedHead(): Promise<string> {
  return cachedRead('head', async () => {
    if (watchedGitDir === null) return ''
    const head = await readGitHead(watchedGitDir)
    if (head === null) return ''
    if (head.type === 'detached') return head.sha
    return (await resolveRef(watchedGitDir, `refs/heads/${head.name}`)) ?? ''
  })
}

export async function getCachedRemoteUrl(): Promise<string | null> {
  return cachedRead('remoteUrl', async () => {
    if (watchedGitDir === null) return null
    const fromGitDir = await parseGitConfigValue(watchedGitDir, 'remote', 'origin', 'url')
    if (fromGitDir !== null) return fromGitDir
    if (watchedCommonDir !== null && watchedCommonDir !== watchedGitDir) {
      return parseGitConfigValue(watchedCommonDir, 'remote', 'origin', 'url')
    }
    return null
  })
}

export async function getCachedDefaultBranch(): Promise<string> {
  return cachedRead('defaultBranch', async () => {
    if (watchedGitDir === null) return 'main'
    const refsDir = watchedCommonDir ?? watchedGitDir
    const symref = await readRawSymref(refsDir, 'refs/remotes/origin/HEAD', 'refs/remotes/origin/')
    if (symref !== null) return symref
    for (const candidate of ['main', 'master']) {
      const sha = await resolveRefInDir(refsDir, `refs/remotes/origin/${candidate}`)
      if (sha !== null) return candidate
    }
    return 'main'
  })
}


export async function readWorktreeHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const dotGit = join(worktreePath, '.git')
    const info = await stat(dotGit)
    if (!info.isFile()) return null
    const content = (await readFile(dotGit, 'utf8')).trim()
    if (!content.startsWith('gitdir:')) return null
    const target = content.slice('gitdir:'.length).trim()
    if (!target) return null
    const gitDir = resolve(worktreePath, target)
    const head = await readGitHead(gitDir)
    if (head === null) return null
    if (head.type === 'detached') return head.sha || null
    return await resolveRef(gitDir, `refs/heads/${head.name}`)
  } catch (error) {
    passedOver(error)
    return null
  }
}

const linkedWorktreeCount = async (adminDir: string): Promise<number> => {
  try {
    return (await readdir(join(adminDir, 'worktrees'))).length
  } catch (error) {
    if (isENOENT(error)) return 0
    throw error
  }
}

export async function getWorktreeCountFromFs(): Promise<number> {
  const gitDir = await resolveGitDir()
  if (gitDir === null) return 0
  const adminDir = (await getCommonDir(gitDir)) ?? gitDir
  return 1 + (await linkedWorktreeCount(adminDir))
}
