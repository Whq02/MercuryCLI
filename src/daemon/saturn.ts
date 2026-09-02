// ============================================================================
//  daemon/saturn — SATURN, the scheduler reborn: the session-scoped schedule
//  types, THE MULTIAUTH ACCOUNT SCHEMA, the wire validator, and the record's
//  ONE WRITER (the operator's founding law).
//
//  A schedule is a SESSION FACT: it rides the durable session record
//  additively (the contract/kit precedent — old readers unaffected), is
//  FIRED BY THE DAEMON (the always-alive thing), survives reactivation, and
//  every fire decision is receipted. There is no project-scoped task file,
//  no session-only memory store, and no legacy scheduler shape anywhere in
//  this estate — the old project-file scheduler retires whole in this lane's
//  retirement waves.
//
//  MULTIAUTH-NATIVE FROM LINE ONE (the founding law): the schedule's ACCOUNT
//  is a first-class schema fact — provider family, credential source (the
//  L26 two-door vocabulary: an OAuth sign-in via /logins, or an API key via
//  /router key), the scope identity WHO-never-a-token, and the OAuth expiry
//  KNOWN AT WRITE as provenance. Verdicts are recomputed LIVE at every
//  preflight (schedule time AND fire time) — the stored capture is the
//  "warned at schedule time" record, never the fire-time truth. A fire runs
//  on the session's OWN model+account, period: expired or rate-limited at
//  fire time is TYPED, RECEIPTED, HELD (HeldFireV1 — part of the type, not
//  an error path), never a cross-family fallback, never a silent drop.
//
//  ABSENT ≠ EMPTY (the estate's standing law): a record with NO `schedules`
//  field has none — the last remove DROPS the field whole, never a healed
//  []. `heldFires` rides the same law. No reader may heal absence.
//
//  ONE WRITER — the daemon. Every `.schedules =` / `.heldFires =` mutation
//  in the tree lives in THIS module: applyConcourseScheduleOp (reached over
//  the wire as the sessionControl action 'set-schedule') and the ticker's
//  fire-side pens (lastFiredAt, hold/release), all below. The account
//  derivation and the preflight verdict are INJECTED deps (ScheduleOpDepsV1)
//  — the daemon wires the real resolvers at its arm; provers inject
//  fixtures, so every law here pins cpu-pure.
// ============================================================================
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { parseCronExpression, computeNextCronRun } from '../utils/cron.js'
import { detectSecrets } from '../memdir/experienceCards.js'
import { presetNameProblem } from '../services/mcp/presetStore.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { CONTRACT_TEXT_CAP } from './sessionContract.js'
import { updateConcourseWorkers } from './concourseSupervisor.js'

// ── THE MULTIAUTH SCHEMA ────────────────────────────────────────────────────

/** The account a fire runs on — first-class, captured at schedule time from
 *  the session's OWN resolution (never a wire-supplied claim), re-verified
 *  at fire time. Carries identity facts only: never a token, never a key. */
export interface ScheduleAccountV1 {
  /** Provider family (the route law's word: 'anthropic', 'openai', …). */
  family: string
  /** The credential door (L26): an OAuth sign-in or an API key — or the
   *  ACCOUNT-LESS arm, 'keyless': a discovered auth-free server (the local
   *  family) with nothing to sign into and nothing to expire; its fire-time
   *  fact is reachability, never a credential. */
  source: 'oauth' | 'api-key' | 'keyless'
  /** OAuth only: the scope-ring directory key of the signed-in account —
   *  so a held-fire sentence can say WHOSE sign-in expired. */
  scopeDir?: string
  /** OAuth only: the identity label at capture (the scope's snapshot
   *  email — provenance for the held sentence; live verification is the
   *  /accounts board's, never re-probed here). */
  identity?: string
  /** OAuth only: the access-token expiry KNOWN AT WRITE (epoch ms; null =
   *  the credential names none). Provenance for "warned at schedule time" —
   *  every preflight recomputes from the live credential. */
  knownExpiresAt?: number | null
  /** OAuth only: a refresh token existed at write. An expiry WITH a refresh
   *  token is refreshable — 'ready', not stranded (auth's own predicate). */
  refreshable?: boolean
}

/** One preflight verdict — computed at schedule time (stored as provenance)
 *  AND at fire time (the fire/hold decision), by ONE function both times
 *  (the preflight owner wires it in). 'expiring' = a KNOWN expiry lands
 *  before the fire with no refresh token to spend — the schedule-time WARN.
 *  'unreachable' is the keyless arm's own not-ready: the backing server is
 *  gone (a sign-in word would borrow a family this account never had). */
export type ScheduleAccountVerdictV1 =
  | { state: 'ready' }
  | { state: 'expiring'; expiresAt: number; beforeFire: boolean }
  | { state: 'expired' }
  | { state: 'signed-out' }
  | { state: 'unreachable' }
  | { state: 'rate-limited'; retryAt?: number }

// ── the schedule ────────────────────────────────────────────────────────────

/** When a schedule fires. The COMPILED form is the 5-field cron expression
 *  (the industry's format word — not the old estate's name); `spelling` is
 *  the operator's own phrase, stored verbatim for display and echoed on
 *  every surface (the recurrence grammar — fork v — compiles spellings to
 *  these two kinds; the raw cron door stays). */
export type SaturnWhenV1 =
  | { kind: 'at'; atMs: number; spelling?: string }
  | { kind: 'every'; cron: string; spelling?: string }

/** What a fire does. 'fire' delivers the prompt into the session's own
 *  queue; `onParked` is the per-schedule parked-session choice (fork i —
 *  the DEFAULT when absent is the operator's ruling; the field is the
 *  per-schedule override either way). 'birth' births a fresh session from
 *  the spec below. */
export type SaturnActionV1 =
  | { kind: 'fire'; prompt: string; onParked?: 'wake' | 'queue' }
  | { kind: 'birth'; birth: SaturnBirthSpecV1 }

/** The birth tier's engine half: everything a schedule-born session is born
 *  with, per schedule. Consumed at fire time by the in-process admit road
 *  (kitPreset resolves at the admit — the closed-roster refusal is the
 *  admit's; the validator here checks the NAME's shape only, because the
 *  saved roster can change between schedule time and fire time). */
export interface SaturnBirthSpecV1 {
  workspaceDir: string
  modelKey: string
  effort?: string
  /** Pre-answered at the door: null = no-contract; text = the advisory
   *  contract set at admission through the landed contract machinery. */
  contract?: { text: string } | null
  /** The extensions it is born wearing (a saved preset's name). */
  kitPreset?: string
  /** BORN-WORKING: the opening mission, delivered as the first turn.
   *  Absent = BORN-WAITING (the session appears and waits). */
  opening?: string
  /** HEADLESS = the unattended run (fires whenever the daemon lives;
   *  receipts + transcript are the record). SCREEN-PRESENT = fires only
   *  while Mercury is open on this box. */
  presence: 'headless' | 'screen-present'
  title?: string
}

/** One schedule — a session fact on the durable record. */
export interface SaturnScheduleV1 {
  schema: 1
  /** Eight lowercase hex characters (a UUID's first eight) — the id the
   *  operator sees. */
  id: string
  when: SaturnWhenV1
  action: SaturnActionV1
  /** THE ACCOUNT (the founding law) — daemon-derived at add time. */
  account: ScheduleAccountV1
  /** The model the fire runs on — the session's own at capture. */
  modelKey: string
  effort?: string
  createdAt: number
  /** The sessionControl `by` grammar ('operator:…', 'model:<sessionId>'). */
  createdBy: string
  /** Epoch ms of the most recent fire decision that RAN (the ticker's pen). */
  lastFiredAt?: number
  /** The schedule-time preflight verdict, stored as provenance ("warned at
   *  schedule time"). ABSENT = not computed — never read as 'ready'. */
  preflightAtWrite?: ScheduleAccountVerdictV1
  /** A paused schedule never fires and never holds; resume clears it. */
  paused?: true
  note?: string
}

// ── the held fire ───────────────────────────────────────────────────────────

/** The frozen replay envelope of one due fire — minted at the moment the
 *  hold is taken, replayed WHOLE when the hold lifts (the held-op envelope
 *  pattern: a later edit of the schedule never rewrites an already-held
 *  fire). The session identity is the record's own — held fires live ON the
 *  record. */
export interface SaturnFireEnvelopeV1 {
  scheduleId: string
  kind: 'fire' | 'birth'
  dueAt: number
  /** kind 'fire': the prompt exactly as it would have fired. */
  prompt?: string
  onParked?: 'wake' | 'queue'
  /** kind 'birth': the birth spec exactly as it would have admitted. */
  birth?: SaturnBirthSpecV1
}

/** A fire that could not run when due — TYPED, held on the record,
 *  receipted, painted ("held: sign-in expired — /logins releases N held
 *  fires"), replayed whole on release. Part of the type, not an error path
 *  (the founding law). The account reasons are the founding law's
 *  (sign-in-expired · signed-out · rate-limited · account-mismatch);
 *  'unreachable' is the keyless arm's — the backing server is gone, never a
 *  sign-in word; 'parked-queued' is fork (i)'s 'queue' arm — the fire waits
 *  for the session's own next wake; 'admission-refused' is a birth the
 *  admission door refused (the door's own typed sentence rides the
 *  receipt), retried by the ticker until it lands. */
export interface HeldFireV1 {
  scheduleId: string
  dueAt: number
  reason: 'sign-in-expired' | 'signed-out' | 'unreachable' | 'rate-limited' | 'account-mismatch' | 'parked-queued' | 'admission-refused'
  envelope: SaturnFireEnvelopeV1
  heldAt: number
  /** 'account-mismatch' only: the LIVE identity label at mint time — the
   *  fresh-sign-in comparator (the SF1 ruling's "/logins … releases on the
   *  current one": an identity that MOVED since the mint is a fresh
   *  operator decision; the release re-arms the capture on it). Additive —
   *  older readers ignore it; the envelope replays without it. */
  mismatchIdentity?: string
}

// ── grammars and caps ───────────────────────────────────────────────────────

export const SATURN_ID_PATTERN = /^[0-9a-f]{8}$/
/** Provider-family word (the route law's ids are lowercase words). */
export const SATURN_FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
/** Per-session schedule count — a hostile frame must never grow a boundless
 *  record. */
export const SATURN_SCHEDULE_CAP = 50
/** Prompts and openings are prose (the contract-cap class). */
export const SATURN_PROMPT_CAP = 20_000
export const SATURN_SPELLING_CAP = 200
export const SATURN_NOTE_CAP = 500
export const SATURN_TITLE_CAP = 200
export const SATURN_MODEL_CAP = 200
export const SATURN_PATH_CAP = 4096
/** Held fires per record (the ticker's enforcement; declared beside the
 *  siblings so every bound has one home). */
export const SATURN_HELD_CAP = 200
/** Schedule edits one facts answer may carry — THE seat clip's bound, and
 *  the bridge's latch cap folds to it (back-pressure at the source: the
 *  submit past this refuses typed where the model hears it, so an edit
 *  the bridge accepted is never dropped by the seat). The runner-side
 *  bridge spells the same number literally to keep its module graph
 *  light; prove-saturn-adversarial §M1 pins the two equal. */
export const SATURN_EDIT_BURST_CAP = 20

// ── the wire submission and its validator ───────────────────────────────────

/** What a caller SUBMITS for 'add' — the daemon stamps the rest: id,
 *  createdAt/createdBy, THE ACCOUNT (derived from the session's own
 *  resolution — never trusted from the wire), and the schedule-time
 *  preflight. A submission carrying stray sibling fields (an `account`, a
 *  `preflightAtWrite`, an `id`) has them DROPPED — the daemon's stamps are
 *  not wire-writable. */
export interface SaturnScheduleSubmissionV1 {
  when: SaturnWhenV1
  action: SaturnActionV1
  /** Absent = the session record's own modelKey/effort at add time. */
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

/** The persisting-prose secrecy guard — ONE home, every persisting door
 *  inherits (this validator guards the wire set-schedule door, the box add
 *  door, and the box read-back; the model-door tools consume the same
 *  spelling for their early refusal). A prompt/opening lands on a
 *  plain-text record and is re-fed when it fires — credential material
 *  never persists at rest, regardless of who typed it. null = clean; else
 *  the typed refusal, never echoing the bytes, naming the lawful roads. */
export function saturnSecretProseRefusal(field: 'prompt' | 'opening', text: string): string | null {
  if (detectSecrets(text).length === 0) return null
  return `the ${field} appears to contain a secret (it is persisted with the schedule and re-fed when it fires) — keep credentials in the environment or keychain, and retry without them`
}

/** Prose fields keep interior newlines (a prompt is not a name). */
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

/** The wire's narrowing: field-by-field rebuild; unknown siblings dropped;
 *  malformed refuses typed with a plain reason. Never throws. */
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

// ── next-fire math ──────────────────────────────────────────────────────────

/** Next fire in epoch ms from `fromMs`, or null (a spent one-shot, an
 *  expression with no future match). Total over validated `when` shapes;
 *  an unparseable cron (impossible past the validator) answers null rather
 *  than throwing. No jitter: a session-scoped schedule is one operator's,
 *  not a fleet's — exact instants are the honest display. */
export function saturnNextFireMs(when: SaturnWhenV1, fromMs: number): number | null {
  if (when.kind === 'at') return when.atMs > fromMs ? when.atMs : null
  const fields = parseCronExpression(when.cron)
  if (fields === null) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}

// ── the one writer ──────────────────────────────────────────────────────────

export type ScheduleOp = 'add' | 'remove' | 'pause' | 'resume'

/** The wire's payload for the sessionControl action 'set-schedule'. */
export interface ScheduleOpRequestV1 {
  op: ScheduleOp
  /** add: the submission (validated here; refuses typed). */
  schedule?: unknown
  /** remove/pause/resume: the target schedule id. */
  scheduleId?: string
}

/** The daemon-side resolvers the writer consumes — INJECTED (the daemon
 *  arm wires the real ones; provers inject fixtures). The account derivation
 *  is REQUIRED: a schedule cannot be stored without its first-class account
 *  (the founding law) — derivation failure refuses the add, typed. The
 *  preflight is optional machinery: absent ⇒ `preflightAtWrite` stays
 *  absent (absent ≠ 'ready'). */
export interface ScheduleOpDepsV1 {
  deriveAccount: (modelKey: string) => { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string }
  preflight?: (account: ScheduleAccountV1, nextFireMs: number | null) => ScheduleAccountVerdictV1
  /** The id mint (default: a UUID's first eight hex). Injectable so the
   *  collision guard is provable — the writers re-mint while the id is
   *  already standing (32 bits collide for real across a long-lived
   *  record, and a collided id makes remove/dedupe hit BOTH rows). */
  mintId?: () => string
}

/** Mint an id no standing row wears — bounded so a stuck injected mint
 *  refuses instead of spinning (unreachable with the real mint). ONE home
 *  for both tiers' guard (the box writer imports it). */
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
  /** add: the minted id; remove/pause/resume: the target id. */
  scheduleId?: string
}

/**
 * THE ONE VERB's four ops, adjudicated at the record's one writer.
 *   add    — validate the submission, default model/effort from the session
 *            record's own, DERIVE the account (refusal = typed refusal, no
 *            write), stamp id/createdAt/createdBy (+ the schedule-time
 *            preflight when wired), and append. The 51st schedule refuses.
 *   remove — drop by id; removing the last schedule drops the FIELD whole
 *            (absent = none, never a healed []).
 *   pause  — a standing schedule stops firing; already-paused answers noop.
 *   resume — clears the pause; a running schedule answers noop.
 *  Unknown session / unknown id refuse typed. The receipt row rides the
 *  wire arm (S2) — this writer is the store's law alone.
 */
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
        // A birth runs birth.modelKey — THE ACCOUNT must preflight the
        // model the fire actually runs on (the founding law's promise), so
        // the derivation key for a birth is the birth's own; a divergent
        // top-level modelKey is an authoring error, refused typed.
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
          // ABSENT ≠ EMPTY: the last remove drops the field whole.
          delete rec.schedules
        } else {
          rec.schedules = remaining
        }
        // Its banked holds leave with it (the box writer's own law): a held
        // fire of a removed schedule must never replay — and must never
        // linger as doorless debt in heldFireCount either.
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

/** The receipt row for an APPLIED schedule op — fail-soft (the row is the
 *  honesty valve, the write is the law; a failed append never refuses the
 *  op). Kind 'schedule-set' covers the whole set-schedule verb; the fire
 *  and hold rows are the ticker's own kinds. */
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
    // fail-soft by law
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

// ── the ticker's pens ───────────────────────────────────────────────────────
//  The fire engine COMPUTES (saturnTicker.ts); every record mutation it
//  needs comes through THESE pens, so the one-writer census stays whole:
//  each `.schedules =` / `.heldFires =` in the tree lives in this module.

/** Stamp one fire decision. A recurring schedule stamps lastFiredAt; a
 *  one-shot is SPENT — removed, the last removal dropping the field whole.
 *  'missing' = the schedule left the record between due and stamp. */
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

/** Hold one due fire on the record — typed, deduped by (scheduleId, dueAt)
 *  so a replayed tick never doubles a hold; the cap answers 'cap' and the
 *  ticker says so out loud (never a silent drop). */
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

/** Refresh a schedule's stored capture to the FIRE-TIME derivation (the
 *  SF1 ruling's family-follow: the fire ran the session's own current
 *  account — the capture is provenance and follows it; a fire-kind row
 *  also refreshes its modelKey to the model that actually served). A pen —
 *  the one-writer law keeps every schedule mutation in this module. */
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

/** Take (remove and return) the held fires the ticker is about to replay —
 *  removal FIRST so a replay crash can lose a fire but never double it;
 *  the last removal drops the field whole. */
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

/** The ticker's receipt pen — same fail-soft law as rowScheduleReceipt,
 *  with the fire/hold kinds. */
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
    // fail-soft by law
  }
}

// ── the facts projection ────────────────────────────────────────────────────

/** One schedule row on the session_facts wire — the SCREEN's read (the
 *  concourse "next fire" line and the scheduler form's roster). Display
 *  facts only; the record's rows stay the truth. */
export interface SaturnFactsRowV1 {
  id: string
  /** describeWhen's words (the operator's spelling verbatim when stored). */
  when: string
  nextFireMs: number | null
  kind: 'fire' | 'birth'
  paused?: true
}

/** The additive facts half: ABSENT when the record holds no schedules /
 *  holds (absent ≠ empty rides the wire too — an older screen ignores the
 *  fields entirely). */
export function saturnFactsOf(
  rec: { schedules?: SaturnScheduleV1[]; heldFires?: HeldFireV1[] },
  nowMs: number,
): { schedules?: SaturnFactsRowV1[]; heldFireCount?: number } {
  const out: { schedules?: SaturnFactsRowV1[]; heldFireCount?: number } = {}
  // TOTAL over a hand-mangled record: a non-array field projects as absent
  // (this is a pure display projection — the ticker's guards speak the
  // loud line; a throw here took the seat's whole facts compose down).
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

/** The minimal shape the projection and the ticker dereference — a mangled
 *  row (record surgery, a torn merge) is SKIPPED rather than a throw that
 *  takes the seat compose or the whole tick down. One guard, both readers. */
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

/** The hold rows the release loop dereferences — same skip-not-throw law. */
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

/** One record's soonest standing fire from `nowMs` (paused rows never
 *  count; null = nothing ahead) — the concourse row's "next fire" fact,
 *  read through the projection (the scheduler screen's smallest honest read). */
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

/** The rail's wake-glance summary: how many schedules stand across the
 *  live records, and the soonest next fire (paused rows never count a
 *  fire). Pure over the records handed in. */
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

/** One plain-words line for receipts and answers. */
export function describeWhen(when: SaturnWhenV1): string {
  if (when.spelling !== undefined) return when.spelling
  if (when.kind === 'at') return `once at ${new Date(when.atMs).toISOString()}`
  return `on '${when.cron}'`
}
