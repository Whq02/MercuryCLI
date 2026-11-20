import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import type { resolveEffectiveSettingsSnapshot } from '../../substrate/startupMenu.js'
import { workspaceKindOf } from '../concourseWorktrees.js'
import { kitStampOf } from '../sessionKit.js'
import { updateConcourseWorkers } from './store.js'
import type { seatInitialPermissionMode } from './spec.js'
import { type pidFieldsOf, buildTreeFields } from './marks.js'
import type { AdmitSeat, ConcourseAdmitDeps, ConcourseAdmitResult } from './admit.js'
import { startTimeout } from '../../utils/timers.js'

export function warmSeatAnswer({ req, deps, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, kit, preset, retainedNote, runnerId, claimSessionId, claimEffort, claimPosture, snapshot, pidFields, claimed }: AdmitSeat & { runnerId: string; claimSessionId: string; claimEffort: string; claimPosture: ReturnType<typeof seatInitialPermissionMode>; snapshot: ReturnType<typeof resolveEffectiveSettingsSnapshot>; pidFields: ReturnType<typeof pidFieldsOf>; claimed: Extract<Awaited<ReturnType<NonNullable<ConcourseAdmitDeps['claimWarm']>>>, { claimed: true }> }): ConcourseAdmitResult {
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
    const rewarm = startTimeout(() => deps.ensureWarm!(workspaceId, kit, req.bypassConsent === true), 0)
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
