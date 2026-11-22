import { unwatchFile, watchFile, type StatsListener } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { waitForScrollIdle } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { parseGitConfigValue } from './gitConfigParser.js'
import { findGitRoot } from './gitRoot.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'


const gitDirCache = new Map<string, string | null>()

export function clearResolveGitDirCache(): void {
  gitDirCache.clear()
}

export async function resolveGitDir(startPath?: string): Promise<string | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:21')
}


function isSafeRefName(name: string): boolean {
  return notBuilt('src/utils/git/gitFilesystem.ts:56')
}


export async function readGitHead(
  gitDir: string,
): Promise<{ type: 'branch'; name: string } | { type: 'detached'; sha: string } | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:71')
}

export async function getCommonDir(gitDir: string): Promise<string | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:94')
}

async function resolveRefInDir(dir: string, ref: string): Promise<string | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:104')
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:138')
}

async function readRawSymref(gitDir: string, refPath: string, branchPrefix: string): Promise<string | null> {
  return notBuilt('src/utils/git/gitFilesystem.ts:148')
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
  return notBuilt('src/utils/git/gitFilesystem.ts:340')
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
  return notBuilt('src/utils/git/gitFilesystem.ts:417')
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
