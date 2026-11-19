import { existsSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { randomUUID } from '../../utils/crypto.js'
import { validateUuid } from '../../utils/uuid.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { sessionModelOfEntry, servedModelOfAssistantRow, billingSafeRetainedForm } from '../../utils/model/retainedModel.js'
import { logForDebugging } from '../../utils/debug.js'
import type { GitInitRefusal } from '../../utils/projectBoundary.js'
import { resolveEffectiveSettingsSnapshot } from '../../substrate/startupMenu.js'
import { getProcessStartInstantAsync } from '../ownerWatch.js'
import { workspaceKindOf, ensureWorkerWorktree } from '../concourseWorktrees.js'
import { validateWorkerModelChoice, canonicalWorkerModelId } from '../../services/concourse/workerModels.js'
import { refreshSignInReads, describeSignInRead } from '../signInView.js'
import { describeSeatReading } from '../../services/switchboard/capacityCheck.js'
import { readSessionFacts } from '../../services/engine-connector/seatProjections.js'
import type { RunnerChildSpec } from '../headlessRun.js'
import type { LongLivedRespawnConfig } from '../longLivedRespawn.js'
import type { PermissionMode } from '../../types/permissions.js'
import { normalizeEffortLevelString, EFFORT_LEVELS } from '../../utils/effort.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../../utils/sessionStorage/transcriptReader.js'
import { inheritBuildNotices, carryClearModel } from '../../services/switchboard/sessionReceipts.js'
import { type SessionKitV1, deriveSessionKitForPreset, deriveSessionKitForWorkspace, kitStampOf, noteRecordlessResumeKit } from '../sessionKit.js'
import { sessionKindOfAsker } from '../../utils/sessionKind.js'
import { localWireId, isLocalModelId } from '../../services/providers/local/localCatalogue.js'
import { rememberedTensorFoldRepos } from '../../services/providers/local/tensorfoldHosts.js'
import { tensorFoldShortName } from '../../services/tensorfold/starting.js'
import { type WorkspaceIsolation, type ConcourseMoveV1, canonicalWorkspaceId, resolveDefaultedAdmission, CONCOURSE_SHORT_PREFIX, effectiveSeatCeiling } from './admission.js'
import { readSessionWorkers, updateConcourseWorkers } from './store.js'
import { reactivateConcourseSession } from './reactivate.js'
import { seatInitialPermissionMode, buildConcourseWorkerSpec, spawnPostureOf } from './spec.js'
import { pidFieldsOf, buildTreeFields } from './marks.js'
import { migrateTranscriptHomeToLaw } from './revive.js'
import type { ConcourseWorkerRecordV1 } from './record.js'

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

export function resumeModelKeyOf(sessionId: string, workspaceDir: string, dir?: string): string | undefined {
  const fromRecord = Object.values(readSessionWorkers(dir))
    .filter(r => r.sessionId === sessionId && r.modelKey !== undefined && r.keyless !== true)
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.modelKey
  if (fromRecord !== undefined) return fromRecord
  let workspaceId = workspaceDir
  try {
    workspaceId = canonicalWorkspaceId(workspaceDir)
  } catch {
  }
  const transcript = join(getProjectDir(workspaceId), `${sessionId}.jsonl`)
  if (!existsSync(transcript)) return undefined
  let retained: string | undefined
  try {
    scanTranscriptLinesBackward(transcript, line => {
      if (!line.includes('assistant') && !line.includes('output') && !line.includes('"metaKind":"model"')) return
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        const entry = (
          typeof row.recordId === 'string' && row.payload !== undefined
            ? (recordToEntry(row as never) as Record<string, unknown>)
            : row
        ) as { type?: string; model?: unknown; message?: { model?: unknown } }
        const chosen = sessionModelOfEntry(entry)
        if (chosen !== undefined) {
          retained = chosen
          return true
        }
        const served = servedModelOfAssistantRow(entry)
        if (served !== undefined) {
          retained = billingSafeRetainedForm(served)
          return true
        }
      } catch {
      }
      return
    })
  } catch {
  }
  return retained
}

export function localModelNotServedNote(id: string): string {
  const wire = localWireId(id).toLowerCase()
  const servedHere = rememberedTensorFoldRepos().some(repo => tensorFoldShortName(repo).toLowerCase() === wire)
  return `${id} is not being served — ${servedHere ? '/tensorfold serves it again' : 'start a local server, or set MERCURY_LOCAL_BASE_URL'} · /model chooses another`
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
        return reactivated.ok && retainedNote !== undefined ? { ...reactivated, note: retainedNote } : reactivated
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
        bypassConsent: req.bypassConsent === true,
        kit,
        ...(req.title !== undefined && req.title.length > 0 ? { title: partiallySanitizeUnicode(req.title).slice(0, 120) } : {}),
      })
      if (claimed.claimed) {
        console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes session ${claimSessionId}`)
        const runnerId = claimed.short
        const snapshot = resolveEffectiveSettingsSnapshot({ sessionId: claimSessionId })
        const pidFields = pidFieldsOf(claimed.pid, claimed.pid === undefined ? null : await getProcessStartInstantAsync(claimed.pid))
        updateConcourseWorkers(workers => {
          workers[runnerId] = {
            schema: 1,
            runnerId,
            sessionId: claimSessionId,
            workspaceId,
            isolation: effectiveIsolation,
            modelKey,
            effort: claimEffort,
            ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
              ? { agentName: req.agentName.trim().slice(0, 24) }
              : {}),
            ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
            spawnedAt: Date.now(),
            lastLiveAt: Date.now(),
            ...pidFields,
            ...buildTreeFields(),
            settingsSnapshot: snapshot,
            workspaceKind: workspaceKindOf(workspaceId),
            ...(req.title !== undefined ? { title: partiallySanitizeUnicode(req.title) } : {}),
            ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
            ...(req.resumedAtRest === true ? { resumedAtRestAt: Date.now() } : {}),
            ...(req.birthKey !== undefined ? { birthKey: req.birthKey } : {}),
            ...kitStampOf(kit),
            permissionMode: claimPosture,
            ...(req.bypassConsent === true ? { bypassConsent: true as const } : {}),
            kind,
          }
        }, deps.dir)
        deps.onSpawned?.(runnerId, claimed.spec, claimed.pid)
        if (deps.ensureWarm !== undefined) {
          const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit, req.bypassConsent === true), 0)
          rewarm.unref?.()
        }
        return {
          ok: true,
          ...(retainedNote !== undefined ? { note: retainedNote } : {}),
          runnerId,
          sessionId: claimSessionId,
          workspaceId,
          modelId: modelKey,
          modelDisplayName,
          effort: claimEffort,
          kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
          ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
          ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
        }
      }
      logForDebugging(`[daemon] warm claim declined (${claimed.reason}) — spawning cold`)
      if (deps.ensureWarm !== undefined) {
        const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit, req.bypassConsent === true), 0)
        rewarm.unref?.()
      }
    }

    const used = new Set(
      Object.values(records)
        .filter(r => r.endedAt === undefined)
        .map(r => r.runnerId),
    )
    let runnerId: string | null = null
    for (let n = 1; n <= used.size + 4096; n++) {
      const candidate = `${CONCOURSE_SHORT_PREFIX}${n}`
      if (!used.has(candidate) && !roster.has(candidate).present) {
        runnerId = candidate
        break
      }
    }
    if (runnerId === null) {
      return { ok: false, code: 'runtime-ceiling', error: `at the live-session limit — ${describeSeatReading(effectiveSeatCeiling())}` }
    }

    const sessionId = req.resumeSessionId ?? randomUUID()
    const workspaceKind = workspaceKindOf(workspaceId)
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
    const priorSnapshot =
      req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.settingsSnapshot !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.settingsSnapshot
        : undefined
    const snapshot = priorSnapshot ?? resolveEffectiveSettingsSnapshot({ sessionId })
    const effort =
      req.effort ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.effort !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.effort
        : undefined) ??
      (() => {
        if (req.resumeSessionId === undefined) return undefined
        let saved: string | undefined
        try {
          scanTranscriptLinesBackward(join(getProjectDir(workspaceId), `${req.resumeSessionId}.jsonl`), line => {
            if (!line.includes('effort')) return
            try {
              const row = JSON.parse(line) as Record<string, unknown>
              const entry = (typeof row.recordId === 'string' && row.payload !== undefined ? recordToEntry(row as never) : row) as { type?: string; effort?: { asked?: unknown } }
              if (entry.type !== 'assistant' || typeof entry.effort?.asked !== 'string') return
              const level = normalizeEffortLevelString(entry.effort.asked)
              if (level === undefined) return
              saved = level
              return true
            } catch {}
          })
        } catch {}
        return saved
      })() ??
      'high'
    if (req.resumeSessionId !== undefined && worktreePath !== undefined) {
      migrateTranscriptHomeToLaw({ sessionId, workspaceId, worktreePath })
    }
    const runnerArgv =
      req.runnerArgv ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.runnerArgv !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.runnerArgv
        : undefined)
    const spec = buildConcourseWorkerSpec({
      runnerId,
      sessionId,
      workspaceId,
      modelKey,
      ...(keyless ? { keyless: true } : {}),
      effort,
      cwd: workerCwd,
      kit,
      ...(req.title !== undefined ? { title: partiallySanitizeUnicode(req.title) } : {}),
      ...(req.resumeSessionId !== undefined ? { resume: true } : {}),
      ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
      ...(req.bypassConsent === true ? { bypassConsent: true as const } : {}),
      ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv } : {}),
      kind,
    })
    carryBuildNotices(sessionId)
    const reg = roster.registerLongLived(runnerId, spec)
    if (!reg.ok) return { ok: false, code: 'spawn-failed', error: reg.error ?? 'registerLongLived refused' }
    const pidFields = pidFieldsOf(reg.pid, reg.pid === undefined ? null : await getProcessStartInstantAsync(reg.pid))
    updateConcourseWorkers(workers => {
      workers[runnerId!] = {
        schema: 1,
        runnerId: runnerId!,
        sessionId,
        workspaceId,
        isolation: effectiveIsolation,
        modelKey,
        effort,
        ...(keyless ? { keyless: true } : {}),
        ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
          ? { agentName: req.agentName.trim().slice(0, 24) }
          : {}),
        ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
        spawnedAt: Date.now(),
        lastLiveAt: Date.now(),
        ...pidFields,
        ...buildTreeFields(),
        settingsSnapshot: snapshot,
        workspaceKind,
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
        ...(req.title !== undefined ? { title: partiallySanitizeUnicode(req.title) } : {}),
        ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv: [...runnerArgv] } : {}),
        ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
        ...(req.resumedAtRest === true ? { resumedAtRestAt: Date.now() } : {}),
        ...(req.birthKey !== undefined ? { birthKey: req.birthKey } : {}),
        ...spawnPostureOf(spec),
        ...kitStampOf(kit),
      }
    }, deps.dir)
    if (req.resumeSessionId !== undefined) {
      noteRecordlessResumeKit({ workspaceId, sessionId }, kit, req.kit !== undefined ? 'carried' : 'derived', 'daemon:admit')
    }
    deps.onSpawned?.(runnerId, spec, reg.pid)
    const mainHolderTitle =
      worktreeBranch !== undefined
        ? liveWorkers.find(
            r => r.workspaceId === workspaceId && ['exclusive', 'shared'].includes(r.isolation ?? 'exclusive'),
          )?.title
        : undefined
    return {
      ok: true,
      ...(retainedNote !== undefined ? { note: retainedNote } : {}),
      runnerId,
      sessionId,
      workspaceId,
      modelId: modelKey,
      modelDisplayName,
      effort,
      kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
      ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
      ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
      ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
      ...(mainHolderTitle !== undefined ? { mainHolderTitle } : {}),
    }
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
