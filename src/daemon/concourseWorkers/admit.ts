import { statSync, mkdirSync } from 'node:fs'
import { validateUuid } from '../../utils/uuid.js'
import { normalizeEffortLevelString, EFFORT_LEVELS } from '../../utils/effort.js'
import type { GitInitRefusal } from '../../utils/projectBoundary.js'
import { readSessionFacts } from '../../services/engine-connector/seatProjections.js'
import type { RunnerChildSpec } from '../headlessRun.js'
import type { LongLivedRespawnConfig } from '../longLivedRespawn.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { inheritBuildNotices, carryClearModel } from '../../services/switchboard/sessionReceipts.js'
import { type SessionKitV1, deriveSessionKitForPreset, deriveSessionKitForWorkspace } from '../sessionKit.js'
import { sessionKindOfAsker, type SessionKind } from '../../utils/sessionKind.js'
import { type WorkspaceIsolation, type ConcourseMoveV1, canonicalWorkspaceId, resolveDefaultedAdmission } from './admission.js'
import { readSessionWorkers } from './store.js'
import { reactivateConcourseSession } from './reactivate.js'
import type { ConcourseWorkerRecordV1 } from './record.js'
import { admitModelOf } from './admitModel.js'
import { admitWarm } from './admitWarm.js'
import { admitCold } from './admitCold.js'

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
    const model = await admitModelOf(req, deps)
    if ('ok' in model) return model
    const { retainedNote, modelKey, modelDisplayName, keyless } = model
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
    const seat: AdmitSeat = { req, deps, records, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, keyless, kit, preset, retainedNote, carryBuildNotices }
    if (
      deps.claimWarm !== undefined &&
      kind === 'oculus' &&
      !keyless &&
      req.resumeSessionId === undefined &&
      (effectiveIsolation === 'exclusive' || effectiveIsolation === 'shared') &&
      (req.runnerArgv === undefined || req.runnerArgv.length === 0)
    ) {
      const warm = await admitWarm(seat)
      if (warm !== undefined) return warm
    }

    return admitCold({ ...seat, roster, liveWorkers })
  }
}
