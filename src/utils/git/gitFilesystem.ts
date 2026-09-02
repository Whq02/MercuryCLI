import { unwatchFile, watchFile } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { waitForScrollIdle } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { findGitRoot } from '../git.js'
import { parseGitConfigValue } from './gitConfigParser.js'


const gitDirCache = new Map<string, string | null>()

export function clearResolveGitDirCache(): void {
  gitDirCache.clear()
}

export async function resolveGitDir(startPath: string = getCwd()): Promise<string | null> {
  const resolvedStart = resolve(startPath)
  if (gitDirCache.has(resolvedStart)) return gitDirCache.get(resolvedStart) ?? null
  let result: string | null = null
  try {
    const root = findGitRoot(resolvedStart)
    if (!root) {
      gitDirCache.set(resolvedStart, null)
      return null
    }
    const dotGitPath = join(root, '.git')
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isFile()) {
      const content = (await readFile(dotGitPath, 'utf8')).trim()
      if (content.startsWith('gitdir:')) {
        result = resolve(root, content.slice('gitdir:'.length).trim())
        gitDirCache.set(resolvedStart, result)
        return result
      }
    }
    result = dotGitPath
  } catch {
    result = null
  }
  gitDirCache.set(resolvedStart, result)
  return result
}


export function isSafeRefName(name: string): boolean {
  if (name === '') return false
  if (name.startsWith('-') || name.startsWith('/')) return false
  if (name.includes('..')) return false
  for (const component of name.split('/')) {
    if (component === '.' || component === '') return false
  }
  return /^[A-Za-z0-9/._+@-]+$/.test(name)
}

export function isValidGitSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s)
}


export async function readGitHead(
  gitDir: string,
): Promise<{ type: 'branch'; name: string } | { type: 'detached'; sha: string } | null> {
  try {
    const content = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    if (content.startsWith('ref:')) {
      const target = content.slice('ref:'.length).trim()
      if (target.startsWith('refs/heads/')) {
        const name = target.slice('refs/heads/'.length)
        return isSafeRefName(name) ? { type: 'branch', name } : null
      }
      if (!isSafeRefName(target)) return null
      const sha = await resolveRef(gitDir, target)
      return { type: 'detached', sha: sha ?? '' }
    }
    if (!isValidGitSha(content)) return null
    return { type: 'detached', sha: content }
  } catch {
    return null
  }
}

export async function getCommonDir(gitDir: string): Promise<string | null> {
  try {
    const content = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    return resolve(gitDir, content)
  } catch {
    return null
  }
}

async function resolveRefInDir(dir: string, ref: string): Promise<string | null> {
  let looseContent: string | null = null
  try {
    looseContent = (await readFile(join(dir, ref), 'utf8')).trim()
  } catch {
    looseContent = null
  }
  if (looseContent !== null) {
    if (looseContent.startsWith('ref:')) {
      const target = looseContent.slice('ref:'.length).trim()
      if (!isSafeRefName(target)) return null
      return resolveRef(dir, target)
    }
    return isValidGitSha(looseContent) ? looseContent : null
  }
  try {
    const packed = await readFile(join(dir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue
      const spaceIndex = line.indexOf(' ')
      if (spaceIndex === -1) continue
      if (line.slice(spaceIndex + 1) === ref) {
        const sha = line.slice(0, spaceIndex)
        return isValidGitSha(sha) ? sha : null
      }
    }
    return null
  } catch {
    return null
  }
}

export async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  const direct = await resolveRefInDir(gitDir, ref)
  if (direct !== null) return direct
  const commonDir = await getCommonDir(gitDir)
  if (commonDir !== null && commonDir !== gitDir) {
    return resolveRefInDir(commonDir, ref)
  }
  return null
}

export async function readRawSymref(gitDir: string, refPath: string, branchPrefix: string): Promise<string | null> {
  try {
    const content = (await readFile(join(gitDir, refPath), 'utf8')).trim()
    if (!content.startsWith('ref:')) return null
    const target = content.slice('ref:'.length).trim()
    if (!target.startsWith(branchPrefix)) return null
    const name = target.slice(branchPrefix.length)
    return isSafeRefName(name) ? name : null
  } catch {
    return null
  }
}


const POLL_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 1000

type WatchListener = (curr: unknown, prev: unknown) => void

let watcherStarted = false
let watcherStarting: Promise<void> | null = null
let generation = 0
let watchedGitDir: string | null = null
let watchedCommonDir: string | null = null
let watchedBranchRefPath: string | null = null
let cleanupRegistered = false
const watchedPaths = new Map<string, WatchListener>()
type CacheEntry = { value: unknown; dirty: boolean; inflight: Promise<unknown> | null }
const cacheEntries = new Map<string, CacheEntry>()

function watchPath(path: string, listener: WatchListener): void {
  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, listener as never)
  watchedPaths.set(path, listener)
}

function unwatchPath(path: string): void {
  const listener = watchedPaths.get(path)
  if (listener !== undefined) {
    unwatchFile(path, listener as never)
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
  if (nextRefPath === watchedBranchRefPath) return
  if (watchedBranchRefPath !== null) unwatchPath(watchedBranchRefPath)
  watchedBranchRefPath = nextRefPath
  if (nextRefPath !== null) {
    watchPath(nextRefPath, () => invalidateAllEntries())
  }
}

async function onHeadChange(): Promise<void> {
  invalidateAllEntries()
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
  cacheEntries.clear()
  clearResolveGitDirCache()
}

function teardownWatches(): void {
  for (const [path, listener] of watchedPaths) {
    unwatchFile(path, listener as never)
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
    watchPath(join(gitDir, 'HEAD'), () => void onHeadChange())
    watchPath(join(watchedCommonDir ?? gitDir, 'config'), () => invalidateAllEntries())
    await reattachBranchWatch()
  })().finally(() => {
    watcherStarting = null
  })
  return watcherStarting
}

async function cachedRead<T>(key: string, compute: () => Promise<T>): Promise<T> {
  await ensureWatcherStarted()
  for (;;) {
    const startGeneration = generation
    let entry = cacheEntries.get(key)
    if (entry && !entry.dirty) {
      if (entry.inflight !== null) return (await entry.inflight) as T
      return entry.value as T
    }
    if (!entry) {
      entry = { value: undefined, dirty: true, inflight: null }
      cacheEntries.set(key, entry)
    }
    entry.dirty = false
    const inflight = compute()
    entry.inflight = inflight
    let value: T
    try {
      value = await inflight
    } finally {
      if (entry.inflight === inflight) entry.inflight = null
    }
    if (generation !== startGeneration) continue
    const current = cacheEntries.get(key)
    if (current && !current.dirty) {
      current.value = value
    }
    return value
  }
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


export async function getHeadForDir(cwd: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(cwd)
    if (gitDir === null) return null
    const head = await readGitHead(gitDir)
    if (head === null) return null
    if (head.type === 'detached') return head.sha
    return resolveRef(gitDir, `refs/heads/${head.name}`)
  } catch {
    return null
  }
}

export async function readWorktreeHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const content = (await readFile(join(worktreePath, '.git'), 'utf8')).trim()
    if (!content.startsWith('gitdir:')) return null
    const gitDir = resolve(worktreePath, content.slice('gitdir:'.length).trim())
    const head = await readGitHead(gitDir)
    if (head === null) return null
    if (head.type === 'detached') return head.sha
    return resolveRef(gitDir, `refs/heads/${head.name}`)
  } catch {
    return null
  }
}

export async function getRemoteUrlForDir(cwd: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(cwd)
    if (gitDir === null) return null
    const fromGitDir = await parseGitConfigValue(gitDir, 'remote', 'origin', 'url')
    if (fromGitDir !== null) return fromGitDir
    const commonDir = await getCommonDir(gitDir)
    if (commonDir !== null && commonDir !== gitDir) {
      return parseGitConfigValue(commonDir, 'remote', 'origin', 'url')
    }
    return null
  } catch {
    return null
  }
}

export async function isShallowClone(): Promise<boolean> {
  const gitDir = await resolveGitDir()
  if (gitDir === null) return false
  const commonDir = await getCommonDir(gitDir)
  try {
    await stat(join(commonDir ?? gitDir, 'shallow'))
    return true
  } catch {
    return false
  }
}

export async function getWorktreeCountFromFs(): Promise<number> {
  const gitDir = await resolveGitDir()
  if (gitDir === null) return 0
  const commonDir = (await getCommonDir(gitDir)) ?? gitDir
  try {
    const entries = await readdir(join(commonDir, 'worktrees'))
    return entries.length + 1
  } catch {
    return 1
  }
}
