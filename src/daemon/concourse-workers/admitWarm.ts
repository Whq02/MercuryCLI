import { partiallySanitizeUnicode } from '../../platform/text/unicodeSanitization.js'
import type { resolveEffectiveSettingsSnapshot } from '../../platform/substrate/startupMenu.js'
import { inspectWorkspaceKind, workspaceGitCheckNote } from './concourseWorktrees.js'
import { kitStampOf, type SessionKitV1 } from '../session-seat/sessionKit.js'
import { updateConcourseWorkersRidingOut } from './store.js'
import type { seatInitialPermissionMode } from './spec.js'
import { type pidFieldsOf, buildTreeFields } from './marks.js'
import type { AdmitSeat, ConcourseAdmitDeps, ConcourseAdmitResult } from './admit.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const FIRST_LINE_PATIENCE_MS = 3_000

export function rewarmAfterFirstLine(deps: ConcourseAdmitDeps, runnerId: string | undefined, workspaceId: string, kit: SessionKitV1, bypassConsent: boolean): void {
  const ensureWarm = deps.ensureWarm
  if (ensureWarm === undefined) return
  const rewarm = (): void => {
    stopTimeout(patience)
    unheard?.()
    ensureWarm(workspaceId, kit, bypassConsent)
  }
  const patience = startTimeout(rewarm, FIRST_LINE_PATIENCE_MS)
  patience.unref?.()
  const unheard = runnerId === undefined ? undefined : deps.roster()?.afterFirstLine?.(runnerId, rewarm)
}

export async function warmSeatAnswer({ req, deps, workspaceId, effectiveIsolation, kind, modelKey, modelDisplayName, kit, preset, retainedNote, runnerId, claimSessionId, claimEffort, claimPosture, snapshot, pidFields, claimed }: AdmitSeat & { runnerId: string; claimSessionId: string; claimEffort: string; claimPosture: ReturnType<typeof seatInitialPermissionMode>; snapshot: ReturnType<typeof resolveEffectiveSettingsSnapshot>; pidFields: ReturnType<typeof pidFieldsOf>; claimed: Extract<Awaited<ReturnType<NonNullable<ConcourseAdmitDeps['claimWarm']>>>, { claimed: true }> }): Promise<ConcourseAdmitResult> {
  const inspectedKind = inspectWorkspaceKind(workspaceId)
  let note = retainedNote
  if (inspectedKind.kind === 'plain-folder' && inspectedKind.gitCheckError !== undefined) {
    const gitNote = workspaceGitCheckNote(workspaceId, inspectedKind.gitCheckError)
    if (note === undefined) note = gitNote
    else if (!note.includes(gitNote)) note = `${note} — ${gitNote}`
  }
  try {
    await updateConcourseWorkersRidingOut(workers => {
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
        workspaceKind: inspectedKind.kind,
        ...(req.title !== undefined ? { title: partiallySanitizeUnicode(req.title) } : {}),
        ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
        ...(req.resumedAtRest === true ? { resumedAtRestAt: Date.now() } : {}),
        ...(req.birthKey !== undefined ? { birthKey: req.birthKey } : {}),
        ...kitStampOf(kit),
        permissionMode: claimPosture,
        ...(req.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
        ...(req.bypassConsent === true ? { bypassConsent: true as const } : {}),
        kind,
      }
    }, deps.dir)
  } catch (error) {
    deps.roster()?.kill?.(runnerId)
    return { ok: false, code: 'not-ready', error: `no session was started: ${error instanceof Error ? error.message : String(error)}` }
  }
  deps.onSpawned?.(runnerId, claimed.spec, claimed.pid)
  rewarmAfterFirstLine(deps, runnerId, workspaceId, kit, req.bypassConsent === true)
  return {
    ok: true,
    ...(note !== undefined ? { note } : {}),
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
