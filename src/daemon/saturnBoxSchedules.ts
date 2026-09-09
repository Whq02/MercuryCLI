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

export function boxScheduleProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'not an object'
  const row = raw as Record<string, unknown>
  if (row.schema !== 1) return 'schema must be 1'
  if (typeof row.id !== 'string' || !SATURN_ID_PATTERN.test(row.id)) return 'id must be eight hex characters'
  const sub = validateSaturnSubmission({ when: row.when, action: row.action, ...(row.modelKey !== undefined ? { modelKey: row.modelKey } : {}), ...(row.note !== undefined ? { note: row.note } : {}) })
  if (!sub.ok) return sub.reason
  if (sub.submission.action.kind !== 'birth') return "the box tier takes 'birth' schedules only"
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


const BOX_LOCK_WAIT_MS = 500
const BOX_LOCK_STALE_MS = 10_000
const BOX_LOCK_POLL_MS = 10

export function saturnBoxLockPath(dir?: string): string {
  return `${saturnBoxSchedulesPath(dir)}.lock`
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

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
        continue
      }
      if (stale || Date.now() >= deadline) {
        logForDebugging(`[saturn] box lock broken ${stale ? '(stale holder)' : '(bounded wait exhausted)'} — proceeding`)
        try {
          rmdirSync(lock)
        } catch {
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
    }
  }
}

function publishBox(file: SaturnBoxFileV1, dir?: string): void {
  const p = saturnBoxSchedulesPath(dir)
  mkdirSync(dirname(p), { recursive: true })
  durableAtomicPublishSync(p, JSON.stringify(file, null, 2))
}

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


export type BoxWriteOutcome = { ok: true; id: string } | { ok: false; reason: string }

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
  if (sub.modelKey !== undefined && sub.modelKey !== sub.action.birth.modelKey) {
    return { ok: false, reason: 'schedule refused — modelKey must match birth.modelKey (the account preflights the model the birth runs)' }
  }
  const modelKey = sub.action.birth.modelKey
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

export function refreshBoxScheduleAccount(scheduleId: string, account: SaturnScheduleV1['account'], dir?: string): void {
  withBoxLock(dir, () => {
    const file = readBoxSchedules(dir)
    const row = file.schedules.find(s => s.id === scheduleId)
    if (row === undefined) return
    row.account = account
    publishBox(file, dir)
  })
}

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
