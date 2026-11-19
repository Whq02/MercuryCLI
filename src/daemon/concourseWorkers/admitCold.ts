import { join } from 'node:path'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { randomUUID } from '../../utils/crypto.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { resolveEffectiveSettingsSnapshot } from '../../substrate/startupMenu.js'
import { getProcessStartInstantAsync } from '../ownerWatch.js'
import { workspaceKindOf, ensureWorkerWorktree } from '../concourseWorktrees.js'
import { describeSeatReading } from '../../services/switchboard/capacityCheck.js'
import { normalizeEffortLevelString } from '../../utils/effort.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../../utils/sessionStorage/transcriptReader.js'
import { kitStampOf, noteRecordlessResumeKit } from '../sessionKit.js'
import { CONCOURSE_SHORT_PREFIX, effectiveSeatCeiling } from './admission.js'
import { updateConcourseWorkers } from './store.js'
import { buildConcourseWorkerSpec, spawnPostureOf } from './spec.js'
import { pidFieldsOf, buildTreeFields } from './marks.js'
import { migrateTranscriptHomeToLaw } from './revive.js'
import type { ConcourseWorkerRecordV1 } from './record.js'
import type { AdmitSeat, ConcourseAdmitDeps, ConcourseAdmitResult } from './admit.js'

export async function admitCold({ req, deps, records, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, keyless, kit, preset, retainedNote, carryBuildNotices, roster, liveWorkers }: AdmitSeat & { roster: NonNullable<ReturnType<ConcourseAdmitDeps['roster']>>; liveWorkers: ConcourseWorkerRecordV1[] }): Promise<ConcourseAdmitResult> {
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
