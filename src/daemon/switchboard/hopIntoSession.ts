import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { AwayRecapMetadata, LaunchWonV1 } from '../../engine/message-shapes/message.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { emitFocusedSessionConnectorChanged, getFocusedSessionConnector, hasFocusedSession, withLanding } from '../../engine/connector/focusedConnector.js'
import { armLandingWords, bootBirthFacts, carriedConsentOf, carriedKitOf, carriedRunnerArgvOf, carriedTypedModeOf, peekWornPresetKit, resumeLaunchWordsOf, settleLandingWords, takeWornPresetKit } from './bootBirthFacts.js'
import { createSeatReceiptMessage } from '../../engine/message-shapes/systemMessages.js'
import { mintImmediateReceipt } from '../../models/facts/seatReceipts.js'
import { validateUuid } from '../../sessions/transcripts/sessionStoragePortable.js'
import { pollUntil, withDeadline } from '../../platform/async/deadline.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import { errorMessage, getErrnoCode } from '../../platform/errors/errors.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'

export function liveTitleDeriverFor(
  workers: {
    readSessionWorkers: (dir?: string) => Record<string, { sessionId: string; title?: string }>
    concourseWorkersPath: (dir?: string) => string
  },
  titleOf: (rec: { title?: string; workspaceId: string }, briefOf: () => string | null) => string,
  briefLabel: (rec: { sessionId: string; workspaceId: string }, maxChars?: number) => string | null,
): (record: { sessionId: string; workspaceId: string; title: string }) => string | null {
  const briefs = new Map<string, string>()
  let recordsMtime = -1
  let titlesBySession = new Map<string, string | undefined>()
  return record => {
    try {
      const mtime = statSync(workers.concourseWorkersPath()).mtimeMs
      if (mtime !== recordsMtime) {
        recordsMtime = mtime
        titlesBySession = new Map()
        for (const rec of Object.values(workers.readSessionWorkers())) titlesBySession.set(rec.sessionId, rec.title)
      }
    } catch (error) {
      passedOver(error)
    }
    const stored = (titlesBySession.get(record.sessionId) ?? '').trim()
    const briefOf = (): string | null => {
      const memo = briefs.get(record.sessionId)
      if (memo !== undefined) return memo
      const found = briefLabel({ sessionId: record.sessionId, workspaceId: record.workspaceId }, 48)
      if (found !== null && found.trim().length > 0) briefs.set(record.sessionId, found.trim())
      return found
    }
    return titleOf({ title: stored, workspaceId: record.workspaceId }, briefOf)
  }
}

type HopOutcome =
  | { ok: true; title: string }
  | { ok: false; reason: string }

export function hopIntoBoardSession(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  return withLanding(hopIntoBoardSessionLanding(sessionId, opts))
}

async function hopIntoBoardSessionLanding(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  const workers = await import('../concourse-workers/concourseWorkers.js')
  const rec = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (!rec) return { ok: false, reason: 'no live session record owns this id' }
  const paths = await import('../../sessions/transcripts/paths.js')
  const seat = await import('../../engine/connector/daemonConnector.js')
  const { sessionTitleOf } = await import('../../screen/concourse-model/sessionNaming.js')
  const { headBriefLabel } = await import('../../screen/concourse-model/concourseSnapshot.js')
  const title = sessionTitleOf(rec, () => headBriefLabel(rec, 48))
  seat.registerLiveTitleDeriver(liveTitleDeriverFor(workers, sessionTitleOf, headBriefLabel))
  if (!hasFocusedSession()) {
    armLandingWords({ model: rec.modelKey ?? null, effort: rec.effort ?? null, permissionMode: (rec.permissionMode as PermissionMode | undefined) ?? null })
    emitFocusedSessionConnectorChanged()
  }
  const hop = seat.focusDaemonSession({
    sessionId,
    runnerId: rec.runnerId,
    title,
    projectLabel: basename(rec.workspaceId) || rec.workspaceId,
    workspaceId: rec.workspaceId,
    home: paths.getProjectDir(rec.workspaceId),
    ...(rec.isolation !== undefined ? { isolation: rec.isolation } : {}),
    ...(rec.branchName !== undefined ? { branchLabel: rec.branchName } : {}),
    ...(rec.modelKey !== undefined ? { modelKey: rec.modelKey } : {}),
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.worktreePath !== undefined ? { worktreePath: rec.worktreePath } : {}),
  }, workers.sessionOwnedByLiveWorker(sessionId) !== null)
  void hop.catch(() => settleLandingWords())
  await withDeadline(hop, opts?.firstPaintMs ?? 250, () => undefined)
  void withLanding(hop.then(() => undefined)).catch(passedOver)
  void import('./ensureDaemon.js')
    .then(m => m.ensureOwnedDaemon())
    .catch(passedOver)
  return { ok: true, title }
}

export async function paintAdmissionNote(sessionId: string, note: string): Promise<void> {
  const seat = await import('../../engine/connector/daemonConnector.js')
  seat.getDaemonSessionConnector(sessionId)?.addDisplayRow(createSeatReceiptMessage(`▲ ${note}`, 'warning'))
}

type ResumeOutcome = HopOutcome & {
  admitted: Promise<boolean>
  refusal: Promise<string | null>
}

export function composeNoRunnerLine(title: string, reason: string): string {
  const plain = /not ready/i.test(reason) ? 'the daemon is starting' : reason
  return `${title}: the session has no live runner — a replay revives it and delivers into the same chat · ${plain} · ↵ revives it`
}

function composeHeldLine(title: string): string {
  return `${title}: a live runner still holds this session — re-attached to it`
}

async function workspaceOfTranscript(transcriptPath: string | undefined): Promise<string> {
  if (transcriptPath !== undefined) {
    try {
      const { historyHead, historyRange } = await import('../../sessions/transcripts/historyParts.js')
      const extent = historyHead(transcriptPath)
      const size = extent.before + extent.end - extent.start
      if (size > 0) {
        const head = historyRange(extent, 0, Math.min(size, 8192)).toString('utf8')
        const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
        if (m) return JSON.parse(`"${m[1]}"`) as string
      }
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') throw error
      passedOver(error)
    }
  }
  const { getCwd } = await import('../../platform/files/cwd.js')
  return getCwd()
}

export function focusResumedSession(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: ResumeOptions,
): Promise<ResumeOutcome> {
  return withLanding(focusResumedSessionLanding(sessionId, transcriptPath, opts))
}

type ResumeOptions = { title?: string; firstPaintMs?: number; permissionMode?: string; model?: string; effort?: string; restartReason?: 'update' }

type LaunchWords = { model?: string; effort?: string }

const HELD_LIVE_PING_MS = 500

async function heldLiveUnderDaemon(sessionId: string): Promise<boolean> {
  const workers = await import('../concourse-workers/concourseWorkers.js')
  if (workers.sessionOwnedByLiveWorker(sessionId) === null) return false
  const { daemonControlRpc } = await import('../control/controlSocket.js')
  const pong = await daemonControlRpc({ op: 'ping' }, { timeoutMs: HELD_LIVE_PING_MS })
  if (pong.ok !== true) return false
  const rec = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  return rec !== undefined && rec.parkedAt === undefined && workers.sessionOwnedByLiveWorker(sessionId) !== null
}

async function focusResumedSessionLanding(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: ResumeOptions,
): Promise<ResumeOutcome> {
  if (validateUuid(sessionId) === null) {
    const reason = 'no live session record owns this id'
    return { ok: false, reason, admitted: Promise.resolve(false), refusal: Promise.resolve(reason) }
  }
  const launch: LaunchWords = resumeLaunchWordsOf(opts)
  const launchGiven = launch.model !== undefined || launch.effort !== undefined
  if (await heldLiveUnderDaemon(sessionId)) {
    const hop = await hopIntoBoardSession(sessionId, opts)
    if (hop.ok && launchGiven) void applyLaunchWordOnHop(sessionId, launch, () => admitResumedSession(sessionId, transcriptPath, opts, launch))
    return { ...hop, admitted: Promise.resolve(hop.ok), refusal: Promise.resolve(hop.ok ? null : hop.reason) }
  }
  return admitResumedSession(sessionId, transcriptPath, opts, launch)
}

async function admitResumedSession(
  sessionId: string,
  transcriptPath: string | undefined,
  opts: ResumeOptions | undefined,
  launch: LaunchWords,
  admitsAgain = true,
): Promise<ResumeOutcome> {
  const workers = await import('../concourse-workers/concourseWorkers.js')
  const launchGiven = launch.model !== undefined || launch.effort !== undefined
  const standing = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  let workspaceDir: string
  try {
    workspaceDir = standing?.workspaceId ?? (await workspaceOfTranscript(transcriptPath))
  } catch (error) {
    const reason = errorMessage(error)
    return { ok: false, reason, admitted: Promise.resolve(false), refusal: Promise.resolve(reason) }
  }
  const paths = await import('../../sessions/transcripts/paths.js')
  const seat = await import('../../engine/connector/daemonConnector.js')
  const { headBriefLabel } = await import('../../screen/concourse-model/concourseSnapshot.js')
  const title = opts?.title ?? standing?.title ?? headBriefLabel({ sessionId, workspaceId: workspaceDir }, 48) ?? sessionId.slice(0, 8)
  const retainedModel = standing === undefined ? workers.resumeModelKeyOf(sessionId, workspaceDir) : standing.modelKey
  const connector = seat.daemonSessionConnectorFor({
    sessionId,
    runnerId: '',
    title,
    projectLabel: basename(workspaceDir) || workspaceDir,
    workspaceId: workspaceDir,
    home:
      standing !== undefined
        ? paths.getProjectDir(standing.workspaceId)
        : transcriptPath !== undefined
          ? dirname(transcriptPath)
          : paths.getProjectDir(workspaceDir),
    ...(standing?.isolation !== undefined ? { isolation: standing.isolation } : {}),
    ...(standing?.branchName !== undefined ? { branchLabel: standing.branchName } : {}),
    ...(retainedModel !== undefined ? { modelKey: retainedModel } : {}),
    ...(standing?.effort !== undefined ? { effort: standing.effort } : {}),
    ...(standing?.worktreePath !== undefined ? { worktreePath: standing.worktreePath } : {}),
  })
  const saved = launchGiven
    ? {
        model: standing?.modelKey ?? workers.resumeModelKeyOf(sessionId, workspaceDir),
        effort:
          standing?.effort ??
          Object.values(workers.readSessionWorkers())
            .filter(r => r.sessionId === sessionId && r.effort !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.effort ??
          'high',
      }
    : {}
  let settleLaunchWon: (won: LaunchWonV1 | null) => void = () => {}
  const launchWon: Promise<LaunchWonV1 | null> = launchGiven ? new Promise(resolve => { settleLaunchWon = resolve }) : Promise.resolve(null)
  let note: string | undefined
  const refusal = (async (): Promise<string | null> => {
    let won: LaunchWonV1 | null = null
    try {
      const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) return 'the daemon did not start'
      const { daemonControlRpc } = await import('../control/controlSocket.js')
      const worn = peekWornPresetKit()
      const admit = async (): Promise<Record<string, unknown>> => {
        const boot = bootBirthFacts()
        const permissionMode = opts?.permissionMode ?? boot.permissionMode ?? undefined
        return await daemonControlRpc(
          { op: 'sessionAdmit', workspaceDir, resumeSessionId: sessionId, isolation: 'shared', by: 'operator', ...launch, ...(permissionMode !== undefined ? { permissionMode } : {}), ...carriedTypedModeOf(boot, permissionMode), ...carriedConsentOf(boot), ...(opts?.restartReason === undefined ? carriedRunnerArgvOf(boot) : {}), ...(worn !== null ? { kit: worn.kit } : carriedKitOf(boot)), ...(opts?.restartReason !== undefined ? { restartReason: opts.restartReason } : {}) },
          { timeoutMs: 60_000 },
        )
      }
      const parkedStill = (): boolean => Object.values(workers.readSessionWorkers()).some(r => r.sessionId === sessionId && r.endedAt === undefined && r.parkedAt !== undefined)
      let reply = await admit()
      if (reply.liveHop === true && parkedStill()) {
        let waited = false
        reply = await pollUntil(
          async () => {
            if (!waited) {
              waited = true
              return undefined
            }
            if (workers.sessionOwnedByLiveWorker(sessionId) === null) reply = await admit()
            return reply.liveHop === true && parkedStill() ? undefined : reply
          },
          100,
          workers.RETIREMENT_EXIT_WAIT_MS,
          () => reply,
        )
      }
      if (reply.ok !== true) return typeof reply.error === 'string' && reply.error !== '' ? reply.error : 'the daemon refused the resume'
      won = launchWonOf(launch, saved, {
        ...(typeof reply.modelId === 'string' ? { model: reply.modelId } : {}),
        ...(typeof reply.effort === 'string' ? { effort: reply.effort } : {}),
      })
      if (typeof reply.note === 'string' && reply.note !== '') note = reply.note
      if (reply.liveHop === true) mintImmediateReceipt(composeHeldLine(title))
      if (worn !== null && reply.liveHop !== true) takeWornPresetKit()
      const settled = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
      if (settled === undefined) return 'no live session record owns this id'
      seat.daemonSessionConnectorFor({
        sessionId,
        runnerId: settled.runnerId,
        title: settled.title ?? title,
        projectLabel: basename(settled.workspaceId) || settled.workspaceId,
        workspaceId: settled.workspaceId,
        home: paths.getProjectDir(settled.workspaceId),
        ...(settled.isolation !== undefined ? { isolation: settled.isolation } : {}),
        ...(settled.branchName !== undefined ? { branchLabel: settled.branchName } : {}),
        ...(settled.modelKey !== undefined ? { modelKey: settled.modelKey } : {}),
        ...(settled.effort !== undefined ? { effort: settled.effort } : {}),
        ...(settled.worktreePath !== undefined ? { worktreePath: settled.worktreePath } : {}),
      }, reply.liveHop === true)
      connector.assertSeat()
      if (reply.liveHop === true && launchGiven) void applyLaunchWordOnHop(sessionId, launch, admitsAgain ? () => admitResumedSession(sessionId, transcriptPath, opts, launch, false) : null)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      settleLaunchWon(won)
    }
  })()
  connector.awaitAdmission(refusal)
  const admitted = refusal.then(r => r === null)
  const pointed = seat.focusDaemonSession(connector.record)
  await withDeadline(pointed, opts?.firstPaintMs ?? 250, () => undefined)
  void withLanding(pointed.then(() => undefined)).catch(passedOver)
  void Promise.all([refusal, pointed.catch(passedOverAs(undefined))]).then(([refused]) => {
    if (refused === null && note !== undefined) void paintAdmissionNote(sessionId, note)
  })
  void paintResumeRecap(sessionId, launchWon)
  void paintReactivationScheduleWarn(sessionId)
  return { ok: true, title, admitted, refusal }
}

export async function clearFocusedSession(): Promise<{ ok: true; cleared: boolean } | { ok: false; reason: string }> {
  const slot = await import('../../engine/connector/focusedConnector.js')
  if (!slot.hasFocusedSession()) return { ok: true, cleared: false }
  const focused = slot.getFocusedSessionConnector()
  if (focused.turnActive()) {
    return { ok: false, reason: 'this session is mid-turn — esc to interrupt it, then /clear' }
  }
  const workspaceDir = focused.workspace().cwd
  const model = focused.modelFacts().effective
  const oldSessionId = focused.sessionId()
  const { bornSession } = await import('./bornSession.js')
  const born = await bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })
  if (!born.ok) {
    const again = model !== undefined && born.reason.startsWith('model refused (')
      ? await bornSession({ workspaceDir, model: null, vacatingSessionId: oldSessionId })
      : undefined
    if (again === undefined || !again.ok) return { ok: false, reason: `a fresh session could not start, so this one stands — ${born.reason}` }
  }
  const unparked = await parkSessionById(oldSessionId)
  const { markSessionCleared } = await import('../../sessions/transcripts/clearedSessions.js')
  const marked = markSessionCleared(oldSessionId)
  if (unparked !== null) {
    logForDebugging(`[clear] session ${oldSessionId} is still running after its park was asked: ${unparked}`, { level: 'warn' })
    mintImmediateReceipt('the cleared session is still running — park it from the Session Concourse', 'warning')
  }
  if (!marked.ok) mintImmediateReceipt(`the cleared mark could not be saved (${marked.error}), so this session may show in the list again`, 'warning')
  return { ok: true, cleared: true }
}

async function parkSessionById(sessionId: string): Promise<string | null> {
  const workers = await import('../concourse-workers/concourseWorkers.js')
  const rec = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (rec === undefined) return null
  let refusal: string
  try {
    const { daemonControlRpc } = await import('../control/controlSocket.js')
    const reply = await daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId, by: `operator:${process.pid}` }, { timeoutMs: 15_000 })
    if (reply.ok === true && reply.outcome !== 'refused') return null
    refusal = reply.ok === true ? (reply.detail ?? 'refused') : String(reply.error ?? 'refused')
  } catch (error) {
    refusal = errorMessage(error)
  }
  const standing = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  return standing !== undefined && standing.parkedAt === undefined && workers.workerPidAlive(standing) ? refusal : null
}

async function paintReactivationScheduleWarn(sessionId: string): Promise<void> {
  try {
    const workers = await import('../concourse-workers/concourseWorkers.js')
    const rec = Object.values(workers.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    const schedules = rec?.schedules ?? []
    if (schedules.length === 0) return
    const { saturnNextFireMs } = await import('../saturn/saturn.js')
    const { readLiveAccountFacts, scheduleAccountVerdict } = await import('../saturn/saturnAccount.js')
    const now = Date.now()
    const rank = { 'signed-out': 4, unreachable: 4, expired: 3, 'rate-limited': 2, expiring: 1, ready: 0 } as const
    let worst: import('../saturn/saturn.js').ScheduleAccountVerdictV1 | null = null
    for (const s of schedules) {
      if (s.paused === true) continue
      const verdict = scheduleAccountVerdict({
        account: s.account,
        nextFireMs: saturnNextFireMs(s.when, now),
        nowMs: now,
        live: readLiveAccountFacts(s.account),
      })
      if (verdict.state !== 'ready' && (worst === null || rank[verdict.state] > rank[worst.state])) worst = verdict
    }
    if (worst === null) return
    const seat = await import('../../engine/connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    const sentence =
      worst.state === 'signed-out'
        ? 'signed out — /logins connects an account, or due fires hold'
        : worst.state === 'unreachable'
          ? 'no local server answering — start it (or set MERCURY_LOCAL_BASE_URL), or due fires hold'
          : worst.state === 'expired'
          ? 'sign-in expired — re-login now (/logins) or due fires hold'
          : worst.state === 'rate-limited'
            ? 'rate-limited — due fires hold until the window ends'
            : "the sign-in's known expiry lands before the next fire — re-login by then or it fires held"
    const count = schedules.length
    const { createSystemMessage } = await import('../../engine/message-shapes/systemMessages.js')
    connector.addDisplayRow(
      createSystemMessage(`${count} schedule${count === 1 ? '' : 's'} retained — ${sentence}`, 'warning'),
    )
  } catch (error) {
    passedOver(error)
  }
}

export async function waitForConnectorRecords(
  connector: { records(): readonly unknown[]; subscribeRecords(listener: () => void): () => void },
  limitMs = 3_000,
): Promise<boolean> {
  if (connector.records().length > 0) return true
  let unsubscribe: (() => void) | undefined
  const arrived = new Promise<boolean>(resolve => {
    unsubscribe = connector.subscribeRecords(() => {
      if (connector.records().length > 0) {
        unsubscribe?.()
        resolve(true)
      }
    })
    if (connector.records().length > 0) {
      unsubscribe()
      resolve(true)
    }
  })
  try {
    return await withDeadline(arrived, limitMs, () => false)
  } finally {
    unsubscribe?.()
  }
}

async function paintResumeRecap(sessionId: string, launchWon: Promise<LaunchWonV1 | null>): Promise<void> {
  try {
    const { isAwaySummaryEnabled, buildAwayRecap } = await import('../../screen/cockpit/awaySummary.js')
    if (!isAwaySummaryEnabled()) return
    const seat = await import('../../engine/connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    await waitForConnectorRecords(connector, 3_000)
    const records = [...connector.records()]
    if (records.length === 0) return
    let gitDelta: { files: number; added: number; removed: number } | null = null
    try {
      const { execFileNoThrowWithCwd } = await import('../../platform/processes/execFileNoThrow.js')
      const result = await execFileNoThrowWithCwd('git', ['diff', '--shortstat', 'HEAD'], { cwd: connector.workspace().cwd })
      const m = /(\d+) files? changed(?:, (\d+) insertions?...)?(?:, (\d+) deletions?...)?/.exec(result.stdout ?? '')
      if (m) gitDelta = { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) }
    } catch {
      gitDelta = null
    }
    const recap = buildAwayRecap(records, Date.now(), gitDelta)
    if (!recap) return
    const { readBranchHeadSync } = await import('../../screen/cockpit/branchHeadSync.js')
    const { healthCertSnapshot } = await import('../../platform/health/healthCertSnapshot.js')
    const branch = readBranchHeadSync(connector.workspace().cwd)
    const dirtyCount = gitDelta?.files
    const dirtyDelta =
      gitDelta && (gitDelta.added !== 0 || gitDelta.removed !== 0)
        ? `+${gitDelta.added}/-${gitDelta.removed}`
        : undefined
    const cert = healthCertSnapshot()
    const certFields =
      cert.state === 'off'
        ? {}
        : {
            certVerdict: cert.data.verdict ?? 'none',
            certAgeMs: cert.data.ageMs ?? undefined,
          }
    const won = await launchWon
    const { renderModelName } = await import('../../models/catalogue/engineModel.js')
    const enriched: AwayRecapMetadata = {
      endedOnError: recap.endedOnError,
      turns: recap.turns,
      filesTouched: recap.filesTouched,
      ...(recap.toolFailures > 0 ? { toolFailures: recap.toolFailures } : {}),
      topTools: recap.topTools,
      ...(recap.lastActiveGapMs !== undefined ? { lastActiveGapMs: recap.lastActiveGapMs } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(dirtyCount !== undefined ? { dirtyCount } : {}),
      ...(dirtyDelta !== undefined ? { dirtyDelta } : {}),
      ...certFields,
      ...(won !== null
        ? {
            launchWon: {
              ...(won.model !== undefined ? { model: { launch: renderModelName(won.model.launch), session: renderModelName(won.model.session) } } : {}),
              ...(won.effort !== undefined ? { effort: won.effort } : {}),
            },
          }
        : {}),
    }
    const { createAwaySummaryMessage } = await import('../../engine/message-shapes/systemMessages.js')
    let card = createAwaySummaryMessage(recap.line, enriched)
    let shown = recap
    connector.addDisplayRow(card)
    const settle = connector.subscribeRecords(() => {
      const painted = connector.records()
      const at = painted.lastIndexOf(card)
      if (at === -1 || painted.slice(at + 1).some(row => row.type === 'user' || row.type === 'assistant')) {
        settle()
        return
      }
      const now = buildAwayRecap(painted.slice(0, at), Date.now(), gitDelta)
      if (!now || (now.toolFailures === shown.toolFailures && now.endedOnError === shown.endedOnError)) return
      shown = now
      const { toolFailures: _shown, ...rest } = enriched
      card = createAwaySummaryMessage(now.line, { ...rest, endedOnError: now.endedOnError, ...(now.toolFailures > 0 ? { toolFailures: now.toolFailures } : {}) })
      connector.addDisplayRow(card)
    })
  } catch (error) {
    passedOver(error)
  }
}

function launchWonOf(
  launch: { model?: string; effort?: string },
  saved: { model?: string; effort?: string },
  admitted: { model?: string; effort?: string },
): LaunchWonV1 | null {
  const out: LaunchWonV1 = {}
  if (launch.model !== undefined && saved.model !== undefined && admitted.model !== undefined && admitted.model !== saved.model) {
    out.model = { launch: admitted.model, session: saved.model }
  }
  if (launch.effort !== undefined && saved.effort !== undefined && admitted.effort !== undefined && admitted.effort !== saved.effort) {
    out.effort = { launch: admitted.effort, session: saved.effort }
  }
  return out.model === undefined && out.effort === undefined ? null : out
}

async function notApplied<R>(call: () => Promise<R>): Promise<R | { state: 'failed'; detail: string }> {
  try {
    return await call()
  } catch (error) {
    return { state: 'failed', detail: errorMessage(error) }
  }
}

async function applyLaunchWordOnHop(sessionId: string, launch: LaunchWords, resumeWithLaunchWords: (() => Promise<unknown>) | null): Promise<void> {
  try {
    const seat = await import('../../engine/connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    const { renderModelName } = await import('../../models/catalogue/engineModel.js')
    const { daemonLastUnreachableAt } = await import('../control/controlSocket.js')
    const dialledAt = Date.now()
    const daemonWentAway = (): boolean => resumeWithLaunchWords !== null && daemonLastUnreachableAt() >= dialledAt
    const facts = connector.modelFacts()
    const parts: string[] = []
    let daemonLeft = false
    if (launch.model !== undefined && launch.model !== facts.effective) {
      const receipt = await notApplied(() => connector.setModel(launch.model as string))
      if (receipt.state === 'applied' || receipt.state === 'queued') {
        parts.push(`--model ${renderModelName(launch.model)} wins over the session's ${renderModelName(facts.effective)}${receipt.state === 'queued' ? ' when this turn settles' : ''}`)
      } else if (receipt.state === 'refused') {
        daemonLeft = daemonWentAway()
        if (!daemonLeft) parts.push(`--model ${renderModelName(launch.model)} was refused, the session keeps ${renderModelName(facts.effective)}: ${receipt.detail}`)
      } else if (receipt.state === 'failed') {
        daemonLeft = daemonWentAway()
        if (!daemonLeft) parts.push(`--model ${renderModelName(launch.model)} was not applied, the session keeps ${renderModelName(facts.effective)} (${receipt.detail})`)
      }
    }
    const sessionEffort = typeof facts.effort === 'string' ? facts.effort : undefined
    if (!daemonLeft && launch.effort !== undefined && launch.effort !== sessionEffort) {
      const receipt = await notApplied(() => connector.setEffort(launch.effort as string))
      if (receipt.state === 'applied' || receipt.state === 'queued') {
        parts.push(`--effort ${launch.effort} wins over the session's ${sessionEffort ?? 'own effort'}${receipt.state === 'queued' ? ' when this turn settles' : ''}`)
      } else if (receipt.state === 'refused') {
        daemonLeft = daemonWentAway()
        if (!daemonLeft) parts.push(`--effort ${launch.effort} was refused, the session keeps ${sessionEffort ?? 'its own effort'}: ${receipt.detail}`)
      } else if (receipt.state === 'failed') {
        daemonLeft = daemonWentAway()
        if (!daemonLeft) parts.push(`--effort ${launch.effort} was not applied, the session keeps ${sessionEffort ?? 'its own effort'} (${receipt.detail})`)
      }
    }
    for (const part of parts) mintImmediateReceipt(part)
    if (daemonLeft && resumeWithLaunchWords !== null && getFocusedSessionConnector().sessionId() === sessionId) await resumeWithLaunchWords()
  } catch (error) {
    passedOver(error)
  }
}
