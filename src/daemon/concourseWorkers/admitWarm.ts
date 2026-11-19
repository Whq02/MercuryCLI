import { partiallySanitizeUnicode } from '../../utils/sanitization.js'
import { logForDebugging } from '../../utils/debug.js'
import { resolveEffectiveSettingsSnapshot } from '../../substrate/startupMenu.js'
import { randomUUID } from '../../utils/crypto.js'
import { getProcessStartInstantAsync } from '../ownerWatch.js'
import { workspaceKindOf } from '../concourseWorktrees.js'
import { kitStampOf } from '../sessionKit.js'
import { updateConcourseWorkers } from './store.js'
import { seatInitialPermissionMode } from './spec.js'
import { pidFieldsOf, buildTreeFields } from './marks.js'
import type { AdmitSeat, ConcourseAdmitResult } from './admit.js'

export async function admitWarm({ req, deps, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, kit, preset, retainedNote, carryBuildNotices }: AdmitSeat): Promise<ConcourseAdmitResult | undefined> {
  const claimSessionId = randomUUID()
  carryBuildNotices(claimSessionId)
  const claimEffort = req.effort ?? 'high'
  const claimPosture = seatInitialPermissionMode(req.permissionMode)
  const claimStartedAt = Date.now()
  const claimed = await deps.claimWarm!({
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
  return undefined
}
