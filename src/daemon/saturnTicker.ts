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


export const DEFAULT_SATURN_CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000

export function saturnCatchupWindowMs(): number {
  if (!flagEnabled('MERCURY_DAEMON_CATCHUP')) return 0
  const raw = flagEnv('MERCURY_DAEMON_CATCHUP_MINUTES')
  const n = parseInt(raw ?? '', 10)
  if (Number.isFinite(n) && n > 0) return n * 60 * 1000
  return DEFAULT_SATURN_CATCHUP_WINDOW_MS
}

export function isSaturnDisabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))
}


export interface SaturnDeliveryV1 {
  sessionId: string
  workspaceId: string
  prompt: string
  by: string
  clientMessageId: string
  parked: boolean
}

export interface SaturnTickerPortsV1 {
  now(): number
  records(): ConcourseWorkerRecordV1[]
  liveFacts(account: ScheduleAccountV1): LiveAccountFactsV1
  deriveAccount(modelKey: string): { ok: true; account: ScheduleAccountV1 } | { ok: false; reason: string; code?: 'unreachable' }
  deliver(d: SaturnDeliveryV1): Promise<{ ok: boolean; detail?: string }>
  birth(spec: SaturnBirthSpecV1, opts: { scheduleId: string; dueAt: number; by: string; owner: string }): Promise<{ ok: boolean; sessionId?: string; detail?: string }>
  screenOpen(): boolean
  dir?: string
}


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

type FireTimeAccountV1 =
  | { kind: 'account'; account: ScheduleAccountV1; movedFromFamily?: string; identityMismatch?: true; fireModelKey: string }
  | { kind: 'no-credential'; reason: string; code?: 'unreachable'; fireModelKey: string }

function identityLabelOf(a: ScheduleAccountV1): string | undefined {
  return a.source === 'oauth' ? (a.identity ?? a.scopeDir) : undefined
}

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


export interface SaturnTickReportV1 {
  fired: number
  held: number
  missed: number
  replayed: number
}

export async function tickSaturnOnce(ports: SaturnTickerPortsV1): Promise<SaturnTickReportV1> {
  const report: SaturnTickReportV1 = { fired: 0, held: 0, missed: 0, replayed: 0 }
  if (isSaturnDisabled()) return report
  const now = ports.now()
  const windowMs = saturnCatchupWindowMs()

  for (const rec of ports.records()) {
    const sessionId = rec.sessionId
    const parked = isParkedRecord(rec)

    const heldList = Array.isArray(rec.heldFires) ? rec.heldFires.filter(saturnHeldRowUsable) : []
    const scheduleList = Array.isArray(rec.schedules) ? rec.schedules.filter(saturnScheduleRowUsable) : []
    const mangledCount =
      (Array.isArray(rec.heldFires) ? rec.heldFires.length - heldList.length : rec.heldFires !== undefined ? 1 : 0) +
      (Array.isArray(rec.schedules) ? rec.schedules.length - scheduleList.length : rec.schedules !== undefined ? 1 : 0)
    if (mangledCount > 0) {
      logForDebugging(`[saturn] session ${sessionId}: ${mangledCount} mangled schedule/hold entr${mangledCount === 1 ? 'y' : 'ies'} skipped (record surgery?) — healthy rows proceed`)
    }

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
        const schedule = scheduleList.find(s => s.id === h.scheduleId)
        if (schedule === undefined) continue
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
            holdSaturnFire(sessionId, { ...h, heldAt: h.heldAt }, ports.dir)
            report.held++
          }
        }
      }
    }

    const heldAtTickStart = new Set(heldList.map(h => h.scheduleId))
    let heldNowCount = heldList.length
    for (const schedule of scheduleList) {
      if (heldAtTickStart.has(schedule.id)) continue
      const dueAt = saturnDueAtOf(schedule)
      if (dueAt === null || dueAt > now) continue
      const by = `saturn:${schedule.id}`
      const lateMs = now - dueAt

      if (schedule.action.kind === 'birth' && schedule.action.birth.presence === 'screen-present' && !ports.screenOpen()) {
        continue
      }

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

      const resolved = resolveFireTimeAccount(ports, schedule, rec.modelKey)
      if (resolved.kind === 'no-credential') {
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

      const marked = markSaturnFired(sessionId, schedule.id, now, ports.dir)
      if (marked === 'missing') continue
      const effect = await replayEnvelope(ports, rec, envelopeOf(schedule, dueAt), parked, by)
      if (effect.ok) {
        report.fired++
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
    const boxHeldAtStart = new Set(box.heldFires.map(h => h.scheduleId))
    for (const schedule of box.schedules) {
      if (boxHeldAtStart.has(schedule.id)) continue
      const dueAt = saturnDueAtOf(schedule)
      if (dueAt === null || dueAt > now) continue
      const by = `saturn:box:${schedule.id}`
      const lateMs = now - dueAt

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
      if (schedule.action.kind !== 'birth') continue
      const marked = markBoxScheduleFired(schedule.id, now, ports.dir)
      if (marked === 'missing') continue
      const landed = await ports.birth(schedule.action.birth, { scheduleId: schedule.id, dueAt, by, owner: 'box' })
      if (landed.ok) {
        report.fired++
        if (resolvedBox.movedFromFamily !== undefined && marked === 'marked') {
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
    prompt: resolveLoopFireForWorkspace(prompt, rec.workspaceId, loopChainOf(rec.sessionId)),
    by,
    clientMessageId: `saturn-${rec.sessionId}-${envelope.scheduleId}-${envelope.dueAt}`,
    parked,
  })
}

const loopChains = new Map<string, LoopFireChainStateV1>()
function loopChainOf(sessionId: string): LoopFireChainStateV1 {
  let chain = loopChains.get(sessionId)
  if (chain === undefined) {
    chain = freshLoopFireChainState()
    loopChains.set(sessionId, chain)
  }
  return chain
}


export const SATURN_TICK_MS = 30_000

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
