import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { parseCronExpression, computeNextCronRun } from '../utils/cron.js'
import { detectSecrets } from '../memdir/experienceCards.js'
import { presetNameProblem } from '../services/mcp/presetStore.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { CONTRACT_TEXT_CAP } from './sessionContract.js'
import { updateConcourseWorkers } from './concourseSupervisor.js'


export interface ScheduleAccountV1 {
  family: string
  source: 'oauth' | 'api-key' | 'keyless'
  scopeDir?: string
  identity?: string
  knownExpiresAt?: number | null
  refreshable?: boolean
}

export type ScheduleAccountVerdictV1 =
  | { state: 'ready' }
  | { state: 'expiring'; expiresAt: number; beforeFire: boolean }
  | { state: 'expired' }
  | { state: 'signed-out' }
  | { state: 'unreachable' }
  | { state: 'rate-limited'; retryAt?: number }


export type SaturnWhenV1 =
  | { kind: 'at'; atMs: number; spelling?: string }
  | { kind: 'every'; cron: string; spelling?: string }

export type SaturnActionV1 =
  | { kind: 'fire'; prompt: string; onParked?: 'wake' | 'queue' }
  | { kind: 'birth'; birth: SaturnBirthSpecV1 }

export interface SaturnBirthSpecV1 {
  workspaceDir: string
  modelKey: string
  effort?: string
  contract?: { text: string } | null
  kitPreset?: string
  opening?: string
  presence: 'headless' | 'screen-present'
  title?: string
}

export interface SaturnScheduleV1 {
  schema: 1
  id: string
  when: SaturnWhenV1
  action: SaturnActionV1
  account: ScheduleAccountV1
  modelKey: string
  effort?: string
  createdAt: number
  createdBy: string
  lastFiredAt?: number
  preflightAtWrite?: ScheduleAccountVerdictV1
  paused?: true
  note?: string
}


export interface SaturnFireEnvelopeV1 {
  scheduleId: string
  kind: 'fire' | 'birth'
  dueAt: number
  prompt?: string
  onParked?: 'wake' | 'queue'
  birth?: SaturnBirthSpecV1
}

export interface HeldFireV1 {
  scheduleId: string
  dueAt: number
  reason: 'sign-in-expired' | 'signed-out' | 'unreachable' | 'rate-limited' | 'account-mismatch' | 'parked-queued' | 'admission-refused'
  envelope: SaturnFireEnvelopeV1
  heldAt: number
  mismatchIdentity?: string
}


export const SATURN_ID_PATTERN = /^[0-9a-f]{8}$/
export const SATURN_FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
export const SATURN_SCHEDULE_CAP = 50
export const SATURN_PROMPT_CAP = 20_000
export const SATURN_SPELLING_CAP = 200
export const SATURN_NOTE_CAP = 500
export const SATURN_TITLE_CAP = 200
export const SATURN_MODEL_CAP = 200
export const SATURN_PATH_CAP = 4096
export const SATURN_HELD_CAP = 200
export const SATURN_EDIT_BURST_CAP = 20


export interface SaturnScheduleSubmissionV1 {
  when: SaturnWhenV1
  action: SaturnActionV1
  modelKey?: string
  effort?: string
  note?: string
}

export type SaturnValidation =
  | { ok: true; submission: SaturnScheduleSubmissionV1 }
  | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cleanString(v: unknown, cap: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s.length === 0 || s.length > cap) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return null
  return s
}

function validateWhen(raw: unknown): { ok: true; when: SaturnWhenV1 } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'when must be an object' }
  const spelling = raw.spelling === undefined ? undefined : (cleanString(raw.spelling, SATURN_SPELLING_CAP) ?? undefined)
  if (raw.kind === 'at') {
    const atMs = raw.atMs
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || !Number.isInteger(atMs) || atMs <= 0) {
      return { ok: false, reason: 'when.atMs must be a positive epoch-ms integer' }
    }
    return { ok: true, when: { kind: 'at', atMs, ...(spelling !== undefined ? { spelling } : {}) } }
  }
  if (raw.kind === 'every') {
    const cron = typeof raw.cron === 'string' ? raw.cron.trim() : ''
    if (cron.length === 0 || parseCronExpression(cron) === null) {
      return { ok: false, reason: 'when.cron is not a valid 5-field cron expression' }
    }
    return { ok: true, when: { kind: 'every', cron, ...(spelling !== undefined ? { spelling } : {}) } }
  }
  return { ok: false, reason: "when.kind must be 'at' or 'every'" }
}

function validateBirth(raw: unknown): { ok: true; birth: SaturnBirthSpecV1 } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'birth must be an object' }
  const workspaceDir = cleanString(raw.workspaceDir, SATURN_PATH_CAP)
  if (workspaceDir === null) return { ok: false, reason: 'birth.workspaceDir must be a non-empty path' }
  const modelKey = cleanString(raw.modelKey, SATURN_MODEL_CAP)
  if (modelKey === null) return { ok: false, reason: 'birth.modelKey must be a non-empty model id' }
  if (raw.presence !== 'headless' && raw.presence !== 'screen-present') {
    return { ok: false, reason: "birth.presence must be 'headless' or 'screen-present'" }
  }
  const birth: SaturnBirthSpecV1 = { workspaceDir, modelKey, presence: raw.presence }
  if (raw.effort !== undefined) {
    const effort = cleanString(raw.effort, 40)
    if (effort === null) return { ok: false, reason: 'birth.effort is malformed' }
    birth.effort = effort
  }
  if (raw.contract !== undefined) {
    if (raw.contract === null) {
      birth.contract = null
    } else if (isRecord(raw.contract)) {
      const text = typeof raw.contract.text === 'string' ? raw.contract.text.replace(/\r\n/g, '\n').trim() : ''
      if (text.length === 0 || text.length > CONTRACT_TEXT_CAP) {
        return { ok: false, reason: 'birth.contract.text must be non-empty prose under the contract cap' }
      }
      birth.contract = { text }
    } else {
      return { ok: false, reason: 'birth.contract must be null or { text }' }
    }
  }
  if (raw.kitPreset !== undefined) {
    const name = typeof raw.kitPreset === 'string' ? raw.kitPreset : ''
    const problem = presetNameProblem(name)
    if (problem !== null) return { ok: false, reason: `birth.kitPreset ${problem}` }
    birth.kitPreset = name
  }
  if (raw.opening !== undefined) {
    const opening = cleanOpening(raw.opening)
    if (opening === null) return { ok: false, reason: 'birth.opening must be non-empty prose under the prompt cap' }
    const secretReason = saturnSecretProseRefusal('opening', opening)
    if (secretReason !== null) return { ok: false, reason: secretReason }
    birth.opening = opening
  }
  if (raw.title !== undefined) {
    const title = cleanString(raw.title, SATURN_TITLE_CAP)
    if (title === null) return { ok: false, reason: 'birth.title is malformed' }
    birth.title = title
  }
  return { ok: true, birth }
}

export function saturnSecretProseRefusal(field: 'prompt' | 'opening', text: string): string | null {
  if (detectSecrets(text).length === 0) return null
  return `the ${field} appears to contain a secret (it is persisted with the schedule and re-fed when it fires) — keep credentials in the environment or keychain, and retry without them`
}

function cleanOpening(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r\n/g, '\n').trim()
  if (s.length === 0 || s.length > SATURN_PROMPT_CAP) return null
  return s
}

function validateAction(raw: unknown): { ok: true; action: SaturnActionV1 } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'action must be an object' }
  if (raw.kind === 'fire') {
    const prompt = cleanOpening(raw.prompt)
    if (prompt === null) return { ok: false, reason: 'action.prompt must be non-empty prose under the prompt cap' }
    const secretReason = saturnSecretProseRefusal('prompt', prompt)
    if (secretReason !== null) return { ok: false, reason: secretReason }
    if (raw.onParked !== undefined && raw.onParked !== 'wake' && raw.onParked !== 'queue') {
      return { ok: false, reason: "action.onParked must be 'wake' or 'queue'" }
    }
    return {
      ok: true,
      action: { kind: 'fire', prompt, ...(raw.onParked !== undefined ? { onParked: raw.onParked as 'wake' | 'queue' } : {}) },
    }
  }
  if (raw.kind === 'birth') {
    const birth = validateBirth(raw.birth)
    if (!birth.ok) return birth
    return { ok: true, action: { kind: 'birth', birth: birth.birth } }
  }
  return { ok: false, reason: "action.kind must be 'fire' or 'birth'" }
}

export function validateSaturnSubmission(raw: unknown): SaturnValidation {
  if (!isRecord(raw)) return { ok: false, reason: 'a schedule submission must be an object' }
  const when = validateWhen(raw.when)
  if (!when.ok) return when
  const action = validateAction(raw.action)
  if (!action.ok) return action
  const submission: SaturnScheduleSubmissionV1 = { when: when.when, action: action.action }
  if (raw.modelKey !== undefined) {
    const modelKey = cleanString(raw.modelKey, SATURN_MODEL_CAP)
    if (modelKey === null) return { ok: false, reason: 'modelKey is malformed' }
    submission.modelKey = modelKey
  }
  if (raw.effort !== undefined) {
    const effort = cleanString(raw.effort, 40)
    if (effort === null) return { ok: false, reason: 'effort is malformed' }
    submission.effort = effort
  }
  if (raw.note !== undefined) {
    const note = cleanString(raw.note, SATURN_NOTE_CAP)
    if (note === null) return { ok: false, reason: 'note is malformed' }
    submission.note = note
  }
  return { ok: true, submission }
}


export function saturnNextFireMs(when: SaturnWhenV1, fromMs: number): number | null {
  if (when.kind === 'at') return when.atMs > fromMs ? when.atMs : null
  const fields = parseCronExpression(when.cron)
  if (fields === null) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}


export type ScheduleOp = 'add' | 'remove' | 'pause' | 'resume'

export interface ScheduleOpRequestV1 {
  op: ScheduleOp
  schedule?: unknown
  scheduleId?: string
}

export interface ScheduleOpDepsV1 {
  deriveAccount: (modelKey: string) => { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string }
  preflight?: (account: ScheduleAccountV1, nextFireMs: number | null) => ScheduleAccountVerdictV1
  mintId?: () => string
}

export function mintUnusedId(mint: () => string, standing: ReadonlyArray<{ id: string }>): string | null {
  for (let i = 0; i < 32; i++) {
    const id = mint()
    if (!standing.some(s => s.id === id)) return id
  }
  return null
}

export type ScheduleOpOutcome = {
  outcome: 'applied' | 'noop' | 'refused'
  detail?: string
  scheduleId?: string
}

export function applyConcourseScheduleOp(
  sessionId: string,
  req: ScheduleOpRequestV1,
  by: string,
  deps: ScheduleOpDepsV1,
  dir?: string,
): ScheduleOpOutcome {
  let out: ScheduleOpOutcome = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    switch (req.op) {
      case 'add': {
        const validated = validateSaturnSubmission(req.schedule)
        if (!validated.ok) {
          out = { outcome: 'refused', detail: `schedule refused — ${validated.reason}` }
          return
        }
        const standing = rec.schedules ?? []
        if (standing.length >= SATURN_SCHEDULE_CAP) {
          out = { outcome: 'refused', detail: `schedule refused — this session already holds ${SATURN_SCHEDULE_CAP} schedules` }
          return
        }
        const sub = validated.submission
        if (sub.action.kind === 'birth' && sub.modelKey !== undefined && sub.modelKey !== sub.action.birth.modelKey) {
          out = { outcome: 'refused', detail: 'schedule refused — modelKey must match birth.modelKey (the account preflights the model the birth runs)' }
          return
        }
        const modelKey = sub.action.kind === 'birth' ? sub.action.birth.modelKey : (sub.modelKey ?? rec.modelKey)
        const derived = deps.deriveAccount(modelKey)
        if (!derived.ok) {
          out = { outcome: 'refused', detail: `schedule refused — ${derived.reason}` }
          return
        }
        const id = mintUnusedId(deps.mintId ?? (() => randomUUID().slice(0, 8)), standing)
        if (id === null) {
          out = { outcome: 'refused', detail: 'schedule refused — could not mint an unused id' }
          return
        }
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
        const effort = sub.effort ?? rec.effort
        if (effort !== undefined) schedule.effort = effort
        if (sub.note !== undefined) schedule.note = sub.note
        if (deps.preflight) {
          schedule.preflightAtWrite = deps.preflight(derived.account, saturnNextFireMs(sub.when, Date.now()))
        }
        rec.schedules = [...standing, schedule]
        rowScheduleReceipt(rec, by, `schedule '${id}' set — ${describeWhen(sub.when)} (${sub.action.kind}) on ${derived.account.family}/${derived.account.source}`, {
          op: 'add',
          id,
          when: describeWhen(sub.when),
          kind: sub.action.kind,
          family: derived.account.family,
          source: derived.account.source,
          ...(schedule.preflightAtWrite !== undefined ? { preflight: schedule.preflightAtWrite.state } : {}),
        })
        out = { outcome: 'applied', detail: `scheduled — ${describeWhen(sub.when)}`, scheduleId: id }
        return
      }
      case 'remove': {
        const target = targetOf(rec.schedules, req.scheduleId)
        if (!target.ok) {
          out = { outcome: 'refused', detail: target.reason }
          return
        }
        const remaining = (rec.schedules ?? []).filter(s => s.id !== target.schedule.id)
        if (remaining.length === 0) {
          delete rec.schedules
        } else {
          rec.schedules = remaining
        }
        const keptHolds = (rec.heldFires ?? []).filter(h => h.scheduleId !== target.schedule.id)
        const droppedHolds = (rec.heldFires?.length ?? 0) - keptHolds.length
        if (droppedHolds > 0) {
          if (keptHolds.length === 0) delete rec.heldFires
          else rec.heldFires = keptHolds
        }
        rowScheduleReceipt(
          rec,
          by,
          `schedule '${target.schedule.id}' removed${droppedHolds > 0 ? ` (${droppedHolds} held fire${droppedHolds === 1 ? '' : 's'} dropped with it)` : ''}`,
          { op: 'remove', id: target.schedule.id, ...(droppedHolds > 0 ? { droppedHolds } : {}) },
        )
        out = { outcome: 'applied', detail: 'schedule removed', scheduleId: target.schedule.id }
        return
      }
      case 'pause': {
        const target = targetOf(rec.schedules, req.scheduleId)
        if (!target.ok) {
          out = { outcome: 'refused', detail: target.reason }
          return
        }
        if (target.schedule.paused === true) {
          out = { outcome: 'noop', detail: 'already paused', scheduleId: target.schedule.id }
          return
        }
        target.schedule.paused = true
        rowScheduleReceipt(rec, by, `schedule '${target.schedule.id}' paused`, { op: 'pause', id: target.schedule.id })
        out = { outcome: 'applied', detail: 'schedule paused', scheduleId: target.schedule.id }
        return
      }
      case 'resume': {
        const target = targetOf(rec.schedules, req.scheduleId)
        if (!target.ok) {
          out = { outcome: 'refused', detail: target.reason }
          return
        }
        if (target.schedule.paused !== true) {
          out = { outcome: 'noop', detail: 'not paused', scheduleId: target.schedule.id }
          return
        }
        delete target.schedule.paused
        rowScheduleReceipt(rec, by, `schedule '${target.schedule.id}' resumed`, { op: 'resume', id: target.schedule.id })
        out = { outcome: 'applied', detail: 'schedule resumed', scheduleId: target.schedule.id }
        return
      }
    }
  }, dir)
  return out
}

function rowScheduleReceipt(
  rec: { workspaceId: string; sessionId: string },
  by: string,
  summary: string,
  details: Record<string, unknown>,
): void {
  try {
    const home = getProjectDir(rec.workspaceId)
    mkdirSync(home, { recursive: true })
    appendSessionReceipt(home, rec.sessionId, {
      at: new Date().toISOString(),
      by,
      kind: 'schedule-set',
      summary,
      details,
    })
  } catch {
  }
}

function targetOf(
  schedules: SaturnScheduleV1[] | undefined,
  scheduleId: string | undefined,
): { ok: true; schedule: SaturnScheduleV1 } | { ok: false; reason: string } {
  if (typeof scheduleId !== 'string' || !SATURN_ID_PATTERN.test(scheduleId)) {
    return { ok: false, reason: 'schedule refused — scheduleId must be eight hex characters' }
  }
  const schedule = (schedules ?? []).find(s => s.id === scheduleId)
  if (!schedule) return { ok: false, reason: `unknown-schedule: this session holds no schedule '${scheduleId}'` }
  return { ok: true, schedule }
}


export function markSaturnFired(
  sessionId: string,
  scheduleId: string,
  firedAt: number,
  dir?: string,
): 'marked' | 'spent' | 'missing' {
  let out: 'marked' | 'spent' | 'missing' = 'missing'
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const schedule = (rec.schedules ?? []).find(s => s.id === scheduleId)
    if (!schedule) return
    if (schedule.when.kind === 'at') {
      const remaining = (rec.schedules ?? []).filter(s => s.id !== scheduleId)
      if (remaining.length === 0) delete rec.schedules
      else rec.schedules = remaining
      out = 'spent'
      return
    }
    schedule.lastFiredAt = firedAt
    out = 'marked'
  }, dir)
  return out
}

export function holdSaturnFire(sessionId: string, held: HeldFireV1, dir?: string): 'held' | 'already-held' | 'cap' | 'missing' {
  let out: 'held' | 'already-held' | 'cap' | 'missing' = 'missing'
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const standing = rec.heldFires ?? []
    if (standing.some(h => h.scheduleId === held.scheduleId && h.dueAt === held.dueAt)) {
      out = 'already-held'
      return
    }
    if (standing.length >= SATURN_HELD_CAP) {
      out = 'cap'
      return
    }
    rec.heldFires = [...standing, held]
    out = 'held'
  }, dir)
  return out
}

export function refreshSaturnScheduleAccount(
  sessionId: string,
  scheduleId: string,
  account: ScheduleAccountV1,
  modelKey?: string,
  dir?: string,
): void {
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const schedule = (rec.schedules ?? []).find(s => s.id === scheduleId)
    if (!schedule) return
    schedule.account = account
    if (modelKey !== undefined) schedule.modelKey = modelKey
  }, dir)
}

export function takeSaturnHeldFires(
  sessionId: string,
  keys: Array<{ scheduleId: string; dueAt: number }>,
  dir?: string,
): HeldFireV1[] {
  const taken: HeldFireV1[] = []
  if (keys.length === 0) return taken
  const wanted = new Set(keys.map(k => `${k.scheduleId}@${k.dueAt}`))
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec || rec.heldFires === undefined) return
    const keep: HeldFireV1[] = []
    for (const h of rec.heldFires) {
      if (wanted.has(`${h.scheduleId}@${h.dueAt}`)) taken.push(h)
      else keep.push(h)
    }
    if (taken.length === 0) return
    if (keep.length === 0) delete rec.heldFires
    else rec.heldFires = keep
  }, dir)
  return taken
}

export function rowSaturnTickReceipt(
  rec: { workspaceId: string; sessionId: string },
  by: string,
  kind: 'schedule-fire' | 'schedule-held',
  summary: string,
  details: Record<string, unknown>,
): void {
  try {
    const home = getProjectDir(rec.workspaceId)
    mkdirSync(home, { recursive: true })
    appendSessionReceipt(home, rec.sessionId, {
      at: new Date().toISOString(),
      by,
      kind,
      summary,
      details,
    })
  } catch {
  }
}


export interface SaturnFactsRowV1 {
  id: string
  when: string
  nextFireMs: number | null
  kind: 'fire' | 'birth'
  paused?: true
}

export function saturnFactsOf(
  rec: { schedules?: SaturnScheduleV1[]; heldFires?: HeldFireV1[] },
  nowMs: number,
): { schedules?: SaturnFactsRowV1[]; heldFireCount?: number } {
  const out: { schedules?: SaturnFactsRowV1[]; heldFireCount?: number } = {}
  if (Array.isArray(rec.schedules)) {
    out.schedules = rec.schedules.filter(s => saturnScheduleRowUsable(s)).map(s => ({
      id: s.id,
      when: describeWhen(s.when),
      nextFireMs: s.paused === true ? null : saturnNextFireMs(s.when, nowMs),
      kind: s.action.kind,
      ...(s.paused === true ? { paused: true as const } : {}),
    }))
  }
  if (Array.isArray(rec.heldFires)) out.heldFireCount = rec.heldFires.length
  return out
}

export function saturnScheduleRowUsable(s: unknown): s is SaturnScheduleV1 {
  if (typeof s !== 'object' || s === null) return false
  const row = s as Partial<SaturnScheduleV1>
  return (
    typeof row.id === 'string' &&
    typeof row.when === 'object' &&
    row.when !== null &&
    typeof row.action === 'object' &&
    row.action !== null &&
    typeof row.account === 'object' &&
    row.account !== null
  )
}

export function saturnHeldRowUsable(h: unknown): h is HeldFireV1 {
  if (typeof h !== 'object' || h === null) return false
  const row = h as Partial<HeldFireV1>
  return (
    typeof row.scheduleId === 'string' &&
    typeof row.dueAt === 'number' &&
    typeof row.reason === 'string' &&
    typeof row.envelope === 'object' &&
    row.envelope !== null
  )
}

export function saturnSoonestFireMs(
  rec: { schedules?: SaturnScheduleV1[] },
  nowMs: number,
): number | null {
  let next: number | null = null
  for (const row of saturnFactsOf(rec, nowMs).schedules ?? []) {
    if (row.paused === true || row.nextFireMs === null) continue
    if (next === null || row.nextFireMs < next) next = row.nextFireMs
  }
  return next
}

export function saturnWakeGlanceOf(
  records: ReadonlyArray<{ schedules?: SaturnScheduleV1[] }>,
  nowMs: number,
): { count: number; nextFireMs: number | null } {
  let count = 0
  let next: number | null = null
  for (const rec of records) {
    for (const s of rec.schedules ?? []) {
      count++
      if (s.paused === true) continue
      const n = saturnNextFireMs(s.when, Math.max(s.createdAt, s.lastFiredAt ?? 0))
      if (n !== null && (next === null || n < next)) next = n
    }
  }
  return { count, nextFireMs: next !== null && next <= nowMs ? nowMs : next }
}

export function describeWhen(when: SaturnWhenV1): string {
  if (when.spelling !== undefined) return when.spelling
  if (when.kind === 'at') return `once at ${new Date(when.atMs).toISOString()}`
  return `on '${when.cron}'`
}
