// ============================================================================
//  watch — the ONE live-reload owner for agent definition roots.
//
// Laws (brief):
//    · every ACTIVE definition root is watched (user agents dir + the project
//      walk dirs), plus the WOULD-BE native roots at the cwd/git-root levels
//      even when absent — creating a scope's first `agents` directory becomes
//      watched without a restart (chokidar watches not-yet-existing paths);
//    · events are debounced and coalesced into one reload signal;
//    · SELF-writes (the transactional store announces every commit through
//      noteSelfWrite) invalidate caches but do not re-notify — the acting
//      surface already refreshed, a second notification would double-fire;
//    · errors are visible (logForDebugging) and the watcher survives them;
//    · consumers subscribe; the signal carries no payload — the truth is a
//      fresh getAgentDefinitionsWithOverrides read after cache invalidation.
//
//  Same chokidar posture as skillChangeDetector: stat-polling under Bun
//  (fs.watch deadlock, oven-sh/bun#27469), fs events in the node runtime.
// ============================================================================
import chokidar, { type FSWatcher } from 'chokidar'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import * as platformPath from 'node:path'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { findGitRoot } from '../../utils/git.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { projectConfigDirs } from '../../utils/projectConfig.js'
import { createSignal } from '../../utils/signal.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'

const USE_POLLING = typeof Bun !== 'undefined'

const DEFAULTS = {
  stabilityThreshold: 700,
  pollInterval: 250,
  reloadDebounce: 300,
  chokidarInterval: 2000,
  selfWriteWindowMs: 2500,
  /** How often the would-be roots (not-yet-existing agents dirs) are probed
   *  so a scope's FIRST directory arms without a restart. */
  rootProbeIntervalMs: 2000,
}

let overrides: Partial<typeof DEFAULTS> | null = null
/** Test seam: shrink the timing constants for observed-ready provers. */
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
let rootProbeTimer: ReturnType<typeof setInterval> | null = null
let missingRoots: string[] = []
let pendingHadForeignWrite = false
let unregisterCleanup: (() => void) | null = null
const agentsChanged = createSignal()

/** Recent self-writes (path → committed-at ms). The store notes every commit
 *  (save, delete-unlink, restore) so the watcher can tell an echo of our own
 *  transaction from an external edit. */
const selfWrites = new Map<string, number>()

/** The ring's ONE path fold — realpath BOTH sides (AGENTVERIFY A6): a raw
 *  resolve() leaves symlink spellings apart (macOS /var vs /private/var,
 *  /tmp), so a note and its event could name the same file in two spellings
 *  and the echo re-notified. The DIRECTORY is realpathed (it exists on the
 *  write AND the unlink side; the leaf may already be gone) with the
 *  resolved spelling as the fallback. */
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

/** The roots to watch for `cwd`: every existing discovery dir, plus the
 *  would-be native roots at the cwd and git-root levels so a first
 *  `agents/` directory arms without restart. */
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
    // Either way the caches are stale — the next read must re-scan
    // (clearAgentDefinitionsCache clears the markdown-scan memo too).
    clearAgentDefinitionsCache()
    if (pendingHadForeignWrite) {
      pendingHadForeignWrite = false
      agentsChanged.emit()
    }
  }, t.reloadDebounce)
}

function handleChange(path: string): void {
  // Case-folded like discovery (FC-112): an Upper.MD agent must reload too.
  if (!path.toLowerCase().endsWith('.md')) return
  if (!isRecentSelfWrite(path)) {
    pendingHadForeignWrite = true
  }
  scheduleEmit()
}

/** Arm a root that appeared AFTER the watch started (a scope's first agents
 *  directory). Chokidar cannot watch a path whose parent chain does not
 *  exist yet, so a cheap stat probe promotes would-be roots as they appear;
 *  files already inside the fresh root are classified against the self-write
 *  ring exactly like live events. */
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
      // race: created then removed — probe again next tick
    }
    for (const name of entries) {
      if (name.toLowerCase().endsWith('.md')) {
        handleChange(platformPath.join(root, name))
      }
    }
    // The directory APPEARING is itself a change even when empty of files a
    // self-write explains — but only foreign FILE content should notify, so
    // an empty new dir stays quiet.
  }
  missingRoots = still
  if (missingRoots.length === 0 && rootProbeTimer) {
    clearInterval(rootProbeTimer)
    rootProbeTimer = null
  }
}

/** Start (or restart, on a cwd change) the agent-root watcher. Idempotent. */
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
  if (missingRoots.length > 0) {
    rootProbeTimer = setInterval(probeMissingRoots, t.rootProbeIntervalMs)
    // Never hold the process open for the probe alone.
    rootProbeTimer.unref?.()
  }
  // Long-path law (watchRoot.ts): 8.3-form roots kill libuv fs-event.
  watcher = chokidar.watch(roots.map(resolveWatchRoot), {
    persistent: true,
    ignoreInitial: true,
    depth: 4, // agents/ scans recursively; keep nested folders covered
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
  if (rootProbeTimer) {
    clearInterval(rootProbeTimer)
    rootProbeTimer = null
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

/** Subscribe to coalesced foreign-change notifications. */
export const subscribeAgentsChanged = agentsChanged.subscribe

/** After the store creates a NEW directory (first native agents dir), re-arm
 *  so the new root is covered going forward. Chokidar already covers the
 *  would-be roots at cwd/git-root levels; this covers freshly appearing
 *  NESTED roots discovered on the next walk. */
export async function rearmAgentWatch(): Promise<void> {
  if (watchedCwd) {
    const cwd = watchedCwd
    watchedCwd = null // force restart
    await startAgentWatch(cwd)
  }
}
