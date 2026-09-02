// ============================================================================
//  daemon/saturnBoxSchedules — SATURN's small BOX-WIDE tier (fork iii, the
//  operator's YES): machine-level schedules that belong to no session —
//  BIRTH KIND ONLY. Born clean-named: no legacy spelling anywhere in this
//  tier.
//
//  BOTH PRESENCE ARMS (the ruled widening): the
//  operator's banked birth-tier sentence — headless or screen-present,
//  "all customizable" — governs this form's tier too; fork (iii)'s
//  headless-only floor was the engine lane's construction sketch, and the
//  screen-present gate was box-scoped all along (ports.screenOpen —
//  "Mercury is open on this box"). A screen-present box birth WAITS while
//  no screen is open, exactly like the session tier's arm.
//
//  THE STORE: <daemon dir>/saturn-box-schedules.json — a daemon-home file
//  {version:1, schedules:[], heldFires:[]}. Rows are SaturnScheduleV1
//  CONSTRAINED (action.kind 'birth') and carry their first-class account
//  like every schedule (the founding law); a row that fails validation is
//  SKIPPED LOUDLY at read (a log line naming the id), never silently
//  dropped from the file. The ticker reads per tick, so a writer edits the
//  file and the next tick sees it — no wire verb exists or is needed (a
//  new daemon OP verb = STOP; the file IS the door).
//
//  TWO WRITERS, ONE FILE: the ticker's pens (fire stamps, holds) and the
//  operator writers below (the scheduler form's add/remove/pause) both
//  read-modify-write this small file FROM TWO PROCESSES. Every mutation
//  holds the box lock across its read→publish (a mkdir-atomic lock beside
//  the file; bounded wait, stale-break by age, a loud break-through past
//  the bound — no caller contract changes), because the adversarial suite drove the
//  unlocked window deterministically both ways: a pen's blind whole-file
//  write ATE a concurrent operator add, and a screen write RESURRECTED a
//  spent one-shot (which then fired again — a double birth). The publish
//  itself rides durableAtomicPublishSync (the estate's one durable
//  publication primitive), so a reader sees old-complete or new-complete,
//  never torn.
//
//  Pens live HERE (the one-writer census names this module beside
//  daemon/saturn.ts as the box tier's own home): markBoxScheduleFired ·
//  holdBoxFire · takeBoxHeldFires — the same stamp-precedes-effect,
//  dedupe, and drop-the-field laws as the session tier.
// ============================================================================
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { daemonDir } from './controlSocket.js'
import {
  mintUnusedId,
  saturnNextFireMs,
  validateSaturnSubmission,
  SATURN_ID_PATTERN,
  SATURN_SCHEDULE_CAP,
  SATURN_HELD_CAP,
  type HeldFireV1,
  type SaturnScheduleV1,
  type ScheduleOpDepsV1,
  type SaturnScheduleSubmissionV1,
} from './saturn.js'

export interface SaturnBoxFileV1 {
  version: 1
  schedules: SaturnScheduleV1[]
  heldFires: HeldFireV1[]
}

export function saturnBoxSchedulesPath(dir: string = daemonDir()): string {
  return join(dir, 'saturn-box-schedules.json')
}

/** One row's box-tier validation: the general submission grammar PLUS the
 *  ruled constraints (birth · headless) and the stored stamps (id ·
 *  account · createdAt/createdBy). Returns the reason on refusal. */
export function boxScheduleProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'not an object'
  const row = raw as Record<string, unknown>
  if (row.schema !== 1) return 'schema must be 1'
  if (typeof row.id !== 'string' || !SATURN_ID_PATTERN.test(row.id)) return 'id must be eight hex characters'
  const sub = validateSaturnSubmission({ when: row.when, action: row.action, ...(row.modelKey !== undefined ? { modelKey: row.modelKey } : {}), ...(row.note !== undefined ? { note: row.note } : {}) })
  if (!sub.ok) return sub.reason
  if (sub.submission.action.kind !== 'birth') return "the box tier takes 'birth' schedules only (fork iii's ruling)"
  // Both presence arms are lawful here (the ruled widening above): a
  // screen-present box birth waits for an open screen at the ticker.
  const account = row.account as Record<string, unknown> | undefined
  if (typeof account !== 'object' || account === null) return 'the account is first-class — every box row carries one (family + source)'
  if (
    typeof account.family !== 'string' ||
    (account.source !== 'oauth' && account.source !== 'api-key' && account.source !== 'keyless')
  ) {
    return 'account must carry family + source (oauth | api-key | keyless)'
  }
  if (typeof row.createdAt !== 'number' || typeof row.createdBy !== 'string') return 'createdAt/createdBy stamps are required'
  return null
}

const HELD_REASONS = new Set(['sign-in-expired', 'signed-out', 'unreachable', 'rate-limited', 'account-mismatch', 'parked-queued', 'admission-refused'])

/** One hold row's box-tier validation — the loud-skip law covers BOTH
 *  arrays: a mangled hold row must never reach the tick (h.reason on null
 *  was a throw inside the tick's own totality). Minimal shape only: the
 *  replay guard stays the belt for envelope semantics. */
export function boxHeldFireProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'not an object'
  const row = raw as Record<string, unknown>
  if (typeof row.scheduleId !== 'string' || !SATURN_ID_PATTERN.test(row.scheduleId)) return 'scheduleId must be eight hex characters'
  if (typeof row.dueAt !== 'number' || !Number.isFinite(row.dueAt)) return 'dueAt must be a finite epoch-ms number'
  if (typeof row.reason !== 'string' || !HELD_REASONS.has(row.reason)) return 'reason is not a typed hold reason'
  if (typeof row.heldAt !== 'number' || !Number.isFinite(row.heldAt)) return 'heldAt must be a finite epoch-ms number'
  const env = row.envelope as Record<string, unknown> | undefined
  if (typeof env !== 'object' || env === null) return 'the frozen envelope is required'
  if (env.kind !== 'birth') return "a box envelope replays 'birth' only (the tier's own constraint)"
  if (typeof env.birth !== 'object' || env.birth === null) return 'a birth envelope must carry its spec'
  return null
}

/** Fail-open read with LOUD per-row refusals: a malformed row is skipped
 *  and named; the file's healthy rows stand. Missing/unreadable = empty. */
export function readBoxSchedules(dir?: string): SaturnBoxFileV1 {
  try {
    const raw = JSON.parse(readFileSync(saturnBoxSchedulesPath(dir), 'utf8')) as Partial<SaturnBoxFileV1>
    if (raw?.version !== 1) return { version: 1, schedules: [], heldFires: [] }
    const schedules: SaturnScheduleV1[] = []
    for (const row of Array.isArray(raw.schedules) ? raw.schedules : []) {
      const problem = boxScheduleProblem(row)
      if (problem === null) schedules.push(row as SaturnScheduleV1)
      else logForDebugging(`[saturn] box schedule skipped — ${String((row as { id?: unknown })?.id ?? '?')}: ${problem}`)
    }
    const heldFires: HeldFireV1[] = []
    for (const row of Array.isArray(raw.heldFires) ? raw.heldFires : []) {
      const problem = boxHeldFireProblem(row)
      if (problem === null) heldFires.push(row as HeldFireV1)
      else logForDebugging(`[saturn] box held fire skipped — ${String((row as { scheduleId?: unknown } | null)?.scheduleId ?? '?')}: ${problem}`)
    }
    return { version: 1, schedules, heldFires }
  } catch {
    return { version: 1, schedules: [], heldFires: [] }
  }
}

// ── the box lock (two processes, one file) ─────────────────────────────────

const BOX_LOCK_WAIT_MS = 500
const BOX_LOCK_STALE_MS = 10_000
const BOX_LOCK_POLL_MS = 10

export function saturnBoxLockPath(dir?: string): string {
  return `${saturnBoxSchedulesPath(dir)}.lock`
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Serialize one read-modify-write across BOTH writer processes (the
 * daemon's pens, the screen's operator writers). A directory mkdir is the
 * atomic contention signal on every platform. A crashed holder goes stale
 * by age and is broken loudly; a holder still live past the bounded wait
 * is broken loudly too — the pre-lock last-write-wins, shrunk from
 * "every overlap" to a pathological half-second hold — so no caller
 * signature changes. The hold itself is sub-millisecond (a small JSON
 * read-modify-write).
 */
function withBoxLock<T>(dir: string | undefined, body: () => T): T {
  const lock = saturnBoxLockPath(dir)
  const deadline = Date.now() + BOX_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        mkdirSync(dirname(lock), { recursive: true })
        continue
      }
      if (code !== 'EEXIST') throw e
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > BOX_LOCK_STALE_MS
      } catch {
        continue // vanished between mkdir and stat — retry at once
      }
      if (stale || Date.now() >= deadline) {
        logForDebugging(`[saturn] box lock broken ${stale ? '(stale holder)' : '(bounded wait exhausted)'} — proceeding`)
        try {
          rmdirSync(lock)
        } catch {
          /* the holder released first — the retry acquires */
        }
        continue
      }
      sleepSync(BOX_LOCK_POLL_MS)
    }
  }
  try {
    return body()
  } finally {
    try {
      rmdirSync(lock)
    } catch {
      /* broken by a contender past the bound — nothing to release */
    }
  }
}

function publishBox(file: SaturnBoxFileV1, dir?: string): void {
  const p = saturnBoxSchedulesPath(dir)
  mkdirSync(dirname(p), { recursive: true })
  durableAtomicPublishSync(p, JSON.stringify(file, null, 2))
}

/** Stamp a box fire decision — the session tier's law verbatim: a one-shot
 *  spends (row removed), a recurring stamps lastFiredAt. */
export function markBoxScheduleFired(scheduleId: string, firedAt: number, dir?: string): 'marked' | 'spent' | 'missing' {
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    const row = file.schedules.find(s => s.id === scheduleId)
    if (!row) return 'missing'
    if (row.when.kind === 'at') {
      file.schedules = file.schedules.filter(s => s.id !== scheduleId)
      publishBox(file, dir)
      return 'spent'
    }
    row.lastFiredAt = firedAt
    publishBox(file, dir)
    return 'marked'
  })
}

/** Bank a due box fire — deduped by (scheduleId, dueAt); the cap says so. */
export function holdBoxFire(held: HeldFireV1, dir?: string): 'held' | 'already-held' | 'cap' {
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    if (file.heldFires.some(h => h.scheduleId === held.scheduleId && h.dueAt === held.dueAt)) return 'already-held'
    if (file.heldFires.length >= SATURN_HELD_CAP) return 'cap'
    file.heldFires = [...file.heldFires, held]
    publishBox(file, dir)
    return 'held'
  })
}

// ── the operator-facing writers (the scheduler form's door; the file IS
//    the door — no wire verb exists or may grow) ───────────────────────────

export type BoxWriteOutcome = { ok: true; id: string } | { ok: false; reason: string }

/**
 * Add one box birth schedule — the session writer's laws re-spoken at the
 * file: the submission validates whole (birth kind only; both presence
 * arms), THE ACCOUNT derives through the injected resolver (refusal =
 * typed refusal, no write — the founding law), the daemon-shaped stamps
 * are minted HERE (id · createdAt · createdBy · the schedule-time
 * preflight when wired), and the built row must satisfy the read's own
 * validator before it is published (a writer can never plant a row the
 * loud-skip read would drop). The 51st schedule refuses (the session cap's
 * own bound).
 */
export function addBoxSchedule(
  submission: SaturnScheduleSubmissionV1 | unknown,
  by: string,
  deps: ScheduleOpDepsV1,
  dir?: string,
): BoxWriteOutcome {
  const validated = validateSaturnSubmission(submission)
  if (!validated.ok) return { ok: false, reason: `schedule refused — ${validated.reason}` }
  const sub = validated.submission
  if (sub.action.kind !== 'birth') {
    return { ok: false, reason: "schedule refused — the box tier takes 'birth' schedules only (a fire belongs to a session)" }
  }
  // The account preflights the model the birth RUNS (the founding law's
  // promise) — a divergent top-level modelKey is an authoring error.
  if (sub.modelKey !== undefined && sub.modelKey !== sub.action.birth.modelKey) {
    return { ok: false, reason: 'schedule refused — modelKey must match birth.modelKey (the account preflights the model the birth runs)' }
  }
  const modelKey = sub.action.birth.modelKey
  // Derivation and preflight may touch slow readers (keychain, snapshots)
  // — both run OUTSIDE the lock; the hold spans only read→publish.
  const derived = deps.deriveAccount(modelKey)
  if (!derived.ok) return { ok: false, reason: `schedule refused — ${derived.reason}` }
  const preflightAtWrite = deps.preflight ? deps.preflight(derived.account, saturnNextFireMs(sub.when, Date.now())) : undefined
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    if (file.schedules.length >= SATURN_SCHEDULE_CAP) {
      return { ok: false, reason: `schedule refused — the box already holds ${SATURN_SCHEDULE_CAP} schedules` }
    }
    const id = mintUnusedId(deps.mintId ?? (() => randomUUID().slice(0, 8)), file.schedules)
    if (id === null) return { ok: false, reason: 'schedule refused — could not mint an unused id' }
    const schedule: SaturnScheduleV1 = {
      schema: 1,
      id,
      when: sub.when,
      action: sub.action,
      account: derived.account,
      modelKey,
      createdAt: Date.now(),
      createdBy: by,
    }
    if (sub.effort !== undefined) schedule.effort = sub.effort
    if (sub.note !== undefined) schedule.note = sub.note
    if (preflightAtWrite !== undefined) schedule.preflightAtWrite = preflightAtWrite
    const problem = boxScheduleProblem(schedule)
    if (problem !== null) return { ok: false, reason: `schedule refused — ${problem}` }
    file.schedules = [...file.schedules, schedule]
    publishBox(file, dir)
    return { ok: true, id }
  })
}

/** Remove one box schedule by id; its banked holds leave with it (a held
 *  fire of a removed schedule must never replay). */
export function removeBoxSchedule(scheduleId: string, dir?: string): 'removed' | 'missing' {
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    if (!file.schedules.some(s => s.id === scheduleId)) return 'missing'
    file.schedules = file.schedules.filter(s => s.id !== scheduleId)
    file.heldFires = file.heldFires.filter(h => h.scheduleId !== scheduleId)
    publishBox(file, dir)
    return 'removed'
  })
}

/** Pause/resume one box schedule — the session ops' semantics at the file
 *  (already-there answers noop). */
export function setBoxSchedulePaused(scheduleId: string, paused: boolean, dir?: string): 'applied' | 'noop' | 'missing' {
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    const row = file.schedules.find(s => s.id === scheduleId)
    if (row === undefined) return 'missing'
    if ((row.paused === true) === paused) return 'noop'
    if (paused) row.paused = true
    else delete row.paused
    publishBox(file, dir)
    return 'applied'
  })
}

/** Refresh a box row's stored capture to the fire-time derivation (the
 *  SF1 ruling's follow/re-arm; a box birth's model is its own, so the
 *  modelKey never moves here). Under the lock like every mutation. */
export function refreshBoxScheduleAccount(scheduleId: string, account: SaturnScheduleV1['account'], dir?: string): void {
  withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    const row = file.schedules.find(s => s.id === scheduleId)
    if (row === undefined) return
    row.account = account
    publishBox(file, dir)
  })
}

/** Take (remove and return) box holds for replay — removal first (lose one,
 *  never double). */
export function takeBoxHeldFires(keys: Array<{ scheduleId: string; dueAt: number }>, dir?: string): HeldFireV1[] {
  if (keys.length === 0) return []
  const wanted = new Set(keys.map(k => `${k.scheduleId}@${k.dueAt}`))
  return withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    const taken: HeldFireV1[] = []
    const keep: HeldFireV1[] = []
    for (const h of file.heldFires) {
      if (wanted.has(`${h.scheduleId}@${h.dueAt}`)) taken.push(h)
      else keep.push(h)
    }
    if (taken.length === 0) return []
    file.heldFires = keep
    publishBox(file, dir)
    return taken
  })
}
