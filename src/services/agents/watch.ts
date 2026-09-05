import chokidar, { type FSWatcher } from 'chokidar'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { existsSync, readdirSync, realpathSync, watch as fsWatch, type FSWatcher as NodeWatcher } from 'node:fs'
import * as platformPath from 'node:path'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { findGitRoot } from '../../utils/git.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { projectConfigDirs } from '../../utils/projectConfig.js'
import { createSignal } from '../../utils/signal.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'
import { subscribeUiClock } from '../../utils/cockpit/uiClock.js'

const USE_POLLING = typeof Bun !== 'undefined'

const DEFAULTS = {
  stabilityThreshold: 700,
  pollInterval: 250,
  reloadDebounce: 300,
  chokidarInterval: 2000,
  selfWriteWindowMs: 2500,
  rootProbeIntervalMs: 30_000,
}

let overrides: Partial<typeof DEFAULTS> | null = null
export function setAgentWatchTimingForTests(
  next: Partial<typeof DEFAULTS> | null,
): void {
  overrides = next
}
function timing(): typeof DEFAULTS {
  return { ...DEFAULTS, ...(overrides ?? {}) }
}

let watcher: FSWatcher | null = null
let watchedCwd: string | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let stopRootLadder: (() => void) | null = null
let missingRoots: string[] = []
let pendingHadForeignWrite = false
let unregisterCleanup: (() => void) | null = null
const agentsChanged = createSignal()

const selfWrites = new Map<string, number>()

function selfWriteKey(path: string): string {
  const resolved = platformPath.resolve(path)
  try {
    return platformPath.join(
      realpathSync(platformPath.dirname(resolved)),
      platformPath.basename(resolved),
    )
  } catch {
    return resolved
  }
}

export function noteSelfWrite(path: string): void {
  selfWrites.set(selfWriteKey(path), Date.now())
  if (selfWrites.size > 64) {
    const cutoff = Date.now() - timing().selfWriteWindowMs
    for (const [p, at] of selfWrites) {
      if (at < cutoff) selfWrites.delete(p)
    }
  }
}

function isRecentSelfWrite(path: string): boolean {
  const at = selfWrites.get(selfWriteKey(path))
  return at !== undefined && Date.now() - at < timing().selfWriteWindowMs
}

export function agentWatchRoots(cwd: string): string[] {
  const roots = new Set<string>()
  roots.add(platformPath.join(getMercuryHome(), 'agents'))
  for (const dir of getProjectDirsUpToHome('agents', cwd)) {
    roots.add(dir)
  }
  const levels = new Set<string>([cwd])
  const gitRoot = findGitRoot(cwd)
  if (gitRoot) levels.add(gitRoot)
  for (const level of levels) {
    for (const home of projectConfigDirs(level)) {
      roots.add(platformPath.join(home, 'agents'))
    }
  }
  return [...roots]
}

function scheduleEmit(): void {
  const t = timing()
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    clearAgentDefinitionsCache()
    if (pendingHadForeignWrite) {
      pendingHadForeignWrite = false
      agentsChanged.emit()
    }
  }, t.reloadDebounce)
}

function handleChange(path: string): void {
  if (!path.toLowerCase().endsWith('.md')) return
  if (!isRecentSelfWrite(path)) {
    pendingHadForeignWrite = true
  }
  scheduleEmit()
}

function probeMissingRoots(): void {
  if (!watcher || missingRoots.length === 0) return
  const still: string[] = []
  for (const root of missingRoots) {
    if (!existsSync(root)) {
      still.push(root)
      continue
    }
    watcher.add(root)
    logForDebugging(`agent watch: new root armed — ${root}`)
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
    }
    for (const name of entries) {
      if (name.toLowerCase().endsWith('.md')) {
        handleChange(platformPath.join(root, name))
      }
    }
  }
  missingRoots = still
  if (missingRoots.length === 0 && stopRootLadder) {
    stopRootLadder()
    stopRootLadder = null
  }
}

function nearestExistingAncestor(root: string): string {
  let dir = platformPath.dirname(root)
  while (dir !== platformPath.dirname(dir) && !existsSync(dir)) dir = platformPath.dirname(dir)
  return dir
}

function armMissingRootLadder(floorMs: number): void {
  if (stopRootLadder !== null) return
  const ancestors = new Map<string, NodeWatcher>()
  let alive = true
  const rearm = (): void => {
    if (!alive) return
    const wanted = new Set(missingRoots.map(nearestExistingAncestor))
    for (const [dir, w] of ancestors) {
      if (wanted.has(dir)) continue
      try {
        w.close()
      } catch {
      }
      ancestors.delete(dir)
    }
    for (const dir of wanted) {
      if (ancestors.has(dir)) continue
      try {
        const w = fsWatch(resolveWatchRoot(dir), () => {
          probeMissingRoots()
          rearm()
        })
        w.on('error', () => {
          try {
            w.close()
          } catch {
          }
          if (ancestors.get(dir) === w) ancestors.delete(dir)
        })
        ancestors.set(dir, w)
      } catch {
      }
    }
  }
  rearm()
  const stopFloor = subscribeUiClock(floorMs, () => {
    probeMissingRoots()
    rearm()
  })
  stopRootLadder = () => {
    alive = false
    stopFloor()
    for (const w of ancestors.values()) {
      try {
        w.close()
      } catch {
      }
    }
    ancestors.clear()
  }
}

export async function startAgentWatch(cwd: string): Promise<void> {
  if (watcher && watchedCwd === cwd) return
  await stopAgentWatch()
  watchedCwd = cwd
  const t = timing()
  const allRoots = agentWatchRoots(cwd)
  const roots = allRoots.filter(r => existsSync(r))
  missingRoots = allRoots.filter(r => !existsSync(r))
  logForDebugging(
    `Watching agent definition roots: ${roots.join(', ')}` +
      (missingRoots.length > 0
        ? ` (probing for: ${missingRoots.join(', ')})`
        : ''),
  )
  if (missingRoots.length > 0) armMissingRootLadder(t.rootProbeIntervalMs)
  watcher = chokidar.watch(roots.map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: {
      stabilityThreshold: t.stabilityThreshold,
      pollInterval: t.pollInterval,
    },
    ignored: (path, stats) => {
      if (stats && !stats.isFile() && !stats.isDirectory()) return true
      return path
        .split(platformPath.sep)
        .some(dir => dir === '.git' || dir === 'node_modules')
    },
    ignorePermissionErrors: true,
    usePolling: USE_POLLING,
    interval: t.chokidarInterval,
    atomic: true,
  })
  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleChange)
  watcher.on('error', err => {
    logForDebugging(
      `agent watch error (watch continues): ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  if (!unregisterCleanup) {
    unregisterCleanup = registerCleanup(async () => {
      await stopAgentWatch()
    })
  }
}

export async function stopAgentWatch(): Promise<void> {
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  if (stopRootLadder) {
    stopRootLadder()
    stopRootLadder = null
  }
  missingRoots = []
  pendingHadForeignWrite = false
  if (watcher) {
    const closing = watcher.close()
    watcher = null
    watchedCwd = null
    await closing.catch(() => {})
  }
}

export const subscribeAgentsChanged = agentsChanged.subscribe

export async function rearmAgentWatch(): Promise<void> {
  if (watchedCwd) {
    const cwd = watchedCwd
    watchedCwd = null
    await startAgentWatch(cwd)
  }
}
