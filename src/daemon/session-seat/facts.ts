import { logForDebugging } from '../../platform/logs/debugLog.js'
import { type SessionFactsAnswerV1, runnerStateFactOf, publishSessionFacts, type SessionFactsV1 } from '../../engine/connector/seatProjections.js'
import { scheduleRosterToWire, sessionFactsFromWire, scheduleEditFromWire } from '../../engine/connector/seatWire.js'
import { workRowRuns } from '../../engine/connector/workCounts.js'
import { type ConcourseWorkerRecordV1, updateConcourseWorkers } from '../concourse-workers/concourseWorkers.js'
import type { ParamsOf, ResultOf } from '../runner-wire/methods.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { PeerClosed } from '../runner-wire/peer.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { refreshSignInReads } from './signInView.js'
import { validateSessionKit, resolveSessionKitOnRecord } from './sessionKit.js'
import { spawnSwitchFactsOfRecord } from '../switchboard/spawnSwitches.js'
import { saturnFactsOf, applyConcourseScheduleOp, SATURN_EDIT_BURST_CAP } from '../saturn/saturn.js'
import { deriveScheduleAccountForModel, scheduleAccountVerdict, readLiveAccountFacts } from '../saturn/saturnAccount.js'
import { type SeatState, liveRecordByShort, seatOf, seatTurnOpen, publishActivity, type SeatRosterPort, seats, liveRecordBySession } from './state.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const FACTS_DEBOUNCE_MS = 250

const ZERO_USAGE: SessionFactsAnswerV1['usage'] = {
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
}

export function spawnPostureWordOf(rec: Pick<ConcourseWorkerRecordV1, 'permissionMode'>): { permissionMode: PermissionMode } | Record<string, never> {
  return rec.permissionMode !== undefined ? { permissionMode: rec.permissionMode } : {}
}

function skeletonAnswer(rec: ConcourseWorkerRecordV1): Omit<SessionFactsAnswerV1, 'permissionMode'> & { permissionMode?: PermissionMode } {
  const cwd = rec.worktreePath ?? rec.workspaceId
  return {
    model: { effective: rec.modelKey, setting: rec.modelKey },
    usage: ZERO_USAGE,
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    ...spawnPostureWordOf(rec),
    workspace: { cwd, originalCwd: cwd, projectRoot: rec.workspaceId },
    queue: [],
  }
}

export function queueReadinessFacts(seat: Pick<SeatState, 'lastAnswer'>): { queueReady: boolean } {
  return { queueReady: seat.lastAnswer !== null }
}

export function publishSeatFacts(short: string, dir?: string, roster?: SeatRosterPort): void {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const seat = seatOf(short)
  const answer = seat.lastAnswer ?? skeletonAnswer(rec)
  const { box: boxAnswer, ...answerRest } = answer
  seat.lastFactsAtMs = Math.max(Date.now(), seat.lastFactsAtMs + 1)
  const entry = roster?.list().find(j => j.short === short)
  const runnerFact = runnerStateFactOf(entry, Date.now())
  const facts: SessionFactsV1 = {
    schema: 1,
    sessionId: rec.sessionId,
    atMs: seat.lastFactsAtMs,
    ...answerRest,
    ...(seat.generation > 0 ? { runnerGeneration: seat.generation } : {}),
    ...queueReadinessFacts(seat),
    model: {
      effective: seat.lastAnswer?.model.effective ?? rec.modelKey,
      setting: seat.lastAnswer?.model.setting ?? rec.modelKey,
    },
    pendingModel: rec.pendingModelKey ?? null,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    spawnSwitches: spawnSwitchFactsOfRecord(rec),
    ...(rec.pendingSpawnSwitches !== undefined && rec.pendingSpawnSwitches.length > 0
      ? { pendingSpawnSwitches: rec.pendingSpawnSwitches.map(p => ({ kind: p.kind, on: p.on })) }
      : {}),
    ...(seat.lastModelSettle !== null ? { modelSettled: seat.lastModelSettle } : {}),
    busy: roster !== undefined ? seatTurnOpen(entry) : seat.lastBusy,
    ...(entry?.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
    ...(entry?.turnOpenedAt !== undefined ? { turnOpenedAt: entry.turnOpenedAt } : {}),
    ...saturnFactsOf(rec, Date.now()),
    ...(boxAnswer !== undefined ? { box: boxAnswer } : {}),
    ...(runnerFact !== undefined ? { runner: runnerFact } : {}),
  }
  seat.lastBusy = facts.busy
  try {
    publishActivity(short, roster, dir)
    publishSessionFacts(facts, dir)
  } catch (e) {
    logForDebugging(`[daemon] session facts publish failed for ${short}: ${e}`)
  }
}

export function requestSessionFacts(
  short: string,
  roster: SeatRosterPort,
  opts?: { immediate?: boolean },
  dir?: string,
): void {
  const seat = seatOf(short)
  const fire = (): void => {
    seat.debounce = null
    const door = roster.door(short)
    if (door === undefined || door.closed) return
    const generation = seat.generation
    door.request(SESSION_VERBS.sessionFacts.runner.name, {}).then(
      result => {
        if (seats.get(short) !== seat || seat.generation !== generation) return
        onFactsAnswer(short, result, roster, dir)
      },
      (error: unknown) => {
        if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] facts for ${short}: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }
  if (opts?.immediate) {
    if (seat.debounce !== null) {
      stopTimeout(seat.debounce)
      seat.debounce = null
    }
    fire()
    return
  }
  if (seat.debounce !== null) return
  const t = startTimeout(fire, FACTS_DEBOUNCE_MS)
  t.unref?.()
  seat.debounce = t
}

const WORK_POLL_MS = 1000

function armWorkPoll(short: string, roster: SeatRosterPort, dir?: string): void {
  const seat = seats.get(short)
  if (seat === undefined) return
  const live = (seat.lastAnswer?.work ?? []).some(workRowRuns) || seat.lastAnswer?.mcp.some(server => server.type === 'pending')
  if (!live) {
    if (seat.workPoll !== null) {
      stopTimeout(seat.workPoll)
      seat.workPoll = null
    }
    return
  }
  if (seat.workPoll !== null) return
  const t = startTimeout(() => {
    seat.workPoll = null
    if (seats.get(short) === undefined) return
    requestSessionFacts(short, roster, { immediate: true }, dir)
    armWorkPoll(short, roster, dir)
  }, WORK_POLL_MS)
  t.unref?.()
  seat.workPoll = t
}

function seatScheduleDeps(): import('../saturn/saturn.js').ScheduleOpDepsV1 {
  return {
    deriveAccount: deriveScheduleAccountForModel,
    preflight: (account, nextFireMs) =>
      scheduleAccountVerdict({ account, nextFireMs, nowMs: Date.now(), live: readLiveAccountFacts(account) }),
  }
}

export function pushScheduleRoster(short: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return false
  const door = roster.door(short)
  if (door === undefined || door.closed) return false
  door.request(SESSION_VERBS.scheduleRoster.runner.name, { schedules: scheduleRosterToWire(saturnFactsOf(rec, Date.now()).schedules ?? []) }).catch((error: unknown) => {
    if (!(error instanceof PeerClosed)) logForDebugging(`[daemon] schedule roster for ${short}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return true
}

export function pushScheduleRosterForSession(sessionId: string, roster: SeatRosterPort, dir?: string): boolean {
  const rec = liveRecordBySession(sessionId, dir)
  if (!rec) return false
  const pushed = pushScheduleRoster(rec.runnerId, roster, dir)
  if (pushed) requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  return pushed
}

export function onFactsAnswer(short: string, result: unknown, roster: SeatRosterPort, dir?: string): void {
  const answer = sessionFactsFromWire(result)
  if (answer === null) return
  seatOf(short).lastAnswer = answer
  maybeResolveSessionKit(short, answer, dir)
  applySessionScheduleAnswer(short, answer, roster, dir)
  publishSeatFacts(short, dir, roster)
  armWorkPoll(short, roster, dir)
}

export function answerSeatScheduleEdit(
  short: string,
  params: ParamsOf<typeof SESSION_VERBS.scheduleEdit.runner.name>,
  roster: SeatRosterPort,
  dir?: string,
  deps = seatScheduleDeps(),
): ResultOf<typeof SESSION_VERBS.scheduleEdit.runner.name> {
  const rec = liveRecordByShort(short, dir)
  if (!rec) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
  const raw = scheduleEditFromWire(params.edit)
  const op = (raw as { op?: unknown } | null)?.op
  if (op !== 'add' && op !== 'remove' && op !== 'pause' && op !== 'resume') {
    return { outcome: 'refused', detail: 'schedule refused — op must be add|remove|pause|resume' }
  }
  refreshSignInReads()
  const out = applyConcourseScheduleOp(rec.sessionId, raw as import('../saturn/saturn.js').ScheduleOpRequestV1, `model:${rec.sessionId}`, deps, dir)
  logForDebugging(`[daemon] schedule edit (${op}) from ${short}: ${out.outcome}${out.detail !== undefined ? ` — ${out.detail}` : ''}`)
  pushScheduleRoster(short, roster, dir)
  requestSessionFacts(short, roster, { immediate: true }, dir)
  const preflight = out.preflight
  return {
    outcome: out.outcome,
    ...(out.detail !== undefined ? { detail: out.detail } : {}),
    ...(out.scheduleId !== undefined ? { schedule_id: out.scheduleId } : {}),
    ...(out.nextFireMs !== undefined ? { next_fire_ms: out.nextFireMs } : {}),
    ...(out.family !== undefined ? { family: out.family } : {}),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(preflight !== undefined ? { preflight: {
      state: preflight.state,
      ...('expiresAt' in preflight ? { expires_at: preflight.expiresAt, before_fire: preflight.beforeFire } : {}),
      ...('retryAt' in preflight ? { retry_at: preflight.retryAt } : {}),
    } } : {}),
  }
}

export function applySeatScheduleControl(
  sessionId: string,
  edit: import('../saturn/saturn.js').ScheduleOpRequestV1,
  by: string,
  roster: SeatRosterPort | null,
  dir?: string,
  deps = seatScheduleDeps(),
): ReturnType<typeof applyConcourseScheduleOp> {
  refreshSignInReads()
  const out = applyConcourseScheduleOp(sessionId, edit, by, deps, dir)
  const rec = out.outcome === 'applied' && roster !== null ? liveRecordBySession(sessionId, dir) : undefined
  if (rec !== undefined && roster !== null) {
    pushScheduleRoster(rec.runnerId, roster, dir)
    requestSessionFacts(rec.runnerId, roster, { immediate: true }, dir)
  }
  return out
}

function applySessionScheduleAnswer(short: string, answer: SessionFactsAnswerV1, roster: SeatRosterPort, dir?: string): void {
  const edits = (answer as { pendingScheduleEdits?: unknown }).pendingScheduleEdits
  if (!Array.isArray(edits) || edits.length === 0) return
  const rec = liveRecordByShort(short, dir)
  if (!rec) return
  const by = `model:${rec.sessionId}`
  const bounded = edits.slice(0, SATURN_EDIT_BURST_CAP)
  if (edits.length > bounded.length) {
    logForDebugging(`[daemon] schedule edits from ${short} clipped to ${bounded.length} (${edits.length} sent)`)
  }
  for (const raw of bounded) {
    const op = (raw as { op?: unknown } | null)?.op
    if (op !== 'add' && op !== 'remove' && op !== 'pause' && op !== 'resume') {
      logForDebugging(`[daemon] schedule edit from ${short} skipped — unknown op ${String(op)}`)
      continue
    }
    const outcome = applyConcourseScheduleOp(rec.sessionId, raw as import('../saturn/saturn.js').ScheduleOpRequestV1, by, seatScheduleDeps(), dir)
    logForDebugging(`[daemon] schedule edit (${op}) from ${short}: ${outcome.outcome}${outcome.detail !== undefined ? ` — ${outcome.detail}` : ''}`)
  }
  pushScheduleRoster(short, roster, dir)
  requestSessionFacts(short, roster, { immediate: true }, dir)
}

function maybeResolveSessionKit(short: string, answer: SessionFactsAnswerV1, dir?: string): void {
  const reported = answer.kit
  if (reported === undefined) return
  const rec = liveRecordByShort(short, dir)
  if (!rec || rec.kit === undefined || rec.kit.resolved !== false) return
  const validated = validateSessionKit(reported)
  if (!validated.ok || validated.kit.resolved === false) {
    if (!validated.ok) logForDebugging(`[daemon] kit completion refused for ${short} — ${validated.reason}`)
    return
  }
  try {
    updateConcourseWorkers(workers => {
      const w = workers[short]
      if (!w || w.endedAt !== undefined) return
      resolveSessionKitOnRecord(w, validated.kit)
    }, dir)
  } catch (e) {
    logForDebugging(`[daemon] kit completion stamp failed for ${short}: ${e}`)
  }
}
