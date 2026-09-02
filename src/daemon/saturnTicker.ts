// ============================================================================
//  daemon/saturnTicker — SATURN's FIRE ENGINE: the daemon-resident tick that
//  fires session schedules, holds what cannot lawfully run, and replays
//  every hold WHOLE when its block lifts. Session-scoped by construction:
//  the roster it walks IS the live session records; there is no task file.
//
//  THE DECISION LADDER, per due schedule (every arm receipted — a fire
//  decision is never silent):
//   1. the kill switch (MERCURY_SATURN_DISABLE) ends the tick before any
//      effect;
//   2. a SCREEN-PRESENT birth waits while Mercury is closed on this box —
//      that is its contract, not a miss (it fires under the normal
//      window rules once a screen is open);
//   3. THE FIRE-TIME PREFLIGHT (the founding law): THE ONE VERDICT function
//      over live credential facts — not ready ⇒ a TYPED HeldFireV1 on the
//      record + the 'schedule-held' receipt ("held: sign-in expired —
//      /logins releases N held fires"); NEVER a cross-family fallback,
//      never a silent drop. An 'expiring' verdict whose expiry has already
//      passed holds as sign-in-expired; one still in the future fires (the
//      call lands before the expiry).
//   4. fork (iv), operator-confirmed: a due fire inside the catch-up window
//      runs late ('fired-late', lateMs receipted); beyond the window it
//      rows 'missed-expired' — a one-shot is spent, a recurring re-arms
//      forward from now. The window is MERCURY_DAEMON_CATCHUP's (the
//      landed missed-policy semantics, re-homed here).
//   5. fork (i), operator-ruled: a fire into a PARKED session obeys the
//      schedule's own onParked — 'wake' (THE DEFAULT) reactivates through
//      the one resume door then delivers; 'queue' holds 'parked-queued'
//      and replays at the session's own next wake.
//   6. the stamp precedes the effect (markSaturnFired first): a crash
//      between stamp and effect LOSES one fire, never doubles it — the
//      daemon estate's standing polarity.
//
//  Effects run through INJECTED PORTS (the daemon wires the real dispatch/
//  reactivate/admission roads; provers inject fixtures and drive tickOnce
//  synchronously — cpu-pure, zero spawns). Every record mutation goes
//  through saturn.ts's pens: the one-writer census holds.
// ============================================================================
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import type { ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import {
  describeWhen,
  holdSaturnFire,
  markSaturnFired,
  refreshSaturnScheduleAccount,
  rowSaturnTickReceipt,
  saturnHeldRowUsable,
  saturnNextFireMs,
  saturnScheduleRowUsable,
  takeSaturnHeldFires,
  type HeldFireV1,
  type SaturnBirthSpecV1,
  type SaturnFireEnvelopeV1,
  type SaturnScheduleV1,
  type ScheduleAccountV1,
} from './saturn.js'
import { scheduleAccountVerdict, type LiveAccountFactsV1 } from './saturnAccount.js'
import {
  freshLoopFireChainState,
  resolveLoopFireForWorkspace,
  type LoopFireChainStateV1,
} from '../services/loopFire.js'
import {
  holdBoxFire,
  markBoxScheduleFired,
  readBoxSchedules,
  refreshBoxScheduleAccount,
  takeBoxHeldFires,
} from './saturnBoxSchedules.js'

// ── the catch-up window (fork iv; the landed missed-policy semantics) ──────

export const DEFAULT_SATURN_CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000

/** MERCURY_DAEMON_CATCHUP ('0' disables — every late fire expires, recorded);
 *  MERCURY_DAEMON_CATCHUP_MINUTES overrides the six-hour default. The same
 *  registered rows the old missed policy read — semantics carried whole. */
export function saturnCatchupWindowMs(): number {
  if (!flagEnabled('MERCURY_DAEMON_CATCHUP')) return 0
  const raw = flagEnv('MERCURY_DAEMON_CATCHUP_MINUTES')
  const n = parseInt(raw ?? '', 10)
  if (Number.isFinite(n) && n > 0) return n * 60 * 1000
  return DEFAULT_SATURN_CATCHUP_WINDOW_MS
}

/** The engine kill switch: truthy stops ALL Saturn fires — running effects
 *  settle, nothing new fires; the schedule store is untouched. */
export function isSaturnDisabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))
}

// ── the ports ───────────────────────────────────────────────────────────────

export interface SaturnDeliveryV1 {
  sessionId: string
  workspaceId: string
  prompt: string
  by: string
  /** A deterministic owner-scoped id (saturn-<sessionId>-<scheduleId>-
   *  <dueAt>) — the dispatch ledger's idempotency makes a replayed fire
   *  instance land ONCE across daemon restarts, and the owner keeps two
   *  sessions' colliding (scheduleId, dueAt) pairs apart. */
  clientMessageId: string
  /** The target is parked: the production port rides the dispatch road's
   *  resumeSessionId arm (the ONE resume door — reactivate + deliver in
   *  one idempotent call); live targets ride targetSessionId. */
  parked: boolean
}

export interface SaturnTickerPortsV1 {
  now(): number
  /** The LIVE session records (endedAt undefined) — the ticker's roster. */
  records(): ConcourseWorkerRecordV1[]
  /** The fire-time credential facts (saturnAccount's assembly in
   *  production; fixtures in provers). */
  liveFacts(account: ScheduleAccountV1): LiveAccountFactsV1
  /** THE FIRE-TIME DERIVATION (the SF1 ruling, option b): the account that
   *  will actually SERVE the fire, derived from the model the fire runs —
   *  the session's CURRENT model for fire-kind schedules, the birth's own
   *  pinned model for births (M8's law). Production wires
   *  deriveScheduleAccountForModel; provers inject fixtures. */
  deriveAccount(modelKey: string): { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string; code?: 'unreachable' }
  /** Deliver a fire into its session — the daemon's own dispatch door
   *  (durable ledger, valve-honest, idempotent by clientMessageId; the
   *  parked arm wakes through the same door's resume road — fork (i)'s
   *  'wake'). */
  deliver(d: SaturnDeliveryV1): Promise<{ ok: boolean; detail?: string }>
  /** Birth a session from a schedule's spec (S5 wires the admission road).
   *  A refusal carries the door's own typed sentence. `owner` scopes the
   *  dispatch idempotency key (the ledger is daemon-wide): the authoring
   *  session's id, or 'box' for the box tier. */
  birth(spec: SaturnBirthSpecV1, opts: { scheduleId: string; dueAt: number; by: string; owner: string }): Promise<{ ok: boolean; sessionId?: string; detail?: string }>
  /** "Mercury is open on this box" — the screen-present gate. */
  screenOpen(): boolean
  /** The daemon record dir (proofs pin scratch; absent ⇒ the daemon home). */
  dir?: string
}

// ── due math ────────────────────────────────────────────────────────────────

/** The one due computation: the next fire STRICTLY AFTER the schedule's own
 *  anchor (a recurring schedule re-arms from its last fire; a one-shot's
 *  anchor is its creation). Null = nothing owed (spent, paused, or no
 *  future match from the anchor). */
export function saturnDueAtOf(schedule: SaturnScheduleV1): number | null {
  if (schedule.paused === true) return null
  if (schedule.when.kind === 'at') {
    return schedule.lastFiredAt === undefined ? schedule.when.atMs : null
  }
  const anchor = Math.max(schedule.createdAt, schedule.lastFiredAt ?? 0)
  return saturnNextFireMs(schedule.when, anchor)
}

function envelopeOf(schedule: SaturnScheduleV1, dueAt: number): SaturnFireEnvelopeV1 {
  if (schedule.action.kind === 'fire') {
    return {
      scheduleId: schedule.id,
      kind: 'fire',
      dueAt,
      prompt: schedule.action.prompt,
      ...(schedule.action.onParked !== undefined ? { onParked: schedule.action.onParked } : {}),
    }
  }
  return { scheduleId: schedule.id, kind: 'birth', dueAt, birth: schedule.action.birth }
}

function heldReasonOf(state: 'expired' | 'signed-out' | 'unreachable' | 'rate-limited'): HeldFireV1['reason'] {
  return state === 'expired' ? 'sign-in-expired' : state
}

/** THE FIRE-TIME ACCOUNT (the SF1 ruling, option b — the founding law's
 *  own clauses settle it: ONE verdict schedule-time ∧ fire-time, and a
 *  fire runs on THE SESSION'S OWN model+account). A fire-kind schedule
 *  delivers into its session and runs the session's CURRENT model — the
 *  derivation follows it; a family move is the session's own truth, never
 *  a cross-family fallback. A birth runs ITS OWN pinned model (M8's law)
 *  — session switches never touch the ask. The stored capture stays
 *  provenance; a follow refreshes it after the fire lands. */
type FireTimeAccountV1 =
  | { kind: 'account'; account: ScheduleAccountV1; movedFromFamily?: string; identityMismatch?: true; fireModelKey: string }
  | { kind: 'no-credential'; reason: string; code?: 'unreachable'; fireModelKey: string }

/** The WHO label an identity comparison speaks (only an oauth capture
 *  carries one — api-key validity is the wire's to say, and a keyless
 *  account has no identity at all; neither door mints a mismatch on its
 *  own). */
function identityLabelOf(a: ScheduleAccountV1): string | undefined {
  return a.source === 'oauth' ? (a.identity ?? a.scopeDir) : undefined
}

/** SAME family, DIFFERENT identity = the operator switched accounts within
 *  a family (the SF1 ruling's 'account-mismatch' minting case). Only a
 *  PROVABLE difference mints — both sides carrying the comparable fact
 *  (absent ≠ different); a source flip within the family IS a switch. */
function identityMismatchOf(captured: ScheduleAccountV1, current: ScheduleAccountV1): boolean {
  if (captured.family !== current.family) return false
  if (captured.source !== current.source) return true
  if (captured.source === 'oauth') {
    if (captured.identity !== undefined && current.identity !== undefined) return captured.identity !== current.identity
    if (captured.scopeDir !== undefined && current.scopeDir !== undefined) return captured.scopeDir !== current.scopeDir
  }
  return false
}

function resolveFireTimeAccount(
  ports: SaturnTickerPortsV1,
  schedule: SaturnScheduleV1,
  sessionModelKey: string | undefined,
): FireTimeAccountV1 {
  const fireModelKey =
    schedule.action.kind === 'birth' || sessionModelKey === undefined ? schedule.modelKey : sessionModelKey
  const derived = ports.deriveAccount(fireModelKey)
  if (!derived.ok) {
    return { kind: 'no-credential', reason: derived.reason, ...(derived.code !== undefined ? { code: derived.code } : {}), fireModelKey }
  }
  return {
    kind: 'account',
    account: derived.account,
    ...(derived.account.family !== schedule.account.family ? { movedFromFamily: schedule.account.family } : {}),
    ...(identityMismatchOf(schedule.account, derived.account) ? { identityMismatch: true as const } : {}),
    fireModelKey,
  }
}

/** A record is PARKED for fork (i)'s purposes when the operator closed it
 *  (parkedAt) or stopped it (stoppedAt) — its runner is dead by intent. */
function isParkedRecord(rec: ConcourseWorkerRecordV1): boolean {
  return rec.parkedAt !== undefined || rec.stoppedAt !== undefined
}

const heldLine = (reason: HeldFireV1['reason'], n: number, family?: string): string =>
  reason === 'account-mismatch'
    ? `held: account-mismatch — this schedule was made under a different ${family ?? 'provider'} account; /logins or run-now releases on the current one`
    : reason === 'sign-in-expired'
    ? `held: sign-in expired — /logins releases ${n} held fire${n === 1 ? '' : 's'}`
    : reason === 'signed-out'
      ? `held: signed out — /logins releases ${n} held fire${n === 1 ? '' : 's'}`
      : reason === 'unreachable'
        ? `held: no local server answering — start it (or set MERCURY_LOCAL_BASE_URL); ${n} held fire${n === 1 ? '' : 's'} release when it returns`
        : reason === 'rate-limited'
        ? `held: rate-limited — the window's end releases ${n} held fire${n === 1 ? '' : 's'}`
        : reason === 'parked-queued'
          ? "held for the session's next wake (the schedule's queue arm)"
          : reason === 'admission-refused'
            ? 'held: the admission door refused — retried each tick'
            : 'held'

// ── one tick ────────────────────────────────────────────────────────────────

export interface SaturnTickReportV1 {
  fired: number
  held: number
  missed: number
  replayed: number
}

/**
 * One pass over every live record: replay lifted holds first (their fires
 * are the oldest debt), then adjudicate every due schedule. Total: never
 * throws; every decision is receipted on the session it belongs to.
 */
export async function tickSaturnOnce(ports: SaturnTickerPortsV1): Promise<SaturnTickReportV1> {
  const report: SaturnTickReportV1 = { fired: 0, held: 0, missed: 0, replayed: 0 }
  if (isSaturnDisabled()) return report
  const now = ports.now()
  const windowMs = saturnCatchupWindowMs()

  for (const rec of ports.records()) {
    const sessionId = rec.sessionId
    const parked = isParkedRecord(rec)

    // TOTAL over a hand-mangled record (the loud-skip law, session side):
    // a non-array field or a junk row is skipped and named — one bad
    // record must never throw the whole tick away (its healthy rows and
    // every OTHER session still fire).
    const heldList = Array.isArray(rec.heldFires) ? rec.heldFires.filter(saturnHeldRowUsable) : []
    const scheduleList = Array.isArray(rec.schedules) ? rec.schedules.filter(saturnScheduleRowUsable) : []
    const mangledCount =
      (Array.isArray(rec.heldFires) ? rec.heldFires.length - heldList.length : rec.heldFires !== undefined ? 1 : 0) +
      (Array.isArray(rec.schedules) ? rec.schedules.length - scheduleList.length : rec.schedules !== undefined ? 1 : 0)
    if (mangledCount > 0) {
      logForDebugging(`[saturn] session ${sessionId}: ${mangledCount} mangled schedule/hold entr${mangledCount === 1 ? 'y' : 'ies'} skipped (record surgery?) — healthy rows proceed`)
    }

    // ── replay standing holds whose block lifted ──
    if (heldList.length > 0) {
      const releasable: Array<{ scheduleId: string; dueAt: number }> = []
      const refreshOnRelease = new Map<string, { account: ScheduleAccountV1; modelKey?: string }>()
      for (const h of heldList) {
        if (h.reason === 'parked-queued') {
          if (!parked) releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
          continue
        }
        if (h.reason === 'admission-refused') {
          releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
          continue
        }
        // The account holds: re-preflight with the schedule's own account.
        // A hold without its schedule row cannot arise through the doors
        // (the writer drops a removed schedule's holds with it, and a held
        // schedule is settled business at the due ladder) — this arm is
        // the belt for direct record surgery: such a hold stands
        // untouched, visible in heldFireCount, never replayed blind.
        const schedule = scheduleList.find(s => s.id === h.scheduleId)
        if (schedule === undefined) continue
        // The release bar is the fire bar (SF1 ruling b): ready on the
        // account that will actually SERVE the replay — and never a silent
        // account jump: an identity mismatched against the capture blocks
        // an ordinary hold, and a mismatch hold releases on its two roads
        // (the capture matches again, or a FRESH sign-in decision — the
        // identity moved since the mint, re-arming the capture on it).
        const resolvedHold = resolveFireTimeAccount(ports, schedule, rec.modelKey)
        if (resolvedHold.kind === 'no-credential') continue
        const verdict = scheduleAccountVerdict({ account: resolvedHold.account, nextFireMs: now, nowMs: now, live: ports.liveFacts(resolvedHold.account) })
        if (verdict.state !== 'ready') continue
        if (h.reason === 'account-mismatch') {
          if (resolvedHold.identityMismatch !== true) {
            releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
          } else if (identityLabelOf(resolvedHold.account) !== h.mismatchIdentity) {
            releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
            refreshOnRelease.set(`${h.scheduleId}@${h.dueAt}`, {
              account: resolvedHold.account,
              ...(schedule.action.kind === 'fire' ? { modelKey: resolvedHold.fireModelKey } : {}),
            })
          }
          continue
        }
        if (resolvedHold.identityMismatch === true) continue
        releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
      }
      if (releasable.length > 0) {
        const taken = takeSaturnHeldFires(sessionId, releasable, ports.dir)
        for (const h of taken) {
          const by = `saturn:${h.scheduleId}`
          const rearm = refreshOnRelease.get(`${h.scheduleId}@${h.dueAt}`)
          if (rearm !== undefined) {
            // The fresh-sign-in road re-arms the capture on the CURRENT
            // identity before the debt replays (the ruled sentence's
            // "releases on the current one").
            refreshSaturnScheduleAccount(sessionId, h.scheduleId, rearm.account, rearm.modelKey, ports.dir)
          }
          const outcome = await replayEnvelope(ports, rec, h.envelope, parked, by)
          if (outcome.ok) {
            report.replayed++
            markSaturnFired(sessionId, h.scheduleId, now, ports.dir)
            rowSaturnTickReceipt(rec, by, 'schedule-fire', `fired late — held since ${new Date(h.heldAt).toISOString()} (${h.reason})`, {
              outcome: 'fired-late',
              scheduleId: h.scheduleId,
              dueAt: h.dueAt,
              heldMs: now - h.heldAt,
              releasedFrom: h.reason,
            })
          } else {
            // The block did not truly lift — re-hold the same envelope
            // (deduped) so the debt is never silently dropped.
            holdSaturnFire(sessionId, { ...h, heldAt: h.heldAt }, ports.dir)
            report.held++
          }
        }
      }
    }

    // ── adjudicate due schedules ──
    // A schedule that had a hold at tick start is SETTLED BUSINESS here:
    // its due occurrence lives in the banked envelope, and the release
    // loop above is that debt's only door (replayed when the block lifts —
    // however old, which is the honest late fire). Adjudicating it again
    // off this stale roster snapshot (the pens write fresh reads) would
    // double-fire a just-replayed occurrence — the admit door carries no
    // idempotency, so a doubled birth is TWO live sessions — row
    // missed-expired beside a standing hold, or spend a one-shot out from
    // under its own banked fire, orphaning the hold forever.
    const heldAtTickStart = new Set(heldList.map(h => h.scheduleId))
    // The held-line's honest count: the roster snapshot is stale (the pens
    // write fresh reads), so "/logins releases N held fires" tallies the
    // snapshot's holds plus every hold THIS tick minted on this record.
    let heldNowCount = heldList.length
    for (const schedule of scheduleList) {
      if (heldAtTickStart.has(schedule.id)) continue
      const dueAt = saturnDueAtOf(schedule)
      if (dueAt === null || dueAt > now) continue
      const by = `saturn:${schedule.id}`
      const lateMs = now - dueAt

      // Screen-present births wait while no screen is open — the contract.
      if (schedule.action.kind === 'birth' && schedule.action.birth.presence === 'screen-present' && !ports.screenOpen()) {
        continue
      }

      // Fork (iv): beyond the catch-up window = missed, recorded, never run.
      if (lateMs > windowMs) {
        const marked = markSaturnFired(sessionId, schedule.id, now, ports.dir)
        report.missed++
        rowSaturnTickReceipt(rec, by, 'schedule-fire', `missed — ~${Math.round(lateMs / 60000)}m late, beyond the ${Math.round(windowMs / 60000)}m catch-up window; not fired${marked === 'spent' ? ' (one-shot spent)' : ' (re-armed forward)'}`, {
          outcome: 'missed-expired',
          scheduleId: schedule.id,
          dueAt,
          lateMs,
          windowMs,
        })
        continue
      }

      // THE FIRE-TIME PREFLIGHT (the founding law; the SF1 ruling b): the
      // verdict judges the account that will actually SERVE the fire.
      const resolved = resolveFireTimeAccount(ports, schedule, rec.modelKey)
      if (resolved.kind === 'no-credential') {
        // Nothing serves the model the fire runs — a credential family's
        // miss is the signed-out class; the account-less family's miss is
        // its own 'unreachable' (the derivation's typed code says which).
        const missReason = resolved.code === 'unreachable' ? ('unreachable' as const) : ('signed-out' as const)
        const held = holdSaturnFire(sessionId, { scheduleId: schedule.id, dueAt, reason: missReason, envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          heldNowCount++
          rowSaturnTickReceipt(rec, by, 'schedule-held', heldLine(missReason, heldNowCount), {
            reason: missReason,
            scheduleId: schedule.id,
            dueAt,
            family: schedule.account.family,
            source: schedule.account.source,
            derivationRefusal: resolved.reason,
          })
        }
        continue
      }
      const fireAccount = resolved.account
      if (resolved.identityMismatch === true) {
        // SAME family, DIFFERENT identity — scheduled spend never silently
        // jumps accounts (the SF1 ruling's minting case for the enum).
        const held = holdSaturnFire(
          sessionId,
          {
            scheduleId: schedule.id,
            dueAt,
            reason: 'account-mismatch',
            envelope: envelopeOf(schedule, dueAt),
            heldAt: now,
            ...(identityLabelOf(fireAccount) !== undefined ? { mismatchIdentity: identityLabelOf(fireAccount) } : {}),
          },
          ports.dir,
        )
        if (held === 'held') {
          report.held++
          heldNowCount++
          rowSaturnTickReceipt(rec, by, 'schedule-held', heldLine('account-mismatch', heldNowCount, fireAccount.family), {
            reason: 'account-mismatch',
            scheduleId: schedule.id,
            dueAt,
            family: fireAccount.family,
            ...(identityLabelOf(schedule.account) !== undefined ? { capturedIdentity: identityLabelOf(schedule.account) } : {}),
            ...(identityLabelOf(fireAccount) !== undefined ? { liveIdentity: identityLabelOf(fireAccount) } : {}),
          })
        }
        continue
      }
      const verdict = scheduleAccountVerdict({ account: fireAccount, nextFireMs: dueAt, nowMs: now, live: ports.liveFacts(fireAccount) })
      const holdState =
        verdict.state === 'signed-out' || verdict.state === 'unreachable' || verdict.state === 'expired' || verdict.state === 'rate-limited'
          ? verdict.state
          : verdict.state === 'expiring' && verdict.expiresAt <= now
            ? ('expired' as const)
            : null
      if (holdState !== null) {
        const reason = heldReasonOf(holdState)
        const held = holdSaturnFire(sessionId, { scheduleId: schedule.id, dueAt, reason, envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          heldNowCount++
          const n = heldNowCount
          rowSaturnTickReceipt(rec, by, 'schedule-held', heldLine(reason, n), {
            reason,
            scheduleId: schedule.id,
            dueAt,
            family: fireAccount.family,
            source: fireAccount.source,
            ...(verdict.state === 'rate-limited' && verdict.retryAt !== undefined ? { retryAt: verdict.retryAt } : {}),
          })
        } else if (held === 'cap') {
          rowSaturnTickReceipt(rec, by, 'schedule-held', `held-fire cap reached — the due fire of '${schedule.id}' could not be banked (release held fires first)`, {
            reason,
            scheduleId: schedule.id,
            dueAt,
            cap: true,
          })
        }
        continue
      }

      // Fork (i): a parked target obeys the schedule's own onParked (default wake).
      if (schedule.action.kind === 'fire' && parked && (schedule.action.onParked ?? 'wake') === 'queue') {
        const held = holdSaturnFire(sessionId, { scheduleId: schedule.id, dueAt, reason: 'parked-queued', envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          heldNowCount++
          rowSaturnTickReceipt(rec, by, 'schedule-held', heldLine('parked-queued', 1), {
            reason: 'parked-queued',
            scheduleId: schedule.id,
            dueAt,
          })
        }
        continue
      }

      // THE STAMP PRECEDES THE EFFECT (lose one, never double).
      const marked = markSaturnFired(sessionId, schedule.id, now, ports.dir)
      if (marked === 'missing') continue
      const effect = await replayEnvelope(ports, rec, envelopeOf(schedule, dueAt), parked, by)
      if (effect.ok) {
        report.fired++
        // The SF1 family-follow: the receipt NAMES the move, and the
        // stored capture refreshes to the fire-time derivation (a fire-kind
        // row's modelKey follows the model that actually served).
        const movedClause =
          resolved.movedFromFamily !== undefined
            ? ` — fired on ${fireAccount.family}: the session's model moved after scheduling (was ${resolved.movedFromFamily})`
            : ''
        if (resolved.movedFromFamily !== undefined && marked === 'marked') {
          refreshSaturnScheduleAccount(
            sessionId,
            schedule.id,
            fireAccount,
            schedule.action.kind === 'fire' ? resolved.fireModelKey : undefined,
            ports.dir,
          )
        }
        rowSaturnTickReceipt(rec, by, 'schedule-fire', (lateMs > 60_000 ? `fired ~${Math.round(lateMs / 60000)}m late (${describeWhen(schedule.when)})` : `fired (${describeWhen(schedule.when)})`) + movedClause, {
          outcome: lateMs > 60_000 ? 'fired-late' : 'fired',
          scheduleId: schedule.id,
          dueAt,
          lateMs,
          kind: schedule.action.kind,
          ...(resolved.movedFromFamily !== undefined ? { firedOnFamily: fireAccount.family, movedFromFamily: resolved.movedFromFamily } : {}),
          ...(effect.sessionId !== undefined ? { bornSessionId: effect.sessionId } : {}),
        })
      } else if (schedule.action.kind === 'birth') {
        // The admission refused a birth whose stamp already landed: bank the
        // envelope so the birth is retried, loudly, never silently dropped.
        const held = holdSaturnFire(sessionId, { scheduleId: schedule.id, dueAt, reason: 'admission-refused', envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          rowSaturnTickReceipt(rec, by, 'schedule-held', `held: the admission refused — ${effect.detail ?? 'no detail'}`, {
            reason: 'admission-refused',
            scheduleId: schedule.id,
            dueAt,
            detail: effect.detail ?? null,
          })
        }
      } else {
        rowSaturnTickReceipt(rec, by, 'schedule-fire', `fire failed — ${effect.detail ?? 'no detail'}`, {
          outcome: 'failed',
          scheduleId: schedule.id,
          dueAt,
          detail: effect.detail ?? null,
        })
      }
    }
  }

  // ── THE BOX-WIDE TIER (fork iii — birth/headless only, born clean-named).
  // Machine-level schedules from the daemon-home file: the same ladder
  // (window → preflight → stamp → birth port → bank on refusal), decisions
  // spoken in the daemon log and the file's own held rows (a landed birth
  // gets the born session's receipt as every birth does; the operator-
  // facing writer for this file is the screen's seam).
  {
    const box = readBoxSchedules(ports.dir)
    if (box.heldFires.length > 0) {
      const releasable: Array<{ scheduleId: string; dueAt: number }> = []
      const boxRefreshOnRelease = new Map<string, ScheduleAccountV1>()
      for (const h of box.heldFires) {
        if (h.reason === 'admission-refused') {
          releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
          continue
        }
        const schedule = box.schedules.find(s => s.id === h.scheduleId)
        if (schedule === undefined) continue
        const resolvedHold = resolveFireTimeAccount(ports, schedule, undefined)
        if (resolvedHold.kind === 'no-credential') continue
        const verdict = scheduleAccountVerdict({ account: resolvedHold.account, nextFireMs: now, nowMs: now, live: ports.liveFacts(resolvedHold.account) })
        if (verdict.state !== 'ready') continue
        if (h.reason === 'account-mismatch') {
          if (resolvedHold.identityMismatch !== true) {
            releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
          } else if (identityLabelOf(resolvedHold.account) !== h.mismatchIdentity) {
            releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
            boxRefreshOnRelease.set(`${h.scheduleId}@${h.dueAt}`, resolvedHold.account)
          }
          continue
        }
        if (resolvedHold.identityMismatch === true) continue
        releasable.push({ scheduleId: h.scheduleId, dueAt: h.dueAt })
      }
      for (const h of takeBoxHeldFires(releasable, ports.dir)) {
        const boxRearm = boxRefreshOnRelease.get(`${h.scheduleId}@${h.dueAt}`)
        if (boxRearm !== undefined) refreshBoxScheduleAccount(h.scheduleId, boxRearm, ports.dir)
        if (h.envelope.kind !== 'birth' || h.envelope.birth === undefined) {
          // Unreachable past the read's loud-skip validation — the belt
          // says so out loud rather than dropping a taken hold in silence.
          logForDebugging(`[saturn] box held fire ${h.scheduleId} dropped — its envelope is not a replayable birth`)
          continue
        }
        const by = `saturn:box:${h.scheduleId}`
        const landed = await ports.birth(h.envelope.birth, { scheduleId: h.scheduleId, dueAt: h.dueAt, by, owner: 'box' })
        if (landed.ok) {
          report.replayed++
          markBoxScheduleFired(h.scheduleId, now, ports.dir)
          logForDebugging(`[saturn] box birth ${h.scheduleId} landed late (held since ${new Date(h.heldAt).toISOString()}) as ${landed.sessionId ?? '?'}`)
        } else {
          holdBoxFire(h, ports.dir)
          report.held++
        }
      }
    }
    // The session tier's settled-business law, box side: a hold at read is
    // the row's whole due story this tick (the release loop above is its
    // one door) — never a second adjudication off this stale file snapshot.
    const boxHeldAtStart = new Set(box.heldFires.map(h => h.scheduleId))
    for (const schedule of box.schedules) {
      if (boxHeldAtStart.has(schedule.id)) continue
      const dueAt = saturnDueAtOf(schedule)
      if (dueAt === null || dueAt > now) continue
      const by = `saturn:box:${schedule.id}`
      const lateMs = now - dueAt

      // Screen-present box births wait while no screen is open — the same
      // contract as the session arm (the gate is box-scoped; the SCREEN
      // lane's ruled widening lets the box tier carry this arm).
      if (schedule.action.kind === 'birth' && schedule.action.birth.presence === 'screen-present' && !ports.screenOpen()) {
        continue
      }
      if (lateMs > windowMs) {
        const marked = markBoxScheduleFired(schedule.id, now, ports.dir)
        report.missed++
        logForDebugging(`[saturn] box schedule ${schedule.id} missed — ~${Math.round(lateMs / 60000)}m late, beyond the ${Math.round(windowMs / 60000)}m window; not fired${marked === 'spent' ? ' (one-shot spent)' : ' (re-armed forward)'}`)
        continue
      }
      const resolvedBox = resolveFireTimeAccount(ports, schedule, undefined)
      if (resolvedBox.kind === 'no-credential') {
        const missReason = resolvedBox.code === 'unreachable' ? ('unreachable' as const) : ('signed-out' as const)
        const held = holdBoxFire({ scheduleId: schedule.id, dueAt, reason: missReason, envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          logForDebugging(`[saturn] box schedule ${schedule.id} held (${missReason}) — ${resolvedBox.reason}`)
        }
        continue
      }
      const boxAccount = resolvedBox.account
      if (resolvedBox.identityMismatch === true) {
        const held = holdBoxFire(
          {
            scheduleId: schedule.id,
            dueAt,
            reason: 'account-mismatch',
            envelope: envelopeOf(schedule, dueAt),
            heldAt: now,
            ...(identityLabelOf(boxAccount) !== undefined ? { mismatchIdentity: identityLabelOf(boxAccount) } : {}),
          },
          ports.dir,
        )
        if (held === 'held') {
          report.held++
          logForDebugging(`[saturn] box schedule ${schedule.id} held (account-mismatch) — made under a different ${boxAccount.family} account; /logins or run-now releases on the current one`)
        }
        continue
      }
      const verdict = scheduleAccountVerdict({ account: boxAccount, nextFireMs: dueAt, nowMs: now, live: ports.liveFacts(boxAccount) })
      const holdState =
        verdict.state === 'signed-out' || verdict.state === 'unreachable' || verdict.state === 'expired' || verdict.state === 'rate-limited'
          ? verdict.state
          : verdict.state === 'expiring' && verdict.expiresAt <= now
            ? ('expired' as const)
            : null
      if (holdState !== null) {
        const held = holdBoxFire({ scheduleId: schedule.id, dueAt, reason: heldReasonOf(holdState), envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          logForDebugging(`[saturn] box schedule ${schedule.id} held (${heldReasonOf(holdState)}) — the release (sign-in, limit end, or the server's return) replays it`)
        }
        continue
      }
      if (schedule.action.kind !== 'birth') continue // read-validated away; total anyway
      const marked = markBoxScheduleFired(schedule.id, now, ports.dir)
      if (marked === 'missing') continue
      const landed = await ports.birth(schedule.action.birth, { scheduleId: schedule.id, dueAt, by, owner: 'box' })
      if (landed.ok) {
        report.fired++
        if (resolvedBox.movedFromFamily !== undefined && marked === 'marked') {
          // The route law moved the pinned model's family — the fire
          // followed the derivation (the model the birth runs resolves
          // there now); the capture refreshes, spoken in the log.
          refreshBoxScheduleAccount(schedule.id, boxAccount, ports.dir)
          logForDebugging(`[saturn] box birth ${schedule.id} fired on ${boxAccount.family} — the model's route moved after scheduling (was ${resolvedBox.movedFromFamily})`)
        }
        logForDebugging(`[saturn] box birth ${schedule.id} fired as ${landed.sessionId ?? '?'}`)
      } else {
        const held = holdBoxFire({ scheduleId: schedule.id, dueAt, reason: 'admission-refused', envelope: envelopeOf(schedule, dueAt), heldAt: now }, ports.dir)
        if (held === 'held') {
          report.held++
          logForDebugging(`[saturn] box birth ${schedule.id} refused by the admission (${landed.detail ?? 'no detail'}) — banked, retried each tick`)
        }
      }
    }
  }
  return report
}

async function replayEnvelope(
  ports: SaturnTickerPortsV1,
  rec: ConcourseWorkerRecordV1,
  envelope: SaturnFireEnvelopeV1,
  parked: boolean,
  by: string,
): Promise<{ ok: boolean; sessionId?: string; detail?: string }> {
  if (envelope.kind === 'birth') {
    if (envelope.birth === undefined) return { ok: false, detail: 'malformed envelope: birth without a spec' }
    return ports.birth(envelope.birth, { scheduleId: envelope.scheduleId, dueAt: envelope.dueAt, by, owner: rec.sessionId })
  }
  const prompt = envelope.prompt ?? ''
  if (prompt.length === 0) return { ok: false, detail: 'malformed envelope: fire without a prompt' }
  return ports.deliver({
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    // THE LOOP-SENTINEL EXPANSION, REVIVED on the new fire road (it had
    // been dead since the stranded-estate walk): sentinel prompts expand
    // against the SESSION's own workspace and its own chain state (first
    // fire = preamble/loop.md whole; later fires = the reminder; a loop.md
    // edit re-delivers whole). Non-sentinel prompts pass verbatim.
    prompt: resolveLoopFireForWorkspace(prompt, rec.workspaceId, loopChainOf(rec.sessionId)),
    by,
    // The ledger dedupes daemon-wide by this key alone — the owner scopes
    // it so two sessions colliding on (scheduleId, dueAt) never dedupe
    // each other's fires away.
    clientMessageId: `saturn-${rec.sessionId}-${envelope.scheduleId}-${envelope.dueAt}`,
    parked,
  })
}

// Per-SESSION sentinel-chain states (in-memory: a daemon restart re-sends
// the full body once, which is honest freshness, never a loss).
const loopChains = new Map<string, LoopFireChainStateV1>()
function loopChainOf(sessionId: string): LoopFireChainStateV1 {
  let chain = loopChains.get(sessionId)
  if (chain === undefined) {
    chain = freshLoopFireChainState()
    loopChains.set(sessionId, chain)
  }
  return chain
}

// ── the daemon's loop ───────────────────────────────────────────────────────

export const SATURN_TICK_MS = 30_000

/** Start the interval loop. The daemon owns the real ports; the returned
 *  stop is idempotent. Ticks never overlap (a long effect delays the next
 *  tick instead of stacking). */
export function startSaturnTicker(ports: SaturnTickerPortsV1, onReport?: (r: SaturnTickReportV1) => void): () => void {
  let running = false
  let stopped = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    void tickSaturnOnce(ports)
      .then(r => {
        if (onReport && r.fired + r.held + r.missed + r.replayed > 0) onReport(r)
      })
      .catch(() => {})
      .finally(() => {
        running = false
      })
  }, SATURN_TICK_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
