/* ============================================================================
   MNEME maintenance — the due-check that ACTUALLY RUNS.

   Consolidation cannot hang off the `mneme_observe` handler alone: a
   library whose operator stops observing would never consolidate (the age
   threshold is unreachable without a new observation), a DAEDALUS-only
   session would accumulate buffer forever, and a crashed consolidator's
   lock + consuming-* files would sit invisible for the 5-minute steal
   window.

   This module owns cheap DUE-CHECKS at two safe lifecycle points — boot
   housekeeping (delayed off first-paint) and main-thread turn end (beside
   the autoDream fire, off the input path) — plus the status/receipt surface
   the Memory Centre and doctor read. Work always flows through
   maybeConsolidate (thresholds re-checked authoritatively under the one
   lock); concurrent requests coalesce through a module single-flight and
   the lock itself. OFF ⇒ zero timers, zero reads, zero files.
   ============================================================================ */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { bufferTokens, readBuffer, readConsumingRows } from './mnemeBuffer.js'
import {
  CONSOLIDATE_AGE_MS,
  CONSOLIDATE_TOKENS,
  acquireConsolidateLock,
  listTopicDocs,
  maybeConsolidate,
  readLibraryMeta,
  releaseConsolidateLock,
} from './mnemeConsolidate.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'

export type MnemeMaintenanceTrigger = 'boot' | 'turn-end' | 'observe' | 'operator'

export interface MnemeStatus {
  enabled: boolean
  buffered: number
  /** Rows stranded in consuming-* files (crash residue or a live run). */
  pendingConsuming: number
  topicCount: number
  entryCount: number
  historyCount: number
  lastConsolidatedAt: string | null
  due: boolean
  dueReason: string | null
  running: boolean
  degraded: string[]
}

export interface MnemeMaintenanceOutcome {
  ran: boolean
  trigger: MnemeMaintenanceTrigger
  reason: string
  consolidated?: boolean
  entries?: number
  docsTouched?: string[]
  wallMs?: number
}

function pidAliveSafe(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface LockView {
  present: boolean
  holderAlive: boolean | null
  ageMs: number
}

function lockView(dir: string): LockView {
  const lock = join(dir, '.consolidate.lock')
  try {
    const st = statSync(lock)
    let holderAlive: boolean | null = null
    try {
      const pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) holderAlive = pidAliveSafe(pid)
    } catch {
      /* lock without pid */
    }
    return { present: true, holderAlive, ageMs: Date.now() - st.mtimeMs }
  } catch {
    return { present: false, holderAlive: null, ageMs: 0 }
  }
}

/** Cheap due decision — mirrors maybeConsolidate's thresholds WITHOUT
 *  consuming or locking anything. */
export function dueForMaintenance(
  dir: string = mnemeLibraryDir(),
  now: Date = new Date(),
): { due: boolean; reason: string | null } {
  if (!mnemeEnabled()) return { due: false, reason: null }
  const consuming = readConsumingRows(dir)
  if (consuming.length > 0) return { due: true, reason: `${consuming.length} row(s) stranded mid-consolidation` }
  const lock = lockView(dir)
  if (lock.present && lock.holderAlive === false) return { due: true, reason: 'stale lock held by a dead process' }
  const rows = readBuffer(dir)
  if (rows.length === 0) return { due: false, reason: null }
  if (bufferTokens(dir) >= CONSOLIDATE_TOKENS) return { due: true, reason: 'buffer over the size threshold' }
  const oldest = Date.parse(rows[0]!.ts)
  if (Number.isFinite(oldest) && now.getTime() - oldest >= CONSOLIDATE_AGE_MS) {
    return { due: true, reason: 'oldest buffered observation over the age threshold' }
  }
  return { due: false, reason: null }
}

/** The health/status projection the Memory Centre + doctor consume. */
export function mnemeStatus(dir: string = mnemeLibraryDir()): MnemeStatus {
  if (!mnemeEnabled()) {
    return { enabled: false, buffered: 0, pendingConsuming: 0, topicCount: 0, entryCount: 0, historyCount: 0, lastConsolidatedAt: null, due: false, dueReason: null, running: false, degraded: [] }
  }
  const degraded: string[] = []
  const buffered = readBuffer(dir).length
  const pendingConsuming = readConsumingRows(dir).length
  const docs = listTopicDocs(dir)
  let entryCount = 0
  let historyCount = 0
  for (const d of docs) {
    for (const s of d.sections) entryCount += s.entries.length
    historyCount += d.history.length
  }
  const lock = lockView(dir)
  const running = lock.present && lock.holderAlive !== false
  if (lock.present && lock.holderAlive === false) degraded.push('consolidation lock held by a dead process (auto-reaped at the next maintenance pass)')
  if (pendingConsuming > 0 && !running) degraded.push(`${pendingConsuming} observation(s) stranded mid-consolidation`)
  const { due, reason } = dueForMaintenance(dir)
  return {
    enabled: true,
    buffered,
    pendingConsuming,
    topicCount: docs.length,
    entryCount,
    historyCount,
    lastConsolidatedAt: readLibraryMeta(dir).lastConsolidatedAt,
    due,
    dueReason: reason,
    running,
    degraded,
  }
}

// ── receipts (the Activity surface reads these) ─────────────────────────────
const RECEIPT_RING = 50

export interface MnemeMaintenanceReceipt {
  ts: string
  trigger: MnemeMaintenanceTrigger
  ran: boolean
  reason: string
  entries?: number
  docsTouched?: string[]
  wallMs?: number
}

function receiptPath(dir: string): string {
  return join(dir, 'maintenance.jsonl')
}

export function readMaintenanceReceipts(dir: string = mnemeLibraryDir(), n = 10): MnemeMaintenanceReceipt[] {
  const p = receiptPath(dir)
  if (!existsSync(p)) return []
  const out: MnemeMaintenanceReceipt[] = []
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as MnemeMaintenanceReceipt)
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return []
  }
  return out.slice(Math.max(0, out.length - n))
}

function appendReceipt(dir: string, row: MnemeMaintenanceReceipt): void {
  try {
    const rows = readMaintenanceReceipts(dir, RECEIPT_RING - 1)
    rows.push(row)
    durableAtomicPublishSync(receiptPath(dir), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  } catch (e) {
    logForDebugging(`mneme maintenance receipt failed: ${String(e)}`)
  }
}

// ── the runner ──────────────────────────────────────────────────────────────
let inflight: Promise<MnemeMaintenanceOutcome> | null = null

/**
 * Run maintenance if due (or forced by the operator trigger). Coalesces:
 * concurrent calls share one run. File work happens here, off the callers'
 * hot paths — the schedule* entry points defer via unref'd timers.
 */
export function runDueMaintenance(
  trigger: MnemeMaintenanceTrigger,
  opts: { dir?: string; force?: boolean } = {},
): Promise<MnemeMaintenanceOutcome> {
  if (!mnemeEnabled()) return Promise.resolve({ ran: false, trigger, reason: 'mneme off' })
  if (inflight) return inflight
  const dir = opts.dir ?? mnemeLibraryDir()
  const run = (async (): Promise<MnemeMaintenanceOutcome> => {
    try {
      const t0 = performance.now()
      const { due, reason } = dueForMaintenance(dir)
      if (!due && !opts.force) return { ran: false, trigger, reason: 'not due' }
      // Dead-lock reap: with an empty buffer maybeConsolidate would return
      // before touching the lock — take-and-release explicitly (the acquire
      // path steals from a provably dead holder).
      const lock = lockView(dir)
      if (lock.present && lock.holderAlive === false) {
        if (acquireConsolidateLock(dir)) releaseConsolidateLock(dir)
      }
      const r = maybeConsolidate({ dir, force: opts.force === true })
      const wallMs = Math.round(performance.now() - t0)
      const outcome: MnemeMaintenanceOutcome = {
        ran: true,
        trigger,
        reason: reason ?? (opts.force ? 'forced' : 'due'),
        consolidated: r.consolidated,
        entries: r.entries,
        docsTouched: r.docsTouched,
        wallMs,
      }
      appendReceipt(dir, { ts: new Date().toISOString(), trigger, ran: true, reason: `${outcome.reason} → ${r.reason}`, entries: r.entries, docsTouched: r.docsTouched, wallMs })
      return outcome
    } catch (e) {
      logForDebugging(`mneme maintenance failed: ${String(e)}`)
      return { ran: false, trigger, reason: `error: ${String(e).slice(0, 120)}` }
    }
  })()
  // Single-flight clear rides the PROMISE, not the async body: the body is
  // fully synchronous, so an in-body `finally { inflight = null }` runs
  // BEFORE the assignment and the settled promise would be memoized forever
  // (every later call, any dir, got the first outcome — caught by
  // prove-topic-memory-maintenance).
  inflight = run
  void run.finally(() => {
    if (inflight === run) inflight = null
  })
  return run
}

/** Fire-and-forget scheduling for the lifecycle call sites. OFF ⇒ no timer. */
export function scheduleMnemeMaintenance(trigger: MnemeMaintenanceTrigger): void {
  if (!mnemeEnabled()) return
  const delay = trigger === 'boot' ? 3000 : 500
  setTimeout(() => {
    void runDueMaintenance(trigger)
  }, delay).unref()
}
