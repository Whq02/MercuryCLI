import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { AwayRecapMetadata } from '../../types/message.js'
import { withLanding } from '../engine-connector/focusedConnector.js'
import { bootBirthFacts, carriedConsentOf, carriedKitOf, peekWornPresetKit, takeWornPresetKit } from './bootBirthFacts.js'
import { mintImmediateReceipt } from '../../utils/model/seatReceipts.js'

export function liveTitleDeriverFor(
  supervisor: {
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
      const mtime = statSync(supervisor.concourseWorkersPath()).mtimeMs
      if (mtime !== recordsMtime) {
        recordsMtime = mtime
        titlesBySession = new Map()
        for (const rec of Object.values(supervisor.readSessionWorkers())) titlesBySession.set(rec.sessionId, rec.title)
      }
    } catch {
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

export type HopOutcome =
  | { ok: true; title: string }
  | { ok: false; reason: string }

export function hopIntoBoardSession(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  return withLanding(hopIntoBoardSessionLanding(sessionId, opts))
}

async function hopIntoBoardSessionLanding(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (!rec) return { ok: false, reason: 'no live session record owns this id' }
  const paths = await import('../../utils/sessionStorage/paths.js')
  const seat = await import('../engine-connector/daemonConnector.js')
  const { sessionTitleOf } = await import('../concourse/sessionNaming.js')
  const { headBriefLabel } = await import('../concourse/concourseSnapshot.js')
  const title = sessionTitleOf(rec, () => headBriefLabel(rec, 48))
  seat.registerLiveTitleDeriver(liveTitleDeriverFor(supervisor, sessionTitleOf, headBriefLabel))
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
  })
  await Promise.race([hop, new Promise<void>(r => setTimeout(r, opts?.firstPaintMs ?? 250))])
  void withLanding(hop.then(() => undefined)).catch(() => {})
  void import('./ensureDaemon.js')
    .then(m => m.ensureOwnedDaemon())
    .catch(() => {})
  return { ok: true, title }
}

export type ResumeOutcome = HopOutcome & {
  admitted: Promise<boolean>
  refusal: Promise<string | null>
}

export function composeNoRunnerLine(title: string, reason: string): string {
  const plain = /not ready/i.test(reason) ? 'the daemon is starting' : reason
  return `${title}: the session has no live runner — a replay revives it and delivers into the same chat · ${plain} · ↵ revives it`
}

async function workspaceOfTranscript(transcriptPath: string | undefined): Promise<string> {
  if (transcriptPath !== undefined) {
    try {
      const { open } = await import('node:fs/promises')
      const fh = await open(transcriptPath, 'r')
      let head: string
      try {
        const buf = Buffer.alloc(8192)
        const { bytesRead } = await fh.read(buf, 0, 8192, 0)
        head = buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
      if (m) return JSON.parse(`"${m[1]}"`) as string
    } catch {
    }
  }
  const { getCwd } = await import('../../utils/cwd.js')
  return getCwd()
}

export function focusResumedSession(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: { title?: string; firstPaintMs?: number; permissionMode?: string },
): Promise<ResumeOutcome> {
  return withLanding(focusResumedSessionLanding(sessionId, transcriptPath, opts))
}

async function focusResumedSessionLanding(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: { title?: string; firstPaintMs?: number; permissionMode?: string },
): Promise<ResumeOutcome> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  if (supervisor.sessionOwnedByLiveWorker(sessionId) !== null) {
    const hop = await hopIntoBoardSession(sessionId, opts)
    return { ...hop, admitted: Promise.resolve(hop.ok), refusal: Promise.resolve(hop.ok ? null : hop.reason) }
  }
  const standing = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  const workspaceDir = standing?.workspaceId ?? (await workspaceOfTranscript(transcriptPath))
  const paths = await import('../../utils/sessionStorage/paths.js')
  const seat = await import('../engine-connector/daemonConnector.js')
  const { headBriefLabel } = await import('../concourse/concourseSnapshot.js')
  const title = opts?.title ?? standing?.title ?? headBriefLabel({ sessionId, workspaceId: workspaceDir }, 48) ?? sessionId.slice(0, 8)
  const connector = seat.daemonSessionConnectorFor({
    sessionId,
    runnerId: standing?.runnerId ?? '',
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
    ...(standing?.modelKey !== undefined ? { modelKey: standing.modelKey } : {}),
    ...(standing?.effort !== undefined ? { effort: standing.effort } : {}),
    ...(standing?.worktreePath !== undefined ? { worktreePath: standing.worktreePath } : {}),
  })
  const refusal = (async (): Promise<string | null> => {
    try {
      const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) return 'the daemon did not start'
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const worn = peekWornPresetKit()
      const reply = (await daemonControlRpc(
        { op: 'sessionAdmit', workspaceDir, resumeSessionId: sessionId, isolation: 'shared', ...((): Record<string, string> => { const mode = opts?.permissionMode ?? bootBirthFacts().permissionMode ?? undefined; return mode !== undefined ? { permissionMode: mode } : {} })(), ...carriedConsentOf(bootBirthFacts()), ...(worn !== null ? { kit: worn.kit } : carriedKitOf(bootBirthFacts())) } as never,
        { timeoutMs: 60_000 },
      )) as Record<string, unknown>
      if (reply.ok !== true) return typeof reply.error === 'string' && reply.error !== '' ? reply.error : 'the daemon refused the resume'
      if (typeof reply.note === 'string' && reply.note !== '') mintImmediateReceipt(`▲ ${reply.note}`, 'warning')
      if (worn !== null && reply.liveHop !== true) takeWornPresetKit()
      const settled = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
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
      })
      connector.assertSeat()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  connector.awaitAdmission(refusal)
  const admitted = refusal.then(r => r === null)
  const pointed = seat.focusDaemonSession(connector.record)
  await Promise.race([pointed, new Promise<void>(r => setTimeout(r, opts?.firstPaintMs ?? 250))])
  void withLanding(pointed.then(() => undefined)).catch(() => {})
  void paintResumeRecap(sessionId)
  void paintReactivationScheduleWarn(sessionId)
  return { ok: true, title, admitted, refusal }
}

export type CloseOutcome =
  | { ok: true; closed: boolean; sessionId: string | null; fate: 'parked' | 'draining' | 'released' | 'ended' | 'none' }
  | { ok: false; reason: string }

export async function closeFocusedChat(opts: { fate: 'park' | 'end' }): Promise<CloseOutcome> {
  const slot = await import('../engine-connector/focusedConnector.js')
  if (!slot.hasFocusedSession()) return { ok: true, closed: false, sessionId: null, fate: 'none' }
  const sessionId = slot.getFocusedSessionConnector().sessionId()
  let fate: Extract<CloseOutcome, { ok: true }>['fate'] = 'none'
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (rec !== undefined) {
    try {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      if (opts.fate === 'end') {
        await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId, by: 'operator' } as never, { timeoutMs: 15_000 })
        const released = (await daemonControlRpc({ op: 'sessionRelease', runnerId: rec.runnerId } as never, { timeoutMs: 15_000 })) as { ok?: boolean; settled?: boolean }
        if (released.ok === true && released.settled !== false) fate = 'ended'
      } else {
        const parked = (await daemonControlRpc(
          { op: 'sessionControl', action: 'park', sessionId, by: `operator:${process.pid}` } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; outcome?: string; detail?: string }
        if (parked.ok === true) {
          fate = parked.outcome === 'draining' ? 'draining' : parked.outcome === 'applied' && (parked.detail ?? '').startsWith('released') ? 'released' : parked.outcome === 'applied' || parked.outcome === 'noop' ? 'parked' : 'none'
        }
      }
    } catch {
    }
  }
  slot.releaseFocusedSessionConnector()
  return { ok: true, closed: true, sessionId, fate }
}

export async function clearFocusedSession(): Promise<{ ok: true; cleared: boolean } | { ok: false; reason: string }> {
  const slot = await import('../engine-connector/focusedConnector.js')
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
    return { ok: false, reason: `a fresh session could not start, so this one stands — ${born.reason}` }
  }
  await parkSessionById(oldSessionId)
  const { markSessionCleared } = await import('../../utils/sessionStorage/clearedSessions.js')
  markSessionCleared(oldSessionId)
  return { ok: true, cleared: true }
}

async function parkSessionById(sessionId: string): Promise<void> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (rec === undefined) return
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    await daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId, by: `operator:${process.pid}` } as never, { timeoutMs: 15_000 })
  } catch {
  }
}

async function paintReactivationScheduleWarn(sessionId: string): Promise<void> {
  try {
    const supervisor = await import('../../daemon/concourseSupervisor.js')
    const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    const schedules = rec?.schedules ?? []
    if (schedules.length === 0) return
    const { saturnNextFireMs } = await import('../../daemon/saturn.js')
    const { readLiveAccountFacts, scheduleAccountVerdict } = await import('../../daemon/saturnAccount.js')
    const now = Date.now()
    const rank = { 'signed-out': 4, unreachable: 4, expired: 3, 'rate-limited': 2, expiring: 1, ready: 0 } as const
    let worst: import('../../daemon/saturn.js').ScheduleAccountVerdictV1 | null = null
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
    const seat = await import('../engine-connector/daemonConnector.js')
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
    const { createSystemMessage } = await import('../../utils/messages/systemMessages.js')
    connector.addDisplayRow(
      createSystemMessage(`${count} schedule${count === 1 ? '' : 's'} retained — ${sentence}`, 'warning') as never,
    )
  } catch {
  }
}

async function paintResumeRecap(sessionId: string): Promise<void> {
  try {
    const { isAwaySummaryEnabled, buildAwayRecap } = await import('../../utils/cockpit/awaySummary.js')
    if (!isAwaySummaryEnabled()) return
    const seat = await import('../engine-connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    const t0 = Date.now()
    while (Date.now() - t0 < 3000 && connector.records().length === 0) {
      await new Promise(r => setTimeout(r, 100))
    }
    const records = [...connector.records()]
    if (records.length === 0) return
    let gitDelta: { files: number; added: number; removed: number } | null = null
    try {
      const { execFileNoThrowWithCwd } = await import('../../utils/execFileNoThrow.js')
      const result = await execFileNoThrowWithCwd('git', ['diff', '--shortstat', 'HEAD'], { cwd: connector.workspace().cwd })
      const m = /(\d+) files? changed(?:, (\d+) insertions?...)?(?:, (\d+) deletions?...)?/.exec(result.stdout ?? '')
      if (m) gitDelta = { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) }
    } catch {
      gitDelta = null
    }
    const recap = buildAwayRecap(records, Date.now(), gitDelta)
    if (!recap) return
    const { readBranchHeadSync } = await import('../../utils/cockpit/branchHeadSync.js')
    const { healthCertSnapshot } = await import('../../utils/cockpit/healthCertSnapshot.js')
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
    }
    const { createAwaySummaryMessage } = await import('../../utils/messages/systemMessages.js')
    connector.addDisplayRow(createAwaySummaryMessage(recap.line, enriched) as never)
  } catch {
  }
}
