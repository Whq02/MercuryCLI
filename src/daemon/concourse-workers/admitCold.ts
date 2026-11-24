import { join } from 'node:path'
import { partiallySanitizeUnicode } from '../../platform/text/unicodeSanitization.js'
import { recordToEntry } from '../../sessions/fabric/entryCodec.js'
import type { MercuryRecord } from '../../sessions/fabric/record.js'
import { resolveEffectiveSettingsSnapshot } from '../../platform/substrate/startupMenu.js'
import { workspaceKindOf } from './concourseWorktrees.js'
import { normalizeEffortLevelString } from '../../models/effort/effort.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { scanTranscriptLinesBackward } from '../../sessions/transcripts/transcriptReader.js'
import { kitStampOf, noteRecordlessResumeKit } from '../session-seat/sessionKit.js'
import { CONCOURSE_SHORT_PREFIX } from './admission.js'
import { updateConcourseWorkersRidingOut } from './store.js'
import { buildConcourseWorkerSpec, spawnPostureOf } from './spec.js'
import { pidFieldsOf, buildTreeFields } from './marks.js'
import { migrateTranscriptHomeToLaw } from './revive.js'
import type { ConcourseWorkerRecordV1 } from './record.js'
import type { AdmitSeat, ConcourseAdmitDeps, ConcourseAdmitResult, WorkerRosterPort } from './admit.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function coldRunnerIdOf(records: Record<string, ConcourseWorkerRecordV1>, roster: NonNullable<ReturnType<ConcourseAdmitDeps['roster']>>): string | null {
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
  return runnerId
}

export function coldSpecOf({ req, records, workspaceId, sessionId, runnerId, worktreePath, workerCwd, modelKey, keyless, kit, kind }: Pick<AdmitSeat, 'req' | 'records' | 'workspaceId' | 'modelKey' | 'keyless' | 'kit' | 'kind'> & { sessionId: string; runnerId: string; worktreePath: string | undefined; workerCwd: string }) {
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
            const entry = (typeof row.recordId === 'string' && row.payload !== undefined ? recordToEntry(row as MercuryRecord) : row) as { type?: string; effort?: { asked?: unknown } }
            if (entry.type !== 'assistant' || typeof entry.effort?.asked !== 'string') return
            const level = normalizeEffortLevelString(entry.effort.asked)
            if (level === undefined) return
            saved = level
            return true
          } catch (error) { passedOver(error) }
        })
      } catch (error) { passedOver(error) }
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
    ...(req.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
    ...(req.bypassConsent === true ? { bypassConsent: true as const } : {}),
    ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv } : {}),
    kind,
  })
  return { snapshot, effort, runnerArgv, spec }
}

export async function coldSeatAnswer({ req, deps, workspaceId, effectiveIsolation, modelKey, modelDisplayName, keyless, kit, preset, retainedNote, liveWorkers, runnerId, sessionId, workspaceKind, worktreePath, worktreeBranch, snapshot, effort, runnerArgv, spec, reg, pidFields }: AdmitSeat & ReturnType<typeof coldSpecOf> & { liveWorkers: ConcourseWorkerRecordV1[]; runnerId: string; sessionId: string; workspaceKind: ReturnType<typeof workspaceKindOf>; worktreePath: string | undefined; worktreeBranch: string | undefined; reg: ReturnType<WorkerRosterPort['registerLongLived']>; pidFields: ReturnType<typeof pidFieldsOf> }): Promise<ConcourseAdmitResult> {
  try {
    await updateConcourseWorkersRidingOut(workers => {
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
  } catch (error) {
    deps.roster()?.kill?.(runnerId)
    return { ok: false, code: 'not-ready', error: `no session was started: ${error instanceof Error ? error.message : String(error)}` }
  }
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
