
import { resolveWatchRoot } from '../utils/watchRoot.js'
import { subscribeUiClock } from '../utils/cockpit/uiClock.js'
import { existsSync, realpathSync, watch as fsWatch, type FSWatcher as NodeFSWatcher } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { FSWatcher } from 'chokidar'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { groupCommitLane } from './groupCommit.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { durableAtomicPublish } from './durablePublish.js'
import { quarantineDamagedStore } from './storeRecovery.js'
import {
  nextRevision,
  parseRevision,
  payloadDigest,
  REVISION_KEY,
  skippedBetween,
  type StoreChange,
  type StoreChangeCause,
  type StoreReadResult,
  type StoreRevision,
} from './storeRevision.js'

export type {
  StoreChange,
  StoreChangeCause,
  StoreReadResult,
  StoreRevision,
} from './storeRevision.js'

export const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    randomize: true,
  },
  stale: 10_000,
  update: 2_000,
  onCompromised: (err: Error): void => {
    logForDebugging(`[fileStore] lock compromised: ${err.message}`, { level: 'warn' })
  },
} as const

export class StoreLockLostError extends Error {
  constructor(
    public readonly storePath: string,
    public readonly detail: string,
  ) {
    super(`[fileStore] lock ownership lost for ${storePath} (${detail}) — mutation not published`)
    this.name = 'StoreLockLostError'
  }
}

const compromisedLocks = new Set<string>()

function storeLockOptions(path: string): Record<string, unknown> {
  return {
    ...STORE_LOCK_OPTIONS,
    onCompromised: (err: Error): void => {
      compromisedLocks.add(path)
      logForDebugging(`[fileStore] lock compromised for ${path}: ${err.message}`, { level: 'warn' })
    },
  }
}

function lockArtefactPath(path: string): string {
  try {
    return `${realpathSync(path)}.lock`
  } catch {
    return `${path}.lock`
  }
}

function assertStillHeld(path: string): void {
  if (compromisedLocks.has(path)) {
    throw new StoreLockLostError(path, 'the lock was reported compromised')
  }
  if (!existsSync(lockArtefactPath(path))) {
    throw new StoreLockLostError(path, 'the lock is no longer present')
  }
}

export const VERSION_KEY = '_v'

const DEFAULT_WATCH_DEBOUNCE_MS = 25

const DEFAULT_POLL_FALLBACK_MS = 1000

const DEFAULT_POLL_FLOOR_MS = 2000

const STAT_KEY_ABSENT = 'absent'
function statKeyOf(st: { mtimeMs: number; size: number; ino: number }): string {
  return `${st.mtimeMs}:${st.size}:${st.ino}`
}

export async function publishAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await durableAtomicPublish(path, contents)
}

export type ReadFailurePolicy = 'empty' | 'throw'

export interface StoreConfig<T, A extends unknown[]> {
  name: string
  path: (...args: A) => string
  schemaVersion: number
  decode: (raw: unknown) => T | null
  encode?: (value: T) => unknown
  empty: () => T
  onReadFailure: ReadFailurePolicy
  watchDebounceMs?: number
  pollFallbackMs?: number
  pollFloorMs?: number
  revisionOf?: (value: T) => number
}

export interface StoreHandle<T> {
  readonly path: string
  read(): Promise<T>
  readResult(): Promise<StoreReadResult<T>>
  update<R>(
    fn: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>,
  ): Promise<R>
  mutate(fn: (current: T) => T | Promise<T>): Promise<void>
  write(value: T): Promise<void>
  subscribe(
    listener: (value: T) => void,
    opts?: { immediate?: boolean },
  ): () => void
  subscribeChanges(
    listener: (change: StoreChange<T>) => void,
    opts?: { immediate?: boolean },
  ): () => void
  _statsForProofs(): {
    listeners: number
    watcher: boolean
    watcherStarting: boolean
    pollTimer: boolean
    pollFloorTimer: boolean
    debounceTimer: boolean
    emissionSeq: number
    publishEpoch: number
    lastSeenRevision: number | null
    lastEmittedOpId: string | null
    lastStatKey: string | null
  }
}

type Runtime = {
  listeners: Set<(change: StoreChange<unknown>) => void>
  watcher: FSWatcher | null
  watcherStarting: Promise<void> | null
  pollTimer: ReturnType<typeof setInterval> | null
  pollLadderStop: (() => void) | null
  pollFloorStop: (() => void) | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  lastEmittedRaw: string | null
  lastStatKey: string | null
  lastSeenRevision: number | null
  lastEmittedOpId: string | null
  emissionSeq: number
  publishEpoch: number
  emitRunning: boolean
  emitDirty: boolean
  opChain: Promise<void>
}

let emitReadGateForProofs: (() => Promise<void>) | null = null
export function _setEmitReadGateForProofs(
  gate: (() => Promise<void>) | null,
): void {
  emitReadGateForProofs = gate
}


export function defineStore<T, A extends unknown[] = []>(
  cfg: StoreConfig<T, A>,
): (...args: A) => StoreHandle<T> {
  const handles = new Map<string, StoreHandle<T>>()
  const runtimes = new Map<string, Runtime>()

  const decodeRaw = (raw: string): T => {
    const parsed = jsonParse(raw) as unknown
    const value = cfg.decode(parsed)
    if (value === null) throw new Error(`[${cfg.name}] store failed validation`)
    return value
  }

  const revisionFor = (parsed: unknown, value: T): StoreRevision | null => {
    const stamped = parseRevision(parsed)
    if (stamped) return stamped
    if (cfg.revisionOf) {
      const n = cfg.revisionOf(value)
      if (Number.isFinite(n) && n > 0) {
        return {
          revision: n,
          writerId: 'derived',
          operationId: '',
          committedAt: '',
          digest: '',
        }
      }
    }
    return null
  }

  const readResultAt = async (
    path: string,
    rt: Runtime | null,
  ): Promise<{ result: StoreReadResult<T>; raw: string | null }> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (e) {
      if (getErrnoCode(e) === 'ENOENT') {
        return { result: { state: 'missing', value: cfg.empty() }, raw: null }
      }
      return {
        result: {
          state: 'recoverable',
          reason: `store unreadable: ${e}`,
          path,
          ...lastGoodOf(rt),
        },
        raw: null,
      }
    }
    try {
      const parsed = jsonParse(raw) as unknown
      const value = cfg.decode(parsed)
      if (value === null) throw new Error(`[${cfg.name}] store failed validation`)
      return {
        result: { state: 'ready', value, revision: revisionFor(parsed, value) },
        raw,
      }
    } catch (e) {
      return {
        result: {
          state: 'recoverable',
          reason: `store invalid: ${e}`,
          path,
          ...lastGoodOf(rt),
        },
        raw,
      }
    }
  }

  const lastGoodOf = (rt: Runtime | null): { lastGood?: T } => {
    if (!rt?.lastEmittedRaw) return {}
    try {
      return { lastGood: decodeRaw(rt.lastEmittedRaw) }
    } catch {
      return {}
    }
  }

  let readDegradeRecorded = false
  const applyFailure = (e: unknown, path: string): T => {
    if (cfg.onReadFailure === 'throw') throw e
    logForDebugging(
      `[${cfg.name}] store read failed, degrading to empty (declared fail-open): ${e}`,
      { level: 'warn' },
    )
    if (!readDegradeRecorded) {
      readDegradeRecorded = true
      void import('./storeRecovery.js')
        .then(m => m.recordStoreReadDegradation({ store: cfg.name, path, reason: String(e) }))
        .catch(() => {})
    }
    return cfg.empty()
  }

  const readAt = async (path: string): Promise<T> => {
    const { result } = await readResultAt(path, runtimes.get(path) ?? null)
    if (result.state === 'recoverable') {
      return applyFailure(new Error(result.reason), path)
    }
    return result.value
  }

  const encodeValue = (value: T): string => {
    const encoded = (cfg.encode ?? (v => v as unknown))(value)
    const stamped =
      encoded !== null &&
      typeof encoded === 'object' &&
      !Array.isArray(encoded)
        ? { ...(encoded as Record<string, unknown>), [VERSION_KEY]: cfg.schemaVersion }
        : encoded
    return jsonStringify(stamped, null, 2) + '\n'
  }

  const getRuntime = (path: string): Runtime => {
    let rt = runtimes.get(path)
    if (!rt) {
      rt = {
        listeners: new Set(),
        watcher: null,
        watcherStarting: null,
        pollTimer: null,
        pollLadderStop: null,
        pollFloorStop: null,
        debounceTimer: null,
        lastEmittedRaw: null,
        lastStatKey: null,
        lastSeenRevision: null,
        lastEmittedOpId: null,
        emissionSeq: 0,
        publishEpoch: 0,
        emitRunning: false,
        emitDirty: false,
        opChain: Promise.resolve(),
      }
      runtimes.set(path, rt)
    }
    return rt
  }

  const emitIfChanged = async (path: string, rt: Runtime): Promise<void> => {
    if (rt.listeners.size === 0) return
    if (rt.emitRunning) {
      rt.emitDirty = true
      return
    }
    rt.emitRunning = true
    try {
      do {
        rt.emitDirty = false
        await emitOnce(path, rt)
      } while (rt.emitDirty && rt.listeners.size > 0)
    } finally {
      rt.emitRunning = false
    }
  }

  const emitOnce = async (path: string, rt: Runtime): Promise<void> => {
    const epochAtRead = rt.publishEpoch
    let statKey: string
    try {
      statKey = statKeyOf(await stat(path))
    } catch (e) {
      statKey = getErrnoCode(e) === 'ENOENT' ? STAT_KEY_ABSENT : ''
    }
    if (statKey !== '' && statKey === rt.lastStatKey && rt.publishEpoch === epochAtRead) return
    let raw: string | null
    try {
      raw = await readFile(path, 'utf-8')
    } catch (e) {
      raw = getErrnoCode(e) === 'ENOENT' ? null : rt.lastEmittedRaw
      if (raw === rt.lastEmittedRaw && raw !== null) return
    }
    if (statKey !== '' && rt.publishEpoch === epochAtRead) rt.lastStatKey = statKey
    if (emitReadGateForProofs) await emitReadGateForProofs()
    if (rt.publishEpoch !== epochAtRead) {
      rt.emitDirty = true
      return
    }
    if (rt.listeners.size === 0) return
    if (raw === rt.lastEmittedRaw) return
    if (rt.lastEmittedRaw === null && raw !== null && raw === encodeValue(cfg.empty())) {
      rt.lastEmittedRaw = raw
      return
    }
    let value: T
    let revision: StoreRevision | null = null
    try {
      if (raw === null) {
        value = cfg.empty()
      } else {
        const parsed = jsonParse(raw) as unknown
        const decoded = cfg.decode(parsed)
        if (decoded === null) throw new Error(`[${cfg.name}] store failed validation`)
        value = decoded
        revision = revisionFor(parsed, decoded)
      }
    } catch (e) {
      logForDebugging(`[${cfg.name}] subscribe read failed, skipping emit: ${e}`)
      return
    }
    if (revision?.operationId && revision.operationId === rt.lastEmittedOpId) {
      rt.lastEmittedRaw = raw
      return
    }
    rt.lastEmittedRaw = raw
    const skipped = skippedBetween(rt.lastSeenRevision, revision)
    if (revision) rt.lastSeenRevision = revision.revision
    fanOut(rt, {
      value,
      revision,
      cause: skipped > 0 ? 'catch-up' : 'watch',
      skippedRevisions: skipped,
    })
  }

  const fanOut = (rt: Runtime, change: StoreChange<T>): void => {
    rt.emissionSeq += 1
    for (const l of rt.listeners) {
      try {
        l(change as StoreChange<unknown>)
      } catch (e) {
        logForDebugging(`[${cfg.name}] subscriber threw (ignored): ${e}`)
      }
    }
  }

  const scheduleEmit = (path: string, rt: Runtime): void => {
    if (rt.listeners.size === 0) return
    rt.lastStatKey = null
    if (rt.debounceTimer) clearTimeout(rt.debounceTimer)
    rt.debounceTimer = setTimeout(() => {
      rt.debounceTimer = null
      void emitIfChanged(path, rt)
    }, cfg.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS)
    rt.debounceTimer.unref?.()
  }

  const startWatcher = (path: string, rt: Runtime): void => {
    if (rt.watcher || rt.watcherStarting || rt.pollTimer) return
    rt.watcherStarting = (async () => {
      try {
        try {
          await stat(path)
        } catch (e) {
          if (getErrnoCode(e) === 'ENOENT') {
            startPollUntilExists(path, rt)
            return
          }
        }
        const { default: chokidar } = await import('chokidar')
        if (rt.listeners.size === 0) return
        const watcher = chokidar.watch(resolveWatchRoot(path), {
          persistent: false,
          ignoreInitial: true,
          atomic: true,
          ignorePermissionErrors: true,
        })
        watcher.on('add', () => scheduleEmit(path, rt))
        watcher.on('change', () => scheduleEmit(path, rt))
        watcher.on('unlink', () => {
          scheduleEmit(path, rt)
          void watcher.close().catch(() => {})
          if (rt.watcher === watcher) rt.watcher = null
          if (rt.pollFloorStop) {
            rt.pollFloorStop()
            rt.pollFloorStop = null
          }
          if (rt.listeners.size > 0) startPollUntilExists(path, rt)
        })
        watcher.on('error', (e: unknown) => {
          logForDebugging(`[${cfg.name}] watcher error, falling back to polling: ${e}`)
          void watcher.close().catch(() => {})
          if (rt.watcher === watcher) rt.watcher = null
          startPollFallback(path, rt)
        })
        rt.watcher = watcher
        if (rt.listeners.size === 0) {
          stopWatching(path, rt)
          return
        }
        scheduleEmit(path, rt)
        startPollFloor(path, rt)
      } catch (e) {
        logForDebugging(
          `[${cfg.name}] watch engine unavailable (${e}) — polling fallback at ${cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS}ms`,
        )
        startPollFallback(path, rt)
      } finally {
        rt.watcherStarting = null
      }
    })()
  }

  const startPollFallback = (path: string, rt: Runtime): void => {
    if (rt.pollTimer || rt.listeners.size === 0) return
    if (rt.pollFloorStop) {
      rt.pollFloorStop()
      rt.pollFloorStop = null
    }
    rt.pollTimer = setInterval(
      () => void emitIfChanged(path, rt),
      cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS,
    )
    rt.pollTimer.unref?.()
  }

  const startPollFloor = (path: string, rt: Runtime): void => {
    const floorMs = cfg.pollFloorMs ?? DEFAULT_POLL_FLOOR_MS
    if (!floorMs || floorMs <= 0) return
    if (rt.pollFloorStop || rt.listeners.size === 0) return
    rt.pollFloorStop = subscribeUiClock(floorMs, () => void emitIfChanged(path, rt))
  }

  const startPollUntilExists = (path: string, rt: Runtime): void => {
    if (rt.pollTimer || rt.listeners.size === 0) return
    let ancestor: NodeFSWatcher | null = null
    const upgrade = (): void => {
      if (rt.pollTimer) {
        clearInterval(rt.pollTimer)
        rt.pollTimer = null
      }
      stopFloor()
      try {
        ancestor?.close()
      } catch {
      }
      ancestor = null
      startWatcher(path, rt)
    }
    const probe = async (): Promise<void> => {
      await emitIfChanged(path, rt)
      if (rt.pollTimer === null) return
      if (rt.lastStatKey === STAT_KEY_ABSENT || rt.lastStatKey === null) return
      upgrade()
    }
    let dir = dirname(path)
    while (dir !== dirname(dir) && !existsSync(dir)) dir = dirname(dir)
    try {
      const w = fsWatch(resolveWatchRoot(dir), () => void probe())
      w.on('error', () => {
        try {
          w.close()
        } catch {
        }
        if (ancestor === w) ancestor = null
      })
      ancestor = w
    } catch {
    }
    const floorMs = ancestor !== null ? (cfg.pollFloorMs ?? DEFAULT_POLL_FLOOR_MS) : (cfg.pollFallbackMs ?? DEFAULT_POLL_FALLBACK_MS)
    const stopFloor = subscribeUiClock(floorMs, () => void probe())
    rt.pollTimer = setInterval(() => {}, 0x7fffffff)
    rt.pollTimer.unref?.()
    rt.pollLadderStop = () => {
      stopFloor()
      try {
        ancestor?.close()
      } catch {
      }
      ancestor = null
    }
  }

  const stopWatching = (path: string, rt: Runtime): void => {
    if (rt.watcher) {
      void rt.watcher.close().catch(() => {})
      rt.watcher = null
    }
    if (rt.pollTimer) {
      clearInterval(rt.pollTimer)
      rt.pollTimer = null
    }
    if (rt.pollLadderStop) {
      rt.pollLadderStop()
      rt.pollLadderStop = null
    }
    if (rt.pollFloorStop) {
      rt.pollFloorStop()
      rt.pollFloorStop = null
    }
    if (rt.debounceTimer) {
      clearTimeout(rt.debounceTimer)
      rt.debounceTimer = null
    }
    rt.lastEmittedRaw = null
    rt.lastStatKey = null
    rt.lastSeenRevision = null
    rt.lastEmittedOpId = null
    rt.emitDirty = false
  }

  const ensureExists = async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, encodeValue(cfg.empty()), { flag: 'wx' })
    } catch (e) {
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  }

  const makeHandle = (path: string): StoreHandle<T> => {
    const rt = getRuntime(path)

    const publish = async (
      value: T,
      prevRevision: StoreRevision | null,
      cause: StoreChangeCause = 'local-commit',
    ): Promise<void> => {
      const encoded = (cfg.encode ?? (v => v as unknown))(value)
      const isObjectShaped =
        encoded !== null && typeof encoded === 'object' && !Array.isArray(encoded)
      const revision = isObjectShaped
        ? nextRevision(prevRevision, payloadDigest(jsonStringify(encoded)))
        : null
      const stampedPayload = isObjectShaped
        ? {
            ...(encoded as Record<string, unknown>),
            [VERSION_KEY]: cfg.schemaVersion,
            ...(revision ? { [REVISION_KEY]: revision } : {}),
          }
        : encoded
      const raw = jsonStringify(stampedPayload, null, 2) + '\n'
      await publishAtomic(path, raw)
      rt.lastStatKey = null
      const emitted = revision ?? revisionFor(null, value)
      const echoed = rt.lastEmittedRaw === raw
      rt.publishEpoch += 1
      rt.lastEmittedRaw = raw
      rt.lastEmittedOpId = revision?.operationId ?? null
      if (emitted) {
        rt.lastSeenRevision = Math.max(rt.lastSeenRevision ?? 0, emitted.revision)
      }
      if (!echoed && rt.listeners.size > 0) {
        queueMicrotask(() =>
          fanOut(rt, { value, revision: emitted, cause, skippedRevisions: 0 }),
        )
      }
    }

    const lane = groupCommitLane<T, { prevRevision: StoreRevision | null; cause: StoreChangeCause }>({
      acquire: async () => {
        await ensureExists(path)
        compromisedLocks.delete(path)
        return lockfile.lock(path, storeLockOptions(path))
      },
      read: async () => {
        const { result: rr, raw } = await readResultAt(path, rt)
        if (rr.state === 'recoverable') {
          if (cfg.onReadFailure === 'throw') throw new Error(rr.reason)
          const resumedFrom = rr.lastGood !== undefined ? 'last-good' : 'empty'
          await quarantineDamagedStore({
            store: cfg.name,
            path,
            rawBytes: raw,
            reason: rr.reason,
            resumedFrom,
          })
          logForDebugging(
            `[${cfg.name}] recoverable store quarantined; mutation resumes from ${resumedFrom}`,
            { level: 'warn' },
          )
          return {
            value: rr.lastGood ?? cfg.empty(),
            context: {
              prevRevision:
                rt.lastSeenRevision !== null
                  ? {
                      revision: rt.lastSeenRevision,
                      writerId: 'recovery',
                      operationId: '',
                      committedAt: '',
                      digest: '',
                    }
                  : null,
              cause: 'recovery' as StoreChangeCause,
            },
          }
        }
        return {
          value: rr.value,
          context: {
            prevRevision: rr.state === 'ready' ? rr.revision : null,
            cause: 'local-commit' as StoreChangeCause,
          },
        }
      },
      beforePublish: () => assertStillHeld(path),
      publish: (next, ctx) => publish(next, ctx.prevRevision, ctx.cause),
    })

    const locked = <R>(fn: (current: T) => Promise<{ next: T; result: R }>): Promise<R> =>
      lane.submit(fn)

    const subscribeChanges = (
      listener: (change: StoreChange<T>) => void,
      opts?: { immediate?: boolean },
    ): (() => void) => {
      const l = listener as (change: StoreChange<unknown>) => void
      rt.listeners.add(l)
      startWatcher(path, rt)
      if (opts?.immediate !== false) {
        const seqAtSubscribe = rt.emissionSeq
        void readResultAt(path, rt)
          .then(({ result: rr }) => {
            if (!rt.listeners.has(l)) return
            if (rt.emissionSeq !== seqAtSubscribe) return
            if (rr.state === 'recoverable') return
            const revision = rr.state === 'ready' ? rr.revision : null
            if (revision && rt.lastSeenRevision === null) {
              rt.lastSeenRevision = revision.revision
            }
            listener({
              value: rr.value,
              revision,
              cause: 'catch-up',
              skippedRevisions: 0,
            })
          })
          .catch(e =>
            logForDebugging(`[${cfg.name}] immediate subscribe read failed: ${e}`),
          )
      }
      return () => {
        rt.listeners.delete(l)
        if (rt.listeners.size === 0) stopWatching(path, rt)
      }
    }

    return {
      path,
      read: () => readAt(path),
      readResult: async () => (await readResultAt(path, rt)).result,
      update: fn => locked(async cur => await fn(cur)),
      mutate: fn =>
        locked(async cur => ({ next: await fn(cur), result: undefined })),
      write: value => locked(async () => ({ next: value, result: undefined })),
      subscribe: (listener, opts) =>
        subscribeChanges(chg => listener(chg.value), opts),
      subscribeChanges,
      _statsForProofs: () => ({
        listeners: rt.listeners.size,
        watcher: rt.watcher !== null,
        watcherStarting: rt.watcherStarting !== null,
        pollTimer: rt.pollTimer !== null,
        pollFloorTimer: rt.pollFloorStop !== null,
        debounceTimer: rt.debounceTimer !== null,
        emissionSeq: rt.emissionSeq,
        publishEpoch: rt.publishEpoch,
        lastSeenRevision: rt.lastSeenRevision,
        lastEmittedOpId: rt.lastEmittedOpId,
        lastStatKey: rt.lastStatKey,
      }),
    }
  }

  return (...args: A): StoreHandle<T> => {
    const path = cfg.path(...args)
    let handle = handles.get(path)
    if (!handle) {
      handle = makeHandle(path)
      handles.set(path, handle)
    }
    return handle
  }
}
