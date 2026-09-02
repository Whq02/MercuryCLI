// ============================================================================
//  src/utils/config/globalConfig.ts — global-config io and cache state.
//
//  One JSON file (getGlobalMercuryFile: the legacy `.config.json` if present,
//  else `.mercury<suffix>.json` under the Mercury home) holds the global
//  monolith: top-level preferences plus the per-project records, including
//  OAuth account state. Everything that makes touching that file safe lives
//  here:
//    · the in-memory cache (write-through on our own saves, a background
//      freshness watcher for other instances' saves);
//    · the lock + re-read + merge save path, with timestamped backups;
//    · the auth-wipe guard (the one invariant this module exists to defend);
//    · migration of retired fields on read;
//    · corrupt-file quarantine and recovery messaging.
//
//  THE AUTH-WIPE GUARD. The global file is rewritten whole. If a read races
//  a concurrent writer (or lands on a truncated/corrupt file), parsing fails
//  and the read view degrades to defaults — and a save built on that view
//  would publish defaults over the operator's real config, silently logging
//  them out and re-arming onboarding. wouldLoseAuthState() is the tripwire:
//  any save whose re-read is missing auth/onboarding state that the
//  in-memory cache still holds is REFUSED, loudly, instead of written.
//  Every save path (locked and fallback) checks it before publishing.
//
//  Publishes are atomic: writeFileSyncAndFlush_DEPRECATED resolves symlinks,
//  writes a flushed temp sibling, preserves the existing file's mode, and
//  renames into place (with the bounded Windows retry) — a reader never
//  observes a half-written global config from this process. The guard above
//  exists for the writers that are NOT this process, and for kill-during-
//  rename windows on filesystems without atomic rename.
//
//  config.ts is the compatibility barrel over this family; submodules never
//  import the barrel.
// ============================================================================
import { copyFileSync, mkdirSync, unwatchFile, watchFile } from 'fs'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getGlobalMercuryFile } from '../env.js'
import { getMercuryHome } from '../envUtils.js'
import { ConfigParseError, ConfigReadError, getErrnoCode } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { safeParseJSON } from '../json.js'
import { stripBOM } from '../jsonRead.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'

import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  type GlobalConfig,
  type InstallMethod,
  type ProjectConfig,
} from './schema.js'

// Under bun test (NODE_ENV=test) the global config is a plain in-memory
// object: reads return it, saves Object.assign into it, and the disk is
// never touched — tests exercise config-consuming code without a home
// directory fixture. (autoUpdates:false keeps updater paths inert in tests.)
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}

/**
 * The auth-wipe tripwire (see the header): true when publishing `fresh`
 * would drop OAuth account state or completed-onboarding state that the
 * in-memory cache still holds. A fresh view that "lost" those fields is a
 * degraded read (corrupt/truncated file → defaults), never a legitimate
 * transition — logout clears the cache through its own write-through first.
 */
export function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

// FN-020 row 5: updates that land in the cache NOW and on disk LATER. The
// boot band's startup-counter increment is the consumer: first-render
// readers read the cache, so the increment applies there synchronously,
// while the locked, backed-up, fsync'd disk publish it used to pay in
// front of the first paint rides a launch-graph background node
// (flushDeferredGlobalConfigSaves). Every save in between FOLDS the
// pending updaters into its own write — an intermediate save can never
// publish a view that lacks them — and a landed write clears the list.
// The headless roads (-p, a concourse worker, a verb) have no launch graph: the
// deferred writer arms its own exit flush (armDeferredExitFlush below).
let pendingDeferredUpdaters: Array<(currentConfig: GlobalConfig) => GlobalConfig> = []

// The deferred road's exit seam. A headless run leaves through
// gracefulShutdown's forceExit, a verb's own process.exit, or a drained
// loop — the one seam every road crosses is the process 'exit' event, where
// a synchronous publish is legal (the cost ledger's exit write is the
// precedent) and asynchronous work is not. Armed once, at the first
// deferral; a no-op at exit when nothing is pending. A kill that skips
// 'exit' loses the pending telemetry counts — the named trade the deferred
// road already makes for a crash before the launch-graph node.
let deferredExitFlushArmed = false
function armDeferredExitFlush(): void {
  if (deferredExitFlushArmed) return
  deferredExitFlushArmed = true
  process.once('exit', () => {
    try {
      flushDeferredGlobalConfigSaves()
    } catch {
      // The exit proceeds; what was lost is telemetry.
    }
  })
}

function foldPendingUpdaters(current: GlobalConfig): GlobalConfig {
  let folded = current
  for (const pending of pendingDeferredUpdaters) folded = pending(folded)
  return folded
}

/** Apply `updater` to the in-memory config now; the disk publish waits for
 *  the next save of any kind, flushDeferredGlobalConfigSaves(), or the
 *  process exit (the armed exit flush). A same-reference return schedules
 *  nothing. */
export function saveGlobalConfigDeferred(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    saveGlobalConfig(updater)
    return
  }
  const current = getGlobalConfig()
  const next = updater(current)
  if (next === current) return
  pendingDeferredUpdaters.push(updater)
  armDeferredExitFlush()
  writeThroughGlobalConfigCache({
    ...next,
    projects: removeProjectHistory(next.projects),
  })
}

/** Publish every pending deferred update (a no-op when none is pending). */
export function flushDeferredGlobalConfigSaves(): void {
  if (pendingDeferredUpdaters.length === 0) return
  saveGlobalConfig(current => current)
}

export function hasPendingDeferredGlobalConfigSaves(): boolean {
  return pendingDeferredUpdaters.length > 0
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // Same-reference return = "no change"; skip the assign.
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalMercuryFile(),
      createDefaultGlobalConfig,
      current => {
        // Pending deferred updates ride this write (a fresh object when any
        // is pending, so the same-reference law below still means "nothing
        // to write" only when nothing at all changed).
        const config = updater(foldPendingUpdaters(current))
        // Same-reference return = "no change"; skip the write.
        if (config === current) {
          return current
        }
        written = {
          ...config,
          // History-strip the UPDATED projects — stripping `current`'s here
          // silently RESURRECTED the pre-update projects on every save, so
          // any projects mutation routed through saveGlobalConfig (the
          // setPathTrusted trust grant — its doc says exactly why it cannot
          // ride saveCurrentProjectConfig) was a dropped write. An updater
          // that leaves projects alone spreads the same reference, so this
          // is byte-identical for every other caller.
          projects: removeProjectHistory(config.projects),
        }
        return written
      },
    )
    // Write-through only when a write actually landed. When the save was
    // skipped (no change, or the auth-wipe guard refused), the file is
    // untouched and the cache still holds the good state the guard reads —
    // replacing it here would disarm the guard.
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
      pendingDeferredUpdaters = []
    }
  } catch (error) {
    // The locked re-read could not see the file (present but unreadable):
    // there is no view to merge onto, so the save is refused outright —
    // the lockless re-read below would fail the same way, and a defaults
    // view must never be published over state the read could not see.
    if (error instanceof ConfigReadError) {
      logForDebugging(
        `saveGlobalConfig: refusing the write — ${error.message}`,
        { level: 'error' },
      )
      return
    }
    // Contention that outlived the whole ladder (~2s of backoff): another
    // Mercury is mid-save and still holding the lock. REFUSE rather than
    // fall through to the unlocked whole-file rewrite — that rewrite is
    // how the holder's just-committed state (an MCP server, a trust
    // grant, model state) was silently overwritten (release-hardening
    // audit rank 42). The refused update retries naturally the next time
    // its surface saves.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOCKED') {
      noteConfigContentionRefusal('saveGlobalConfig')
      return
    }
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    noteConfigLocklessFallback()
    // Lockless fallback. This path re-reads without the lock, so it IS the
    // race window the auth-wipe guard exists for: refuse to publish a
    // degraded (defaults) view over good cached auth.
    let currentConfig: GlobalConfig
    try {
      currentConfig = getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig)
    } catch (readError) {
      if (readError instanceof ConfigReadError) {
        logForDebugging(
          `saveGlobalConfig fallback: refusing the write — ${readError.message}`,
          { level: 'error' },
        )
        return
      }
      throw readError
    }
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).',
        { level: 'error' },
      )
      return
    }
    const config = updater(foldPendingUpdaters(currentConfig))
    // Same-reference return = "no change"; skip the write.
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      // The UPDATED projects, history-stripped — the same dropped-write fix
      // as the locked branch above (this lockless fallback is the branch a
      // FRESH home always takes: proper-lockfile lstat()s the target file,
      // so a not-yet-created config file lands every first save here).
      projects: removeProjectHistory(config.projects),
    }
    saveConfig(getGlobalMercuryFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
    pendingDeferredUpdaters = []
  }
}

// The in-memory view of the global file. `mtime` is the freshness cursor the
// watcher compares against; write-throughs stamp it with Date.now() (see
// writeThroughGlobalConfigCache).
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// Session-total count of real disk writes to the global config file, surfaced
// by the dev diagnostics HUD so an anomalous write rate (a save loop hammering
// the monolith) is visible before it burns the disk or the backups.
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

// Session-total count of saves that fell through to the LOCKLESS branch
// (saveGlobalConfig / saveCurrentProjectConfig). A fresh home's first save
// takes the locked branch (the lock is taken with realpath:false), so this
// stays 0 on every fresh home; a non-zero count names a lock that could not
// be taken (another instance holding it, a lock directory it cannot create).
let configLocklessFallbackCount = 0

export function getConfigLocklessFallbackCount(): number {
  return configLocklessFallbackCount
}

// Session-total count of saves REFUSED because another instance held the
// lock past the whole backoff ladder (release-hardening audit rank 42).
// The refusal is the honesty: the old fallback rewrote the entire monolith
// from an unlocked read, overwriting whatever the lock holder had just
// committed — an MCP server added seconds earlier vanished, a trust grant
// reverted — with only the two auth fields guarded.
let configContentionRefusalCount = 0

export function getConfigContentionRefusalCount(): number {
  return configContentionRefusalCount
}

/** Recorded by every config writer that refuses on lock-ladder exhaustion
 *  (saveGlobalConfig here, writeProjectSlice in projectConfig.ts). */
export function noteConfigContentionRefusal(writer: string): void {
  configContentionRefusalCount++
  logError(
    new Error(
      `${writer}: another instance held the config lock past the whole backoff ladder; the save was refused, not written lockless (refusals this session: ${configContentionRefusalCount})`,
    ),
  )
}

/** Recorded by every config writer at the top of its lockless fallback. */
export function noteConfigLocklessFallback(): void {
  configLocklessFallbackCount += 1
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

/**
 * Migrates the retired autoUpdaterStatus field into installMethod +
 * autoUpdates on read. Old configs on disk may still carry the retired
 * spelling; the mapping is applied to the in-memory view only — the field
 * disappears from disk on the next save (pickBy drops unknown-default keys).
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // installMethod present ⇒ this config already speaks the current schema.
  if (config.installMethod !== undefined) {
    return config
  }

  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // The retired value recorded the preference but not the install shape.
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // All three arose only on global installs.
      installMethod = 'global'
      break
    case undefined:
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * Strips the retired per-project `history` field (prompt history moved to
 * history.jsonl long ago; configs written before that may still carry it).
 * Returns the input object unchanged when nothing needed stripping.
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile poll interval for spotting other instances' writes (ms).
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile polls stat on the libuv threadpool and only calls back when
// mtime moved — a stalled stat never blocks the main thread.
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalMercuryFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // This callback fires for our own saves as well — but a write-through
      // stamps cache.mtime with a Date.now() that overshoots the file's real
      // mtime, so cache.mtime > curr.mtimeMs and the re-read is skipped.
      // Bun/Node additionally fire with curr.mtimeMs=0 for a missing file
      // (initial callback or deletion) — the <= covers that too.
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // A write-through may have advanced the cache while this read was
          // in flight; never regress onto the stale snapshot watchFile saw.
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          // A mid-write torn read parses to garbage — keep the cache and let
          // the next mtime tick retry rather than degrade to a broken view.
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through: what we just published IS the current config. cache.mtime is
// stamped AFTER the write with Date.now(), deliberately overshooting the
// file's mtime so the freshness watcher's next tick skips re-reading our own
// write.
export function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
}

/** The cache's freshness stamp: the file's mtime as of the last load (a
 *  write-through stamps Date.now()); 0 before the first load. It moves
 *  exactly when another process's write has been folded in — the
 *  credential memos' cross-process signal (auth.ts invalidateOnDiskChange):
 *  a sign-in touches this estate on every platform, so a process that read
 *  "no credential" before it can tell that the answer is stale. */
export function getGlobalConfigCacheStamp(): number {
  return globalConfigCache.mtime
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // Fast path: pure memory read. After startup this always hits — our own
  // saves write through, and other instances' saves arrive via the
  // background watcher (which never blocks this path).
  if (globalConfigCache.config) {
    return globalConfigCache.config
  }

  // Slow path: the startup load. Sync io is acceptable exactly once, before
  // any UI renders. Stat BEFORE read so a write racing this load self-heals:
  // an old mtime paired with newer content makes the watcher re-read on its
  // next tick instead of trusting the race.
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalMercuryFile())
    } catch {
      // No file yet — first boot; defaults seed the cache below.
    }
    const config = migrateConfigFields(
      getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // Cache seeding failed — serve an uncached read rather than crash boot.
    return migrateConfigFields(
      getConfig(getGlobalMercuryFile(), createDefaultGlobalConfig),
    )
  }
}

export function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  const dir = dirname(file)
  const fs = getFsImplementation()
  // FsOperations' mkdirSync is recursive; ensures the home exists on first boot.
  fs.mkdirSync(dir)

  // Only non-default values are persisted — the file stays a sparse diff
  // against the defaults, and retired fields (now absent from the default
  // shape) age out on the next write.
  const filteredConfig = pickBy(
    config,
    (value: A[keyof A], key: string) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // Atomic publish (temp sibling + flushed rename); 0o600 applies when the
  // publish creates the file — the config carries account state and is
  // owner-private.
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalMercuryFile()) {
    globalConfigWriteCount++
  }
}

/**
 * The locked save path: acquire the cross-process lock, re-read, merge,
 * back up, publish. Returns true only when a write was performed; false when
 * it was skipped (merge made no change, or the auth-wipe guard refused).
 * Callers use that verdict to decide whether to write through the cache —
 * writing through after a REFUSED save would replace the good cached state
 * the guard itself depends on.
 */
/**
 * Run one read-modify-write exclusively against a config-class file, with
 * the SAME contention retries saveConfigWithLock carries (FC-011): the sync
 * lock API cannot use the library's async retries, so a held lock backs off
 * 15*2^n ms across 7 attempts before the residual throw. A NON-contention
 * lock failure (the fresh-file ENOENT class) runs the section lockless —
 * the caller's first write creates the file, exactly the saveConfigWithLock
 * fallback contract. Async section supported; the lock is held across it.
 */
export async function runExclusiveOnFileSync<T>(file: string, section: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined
  try {
    let lastContention: unknown
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        release = lockfile.lockSync(file, {
          lockfilePath: `${file}.lock`,
          realpath: false,
          onCompromised: (err: Error) => {
            logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
          },
        })
        lastContention = undefined
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') {
          // Fresh-file/non-contention class: run lockless (first write creates).
          lastContention = undefined
          break
        }
        lastContention = err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * 2 ** attempt)
      }
    }
    if (lastContention !== undefined) throw lastContention
    return await section()
  } finally {
    try {
      release?.()
    } catch {
      // A vanished lock dir at release is not the section's failure.
    }
  }
}

/** Timestamped backup of the outgoing file. Multiple backups are kept so
 *  one bad write can't destroy the only good copy; they live under
 *  <mercury-home>/backups/, not beside the config. Runs OUTSIDE the save
 *  lock (release-hardening audit rank 42) — best-effort, never blocks a
 *  save. Rate-limited: startup fires many saves within milliseconds, and
 *  without the interval check each would mint a new backup and the
 *  retention window would hold five copies of the same minute. */
function backupOutgoingConfig(file: string, fs: ReturnType<typeof getFsImplementation>): void {
  try {
    const fileBase = basename(file)
    const backupDir = getConfigBackupDir()

    try {
      fs.mkdirSync(backupDir)
    } catch (mkdirErr) {
      const mkdirCode = getErrnoCode(mkdirErr)
      if (mkdirCode !== 'EEXIST') {
        throw mkdirErr
      }
    }

    const MIN_BACKUP_INTERVAL_MS = 60_000
    const existingBackups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()
      .reverse() // epoch-ms suffixes sort lexicographically → newest first

    const mostRecentBackup = existingBackups[0]
    const mostRecentTimestamp = mostRecentBackup
      ? Number(mostRecentBackup.split('.backup.').pop())
      : 0
    const shouldCreateBackup =
      Number.isNaN(mostRecentTimestamp) ||
      Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

    if (shouldCreateBackup) {
      const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
      fs.copyFileSync(file, backupPath)
    }

    // Retention: keep the five newest, delete the rest.
    const MAX_BACKUPS = 5
    const backupsForCleanup = shouldCreateBackup
      ? fs
          .readdirStringSync(backupDir)
          .filter(f => f.startsWith(`${fileBase}.backup.`))
          .sort()
          .reverse()
      : existingBackups

    for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
      try {
        fs.unlinkSync(join(backupDir, oldBackup))
      } catch {
        // Retention cleanup is best-effort.
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to backup config: ${e}`, {
        level: 'error',
      })
    }
    // ENOENT = nothing to back up (first write). Either way the save
    // proceeds — a failed backup must not block it.
  }
}

export function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // FsOperations' mkdirSync is recursive.
  fs.mkdirSync(dir)

  // Timestamped backup of the outgoing file BEFORE the lock is taken
  // (release-hardening audit rank 42: the copy, the directory listing and
  // the retention sweep used to sit inside the locked section, lengthening
  // exactly the window that sent a waiting sibling down its ladder). The
  // copy is of the pre-publish bytes either way; the 60s rate limit keeps
  // a no-change save from minting copies.
  backupOutgoingConfig(file, fs)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    const takeLock = (): (() => void) =>
      lockfile.lockSync(file, {
        lockfilePath: lockFilePath,
        // The lock artefact is pinned to `${file}.lock`, so the library's
        // realpath step serves only as an existence check — one that refuses
        // a not-yet-created target with ENOENT and sends every FIRST save on
        // a fresh home down the lockless fallback below. Off, a fresh home's
        // first save takes this locked branch like every later one.
        realpath: false,
        onCompromised: (err: Error) => {
          // The library default throws from a setTimeout callback — an
          // unhandled crash. A stolen lock (e.g. after a long event-loop
          // stall let the stale-lock reaper claim it) is recoverable; log it.
          logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
        },
      })
    // Contention retries (FC-011): the sync lock API cannot use the
    // library's async retries, and abandoning a CONTENDED lock sent the
    // save down the lockless read-modify-write — under 16 concurrent
    // `mcp add` runs every process reported success and most writes were
    // silently lost. A held lock means another Mercury is mid-save (a few
    // ms); bounded exponential backoff (15·2^n ms, ~2s total) outlives any
    // real writer chain, while every non-contention class (the fresh-home
    // ENOENT) still falls through immediately.
    release = (() => {
      let lastContention: unknown
      for (let attempt = 0; attempt < 7; attempt++) {
        try {
          return takeLock()
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code !== 'ELOCKED') throw err
          lastContention = err
          const backoffMs = 15 * 2 ** attempt
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs)
        }
      }
      throw lastContention
    })()
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Mercury instance may be running',
      )
    }

    // Re-read under the lock so the merge applies to the latest state. If
    // the file is momentarily corrupt (kill-during-write by another
    // process), this view degrades to defaults — the guard below refuses to
    // publish that over good cached auth.
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalMercuryFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: the re-read view lost auth state the cache still holds; refusing the write (auth-wipe guard).',
        { level: 'error' },
      )
      return false
    }

    const mergedConfig = mergeFn(currentConfig)

    // Same-reference return = "no change"; skip the write.
    if (mergedConfig === currentConfig) {
      return false
    }

    // Only non-default values are persisted (see saveConfig).
    const filteredConfig = pickBy(
      mergedConfig,
      (value: A[keyof A], key: string) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // Atomic publish; 0o600 applies when the publish creates the file.
    // (The timestamped backup of the outgoing bytes was taken before the
    // lock — see backupOutgoingConfig above.)
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalMercuryFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// Config reads are refused until boot flips this on — a module that reads
// config at import time would otherwise freeze half-initialized state into
// its module scope before the file was even validated.
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // Idempotent: only the first call validates.
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  configReadingAllowed = true
  // One eager read with throwOnInvalid: a corrupt global config surfaces at
  // the boot boundary as a typed ConfigParseError (which main() turns into
  // the guided recovery exit) instead of silently degrading to defaults
  // mid-session. All configs share the one global file, so one check covers.
  getConfig(
    getGlobalMercuryFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/** Backups live under <mercury-home>/backups/, keeping the home root clean. */
/** Exported for the corrupt-config gate's reset arm — the quarantine and
 *  the timestamped backups share ONE home. */
export function getConfigBackupDir(): string {
  return join(getMercuryHome(), 'backups')
}

/**
 * Restore `file` from `backupPath` — the corrupt-config gate's one
 * non-destructive road (FN-015 rank 65): the corrupt bytes are quarantined
 * under the backup home first (recovery stays possible), then the backup's
 * bytes replace the file. Throws when the copy itself fails; a refused
 * quarantine never blocks the restore.
 */
export function restoreConfigFromBackup(file: string, backupPath: string): { quarantinePath: string | null } {
  let quarantinePath: string | null = null
  try {
    const dir = getConfigBackupDir()
    mkdirSync(dir, { recursive: true })
    quarantinePath = join(dir, `${basename(file)}.corrupted.restore-${Date.now()}`)
    copyFileSync(file, quarantinePath)
  } catch {
    quarantinePath = null
  }
  copyFileSync(backupPath, file)
  return { quarantinePath }
}

/**
 * Most recent backup for `file`: newest timestamped copy under the backup
 * dir; else (older estates) a timestamped or bare `.backup` sibling next to
 * the config file. Null when no backup exists anywhere. Exported for the
 * corrupt-config gate: up to five good copies sat under the backup home
 * while the gate offered only exit or a destructive reset and never named
 * one (FN-015 rank 65).
 */
export function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // epoch-ms suffixes sort lexicographically
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // Backup dir doesn't exist yet.
  }

  // Legacy locations: beside the config file.
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1)
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // Oldest shape: a single un-timestamped `.backup` file.
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // No legacy backup either.
    }
  } catch {
    // Unreadable dir — treat as no backup.
  }

  return null
}

// Re-entrancy latch for the corrupt-config error path: logError → analytics →
// getGlobalConfig → getConfig recurses when the file is corrupt (the sampling
// check reads feature state from the same global config). Only the outermost
// frame reports.
let insideGetConfig = false

/**
 * Read + parse one config file, overlaying the parsed values on a fresh
 * default. Failure behavior is the contract:
 *  · missing file → defaults (with a stderr pointer at the newest backup);
 *  · file present but unreadable (EACCES/EPERM/EBUSY/EIO/EISDIR…) → typed
 *    ConfigReadError on EVERY road, throwOnInvalid or not — a failed read
 *    never becomes a defaults view that a save could publish;
 *  · corrupt file + throwOnInvalid → typed ConfigParseError (the boot gate);
 *  · corrupt file otherwise → quarantine a copy, tell the operator on
 *    stderr exactly where the corrupt bytes and the newest good backup are,
 *    and serve defaults for this read. The corrupt file is left in place —
 *    recovery (restoring a backup) stays the operator's explicit action,
 *    and the save paths' auth-wipe guard keeps the degraded view from
 *    being written back.
 */
export function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // Strip a BOM before parsing — PowerShell 5.x writes one on UTF-8.
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    const errCode = getErrnoCode(error)
    // Absent: no file (ENOENT), or an ancestor that is not a directory
    // (ENOTDIR) — there is no file to have read.
    if (errCode === 'ENOENT' || errCode === 'ENOTDIR') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nMercury configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // Present but unreadable — EACCES/EPERM, a sharing violation (EBUSY)
    // while a scanner or backup holds the file, EIO, EISDIR. This is NOT
    // the absent class and NOT the corrupt class: the bytes are the
    // operator's real state, merely unseen. Serving defaults here painted a
    // returning run as a first run (onboarding again, signed out, trust
    // asked again) and, worse, seeded the cache with defaults so the
    // auth-wipe guard compared defaults against defaults and let the first
    // save publish them over the real file. Refuse on every road: the boot
    // gate turns this into a named exit; the save paths refuse the write.
    if (!(error instanceof ConfigParseError)) {
      const readError = new ConfigReadError(file, errCode ?? 'EUNKNOWN', error)
      logForDebugging(readError.message, { level: 'error' })
      throw readError
    }

    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          logError(error)
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nMercury configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // Quarantine the corrupt bytes (once per distinct content) so the
      // operator can inspect or hand-recover them later.
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // Identical corrupt content is only quarantined once — repeated reads
      // of the same broken file must not mint copies every call.
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // Unreadable quarantine copy — ignore it for the comparison.
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // Quarantine is best-effort; the recovery messaging still runs.
        }
      }

      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// Test-only export seams (the underscore names are the contract).
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
