import { statSync, mkdirSync } from 'node:fs'
import { validateUuid } from '../../platform/primitives/uuid.js'
import { normalizeEffortLevelString, EFFORT_LEVELS } from '../../models/effort/effort.js'
import type { GitInitRefusal } from '../../platform/files/projectBoundary.js'
import { readSessionFacts } from '../../engine/connector/seatProjections.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import type { LongLivedRespawnConfig } from '../roster/longLivedRespawn.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { inheritBuildNotices, carryClearModel } from '../switchboard/sessionReceipts.js'
import { type SessionKitV1, deriveSessionKitForPreset, deriveSessionKitForWorkspace, kitDeltasUnreadNote } from '../session-seat/sessionKit.js'
import { sessionKindOfAsker, type SessionKind } from './sessionKind.js'
import { type WorkspaceIsolation, type ConcourseMoveV1, canonicalWorkspaceId, resolveDefaultedAdmission } from './admission.js'
import { readSessionWorkers, unwrittenSessionRecordsRefusal } from './store.js'
import { reactivateConcourseSession } from './reactivate.js'
import type { ConcourseWorkerRecordV1 } from './record.js'
import { validateWorkerModelChoice, canonicalWorkerModelId } from '../../screen/concourse-model/workerModels.js'
import { refreshSignInReads, describeSignInRead } from '../session-seat/signInView.js'
import { isLocalModelId } from '../../models/roads/local/localCatalogue.js'
import { partiallySanitizeUnicode } from '../../platform/text/unicodeSanitization.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { resolveEffectiveSettingsSnapshot } from '../../platform/substrate/startupMenu.js'
import { seatInitialPermissionMode } from './spec.js'
import { resumeModelKeyOf, localModelNotServedNote } from './admitModel.js'
import { warmSeatAnswer } from './admitWarm.js'
import { coldRunnerIdOf, coldSpecOf, coldSeatAnswer } from './admitCold.js'
import { randomUUID } from '../../platform/primitives/crypto.js'
import { getProcessStartInstantAsync } from '../control/ownerWatch.js'
import { inspectWorkspaceKind, workspaceGitCheckNote, ensureWorkerWorktree } from './concourseWorktrees.js'
import { describeSeatReading } from '../switchboard-capacity/capacityCheck.js'
import { effectiveSeatCeiling } from './admission.js'
import { pidFieldsOf } from './marks.js'
import { startTimeout } from '../../platform/async/timers.js'

export interface WorkerRosterPort {
  has(short: string): { present: boolean; alive?: boolean }
  list(): ReadonlyArray<{ short: string; outcome?: unknown }>
  registerLongLived(
    short: string,
    spec: RunnerChildSpec,
    opts?: Partial<LongLivedRespawnConfig>,
    start?: { cwd: string; worktree?: string },
  ): { ok: boolean; pid?: number; error?: string }
  currentLongLivedModel?(short: string): string | undefined
}

export interface ConcourseAdmitDeps {
  roster: () => (WorkerRosterPort & { kill?(short: string): boolean }) | undefined
  dir?: string
  onSpawned?: (runnerId: string, spec: RunnerChildSpec, pid: number | undefined) => void
  claimWarm?: (args: {
    workspaceId: string
    sessionId: string
    modelKey: string
    effort: string
    permissionMode: string
    permissionModeTyped?: true
    bypassConsent: boolean
    kit: SessionKitV1
    resume?: true
    restartReason?: string
    title?: string
  }) => Promise<
    { claimed: true; short: string; pid?: number; spec: RunnerChildSpec } | { claimed: false; reason: string }
  >
  ensureWarm?: (workspaceDir: string, kit?: SessionKitV1, bypassConsent?: boolean) => void
}

export interface ConcourseAdmitRequest {
  workspaceDir: string
  isolation?: WorkspaceIsolation
  modelKey?: string
  effort?: string
  title?: string
  agentName?: string
  seatsMax?: 1 | 2
  resumeSessionId?: string
  permissionMode?: PermissionMode
  permissionModeTyped?: true
  runnerArgv?: string[]
  bornBlank?: boolean
  resumedAtRest?: true
  vacatingSessionId?: string
  birthKey?: string
  kit?: SessionKitV1
  kitPreset?: string
  bypassConsent?: true
  by?: string
  restartReason?: 'update'
}

export type ConcourseRefusalCode =
  | 'runtime-ceiling'
  | 'workspace-collision'
  | 'invalid-request'
  | 'not-ready'
  | 'spawn-failed'
  | 'no-repository'
  | 'git-unavailable'
  | 'unborn-head'

export type ConcourseAdmitResult =
  | {
      ok: true
      runnerId: string
      sessionId: string
      workspaceId: string
      pid?: number
      branchName?: string
      mainHolderTitle?: string
      modelId?: string
      modelDisplayName?: string
      note?: string
      effort?: string
      kitSource?: 'carried' | 'derived' | 'preset'
      presetName?: string
      presetNote?: string
      liveHop?: true
    }
  | {
      ok: false
      error: string
      code: ConcourseRefusalCode
      moves?: ConcourseMoveV1[]
      gitOfferRefused?: GitInitRefusal
    }

export interface AdmitSeat {
  req: ConcourseAdmitRequest
  deps: ConcourseAdmitDeps
  records: Record<string, ConcourseWorkerRecordV1>
  workspaceId: string
  effectiveIsolation: WorkspaceIsolation
  kind: SessionKind
  modelKey: string
  modelDisplayName: string
  keyless: boolean
  kit: SessionKitV1
  preset: { name: string; kit: SessionKitV1; note?: string } | undefined
  retainedNote: string | undefined
  carryBuildNotices: (sessionId: string) => void
}

export function makeConcourseAdmitHandler(
  deps: ConcourseAdmitDeps,
): (req: ConcourseAdmitRequest) => Promise<ConcourseAdmitResult> {
  return async req => {
    if (req.resumeSessionId !== undefined && validateUuid(req.resumeSessionId) === null) {
      return { ok: false, code: 'invalid-request', error: 'no live session record owns this id' }
    }
    if (req.effort !== undefined) {
      const level = normalizeEffortLevelString(req.effort)
      if (level === undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `effort refused ('${req.effort}' is not a valid level — the levels are ${EFFORT_LEVELS.join(' | ')})`,
        }
      }
      req = { ...req, effort: level }
    }
    const retainedModelKey =
      req.modelKey === undefined && req.resumeSessionId !== undefined
        ? resumeModelKeyOf(req.resumeSessionId, req.workspaceDir, deps.dir)
        : undefined
    refreshSignInReads(true)
    const validated = await validateWorkerModelChoice(req.modelKey ?? retainedModelKey, 'session')
    let admission = validated
    let retainedNote: string | undefined
    if (!validated.ok && req.modelKey === undefined && retainedModelKey !== undefined && validated.reason.startsWith('no-credential:')) {
      const unnamed = await validateWorkerModelChoice(undefined, 'session')
      if (unnamed.ok) {
        admission = unnamed
        retainedNote =
          unnamed.keyless === true
            ? `the session's model ${retainedModelKey} has no credential here — the first model send picks the neutral default; /model chooses`
            : `the session's model ${retainedModelKey} has no credential here — it continues on ${unnamed.entry.displayName} (the neutral default); /model chooses`
      }
    }
    const named = req.modelKey ?? retainedModelKey
    if (!admission.ok && admission.reason === 'unreachable:local' && named !== undefined && isLocalModelId(named) && sessionKindOfAsker(req.by) === 'oculus') {
      const id = await canonicalWorkerModelId(named)
      const arm = { availability: 'refused' as const, refusal: 'unreachable:local' as const, ...(admission.detail !== undefined ? { detail: admission.detail } : {}), ...(admission.action !== undefined ? { action: admission.action } : {}) }
      admission = { ok: true, entry: { modelId: id, displayName: id, session: arm, crew: arm } }
      retainedNote = localModelNotServedNote(id)
    }
    if (!admission.ok) {
      const read = admission.reason.startsWith('no-credential:') ? ` — ${describeSignInRead(admission.reason.slice('no-credential:'.length))}` : ''
      const error = `model refused (${admission.reason})${admission.action !== undefined ? ` · ${admission.action}` : ''}${admission.detail !== undefined ? ` — ${admission.detail}` : ''}${read} (got ${JSON.stringify(req.modelKey ?? retainedModelKey ?? '(unset → registry default)')}${retainedModelKey !== undefined && req.modelKey === undefined ? ' — the model this session ran on; --model picks another' : ''})`
      console.error(`[daemon] admission refused: ${error}`)
      return { ok: false, code: 'invalid-request', error }
    }
    const modelKey = admission.entry.modelId
    const modelDisplayName = admission.entry.displayName
    const keyless = admission.keyless === true
    if (keyless && admission.note !== undefined && retainedNote === undefined) retainedNote = admission.note
    let stat
    try {
      stat = statSync(req.workspaceDir)
    } catch {
      return { ok: false, code: 'invalid-request', error: `workspace does not exist: ${req.workspaceDir}` }
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'invalid-request', error: `workspace is not a directory: ${req.workspaceDir}` }
    }
    const roster = deps.roster()
    if (!roster) return { ok: false, code: 'not-ready', error: 'daemon roster not ready' }

    const kind = sessionKindOfAsker(req.by)
    const workspaceId = canonicalWorkspaceId(req.workspaceDir)
    let preset: { name: string; kit: SessionKitV1; note?: string } | undefined
    if (req.kitPreset !== undefined) {
      if (req.kit !== undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `kit and kitPreset are one door — send one (got a carried kit beside preset '${req.kitPreset.slice(0, 64)}')`,
        }
      }
      const derived = deriveSessionKitForPreset(req.kitPreset, workspaceId)
      if (!derived.ok) return { ok: false, code: 'invalid-request', error: derived.reason }
      preset = { name: req.kitPreset, kit: derived.kit, ...(derived.note !== undefined ? { note: derived.note } : {}) }
    }
    const unwritten = unwrittenSessionRecordsRefusal(deps.dir)
    if (unwritten !== null) return { ok: false, code: 'not-ready', error: `no session was started: ${unwritten.message}` }
    const records = readSessionWorkers(deps.dir)
    const liveShorts = new Set(roster.list().filter(j => !j.outcome).map(j => j.short))
    const liveWorkers = Object.values(records).filter(
      r => r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined),
    )
    if (req.birthKey !== undefined) {
      const born = Object.values(records).find(r => r.birthKey === req.birthKey && r.endedAt === undefined && r.workspaceId === workspaceId)
      if (born !== undefined) {
        console.error(`[daemon] admission replayed: ${born.runnerId} already holds session ${born.sessionId} for this birth`)
        return {
          ok: true,
          ...(retainedNote !== undefined ? { note: retainedNote } : {}),
          runnerId: born.runnerId,
          sessionId: born.sessionId,
          workspaceId: born.workspaceId,
          modelId: born.modelKey,
          modelDisplayName,
          effort: born.effort ?? 'high',
          kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
          ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
          ...(born.pid !== undefined ? { pid: born.pid } : {}),
          ...(born.branchName !== undefined ? { branchName: born.branchName } : {}),
        }
      }
    }
    if (req.resumeSessionId !== undefined) {
      const standing = Object.values(records).find(r => r.sessionId === req.resumeSessionId && r.endedAt === undefined)
      if (standing !== undefined) {
        const others = liveWorkers
          .filter(r => r.runnerId !== standing.runnerId)
          .map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation, ...(r.title !== undefined ? { title: r.title } : {}) }))
        const reactivated = await reactivateConcourseSession(
          standing,
          {
            modelKey,
            modelDisplayName,
            ...(keyless ? { keyless: true } : {}),
            ...(req.effort !== undefined ? { effort: req.effort } : {}),
            ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
            ...(req.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
            ...(req.runnerArgv !== undefined && req.runnerArgv.length > 0 ? { runnerArgv: req.runnerArgv } : {}),
            ...(req.bypassConsent === true ? { bypassConsent: true as const } : {}),
            ...(req.kit !== undefined ? { kit: req.kit } : {}),
            ...(preset !== undefined ? { preset } : {}),
            by: 'operator',
            kind,
            ...(req.restartReason === 'update' ? { restartReason: 'update' as const } : {}),
            ...(req.resumedAtRest === true ? { atRest: true as const } : {}),
          },
          others,
          deps,
        )
        return reactivated.ok && retainedNote !== undefined
          ? { ...reactivated, note: reactivated.note !== undefined ? `${retainedNote} — ${reactivated.note}` : retainedNote }
          : reactivated
      }
    }
    const admissionClaims = liveWorkers.filter(
      r => req.vacatingSessionId === undefined || r.sessionId !== req.vacatingSessionId,
    )
    const resolution = resolveDefaultedAdmission(
      admissionClaims.map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation, ...(r.title !== undefined ? { title: r.title } : {}) })),
      { workspaceId, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}) },
    )
    if (resolution.kind === 'git-offer') {
      return { ok: false, code: resolution.code, error: resolution.error, moves: resolution.moves }
    }
    const { decision } = resolution
    const effectiveIsolation = resolution.effectiveIsolation
    if (!decision.admit)
      return {
        ok: false,
        code: decision.code,
        error: decision.reason,
        ...(decision.moves !== undefined ? { moves: decision.moves } : {}),
        ...(resolution.gitOfferRefused !== undefined ? { gitOfferRefused: resolution.gitOfferRefused } : {}),
      }

    const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)
    if (kit.deltasReadError !== undefined) {
      const kitNote = kitDeltasUnreadNote(kit.deltasReadError)
      retainedNote = retainedNote !== undefined ? `${retainedNote} — ${kitNote}` : kitNote
    }
    const inspectedKind = inspectWorkspaceKind(workspaceId)
    if (inspectedKind.kind === 'plain-folder' && inspectedKind.gitCheckError !== undefined) {
      const gitNote = workspaceGitCheckNote(workspaceId, inspectedKind.gitCheckError)
      retainedNote = retainedNote !== undefined ? `${retainedNote} — ${gitNote}` : gitNote
    }
    const carryBuildNotices = (sessionId: string): void => {
      if (req.vacatingSessionId === undefined) return
      const previous = Object.values(records).find(row => row.sessionId === req.vacatingSessionId && row.workspaceId === workspaceId)
      if (previous === undefined) return
      const home = getProjectDir(workspaceId)
      mkdirSync(home, { recursive: true })
      inheritBuildNotices(home, sessionId, req.vacatingSessionId)
      const facts = readSessionFacts(previous.sessionId, deps.dir)
      carryClearModel(home, sessionId, previous.sessionId, facts?.model.setting ?? previous.modelKey)
    }
    const seat: AdmitSeat = { req, deps, records, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, keyless, kit, preset, retainedNote, carryBuildNotices }
    if (
      deps.claimWarm !== undefined &&
      kind === 'oculus' &&
      !keyless &&
      req.resumeSessionId === undefined &&
      (effectiveIsolation === 'exclusive' || effectiveIsolation === 'shared') &&
      (req.runnerArgv === undefined || req.runnerArgv.length === 0)
    ) {
      const claimSessionId = randomUUID()
      carryBuildNotices(claimSessionId)
      const claimEffort = req.effort ?? 'high'
      const claimPosture = seatInitialPermissionMode(req.permissionMode)
      const claimStartedAt = Date.now()
      const claimed = await deps.claimWarm({
        workspaceId,
        sessionId: claimSessionId,
        modelKey,
        effort: claimEffort,
        permissionMode: claimPosture,
        ...(req.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
        bypassConsent: req.bypassConsent === true,
        kit,
        ...(req.title !== undefined && req.title.length > 0 ? { title: partiallySanitizeUnicode(req.title).slice(0, 120) } : {}),
      })
      if (claimed.claimed) {
        console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes session ${claimSessionId}`)
        const runnerId = claimed.short
        const snapshot = resolveEffectiveSettingsSnapshot({ sessionId: claimSessionId })
        const pidFields = pidFieldsOf(claimed.pid, claimed.pid === undefined ? null : await getProcessStartInstantAsync(claimed.pid))
        return warmSeatAnswer({ ...seat, runnerId, claimSessionId, claimEffort, claimPosture, snapshot, pidFields, claimed })
      }
      logForDebugging(`[daemon] warm claim declined (${claimed.reason}) — spawning cold`)
      if (deps.ensureWarm !== undefined) {
        const rewarm = startTimeout(() => deps.ensureWarm!(workspaceId, kit, req.bypassConsent === true), 0)
        rewarm.unref?.()
      }
    }

    const runnerId = coldRunnerIdOf(records, roster)
    if (runnerId === null) {
      return { ok: false, code: 'runtime-ceiling', error: `at the live-session limit — ${describeSeatReading(effectiveSeatCeiling())}` }
    }

    const sessionId = req.resumeSessionId ?? randomUUID()
    const workspaceKind = inspectedKind.kind
    let workerCwd = workspaceId
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    if (effectiveIsolation === 'worktree-isolated') {
      const wt = await ensureWorkerWorktree(workspaceId, runnerId, deps.dir, {
        branchName: mintWorktreeBranchName(req.title ?? sessionId.slice(0, 8), records),
      })
      if (!wt.ok) {
        if (wt.code === 'no-repository' || wt.code === 'unborn-head') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'init-git', label: 'say yes to the git offer — then it forks on its own' }],
          }
        }
        if (wt.code === 'git-unavailable') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'retry', label: 'install git, then retry the launch' }],
          }
        }
        return { ok: false, code: 'invalid-request', error: wt.error }
      }
      workerCwd = wt.path
      worktreePath = wt.path
      worktreeBranch = wt.branchName
    }
    const { snapshot, effort, runnerArgv, spec } = coldSpecOf({ req, records, workspaceId, sessionId, runnerId, worktreePath, workerCwd, modelKey, keyless, kit, kind })
    carryBuildNotices(sessionId)
    const reg = roster.registerLongLived(runnerId, spec)
    if (!reg.ok) return { ok: false, code: 'spawn-failed', error: reg.error ?? 'registerLongLived refused' }
    const pidFields = pidFieldsOf(reg.pid, reg.pid === undefined ? null : await getProcessStartInstantAsync(reg.pid))
    return coldSeatAnswer({ ...seat, liveWorkers, runnerId, sessionId, workspaceKind, worktreePath, worktreeBranch, snapshot, effort, runnerArgv, spec, reg, pidFields })
  }
}

function mintWorktreeBranchName(
  seed: string,
  records: Record<string, ConcourseWorkerRecordV1>,
): string {
  const slug =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'session'
  const taken = new Set(
    Object.values(records)
      .map(r => r.branchName)
      .filter((b): b is string => b !== undefined),
  )
  const base = `mercury/${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; n <= 9; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}
