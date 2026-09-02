import type { ConcourseAdmitRequest, ConcourseAdmitResult } from './concourseSupervisor.js'
import { rowSaturnTickReceipt, type SaturnBirthSpecV1 } from './saturn.js'
import type { SaturnTickerPortsV1 } from './saturnTicker.js'

export interface SaturnBirthDoorsV1 {
  dispatch(req: {
    clientMessageId: string
    prompt: string
    workspaceDir: string
    modelKey?: string
    effort?: string
    title?: string
    kitPreset?: string
    by?: string
  }): Promise<{ ok: boolean; sessionId?: string; workspaceId?: string; error?: string; heldReason?: string }>
  withdraw(clientMessageId: string): Promise<boolean>
  admit(req: ConcourseAdmitRequest): Promise<ConcourseAdmitResult>
  contract(sessionId: string, text: string, by: string): { outcome: 'applied' | 'noop' | 'refused'; detail?: string }
}

export function makeSaturnBirthPort(doors: SaturnBirthDoorsV1): SaturnTickerPortsV1['birth'] {
  return async (spec: SaturnBirthSpecV1, opts: { scheduleId: string; dueAt: number; by: string; owner: string }) => {
    const { scheduleId, dueAt, by, owner } = opts
    const birthKey = `saturn-birth-${owner}-${scheduleId}-${dueAt}`
    let sessionId: string
    let workspaceId: string
    if (spec.opening !== undefined) {
      const r = await doors.dispatch({
        clientMessageId: birthKey,
        prompt: spec.opening,
        workspaceDir: spec.workspaceDir,
        ...(spec.modelKey !== undefined ? { modelKey: spec.modelKey } : {}),
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        ...(spec.kitPreset !== undefined ? { kitPreset: spec.kitPreset } : {}),
        by,
      })
      if (!r.ok) return { ok: false, detail: r.error ?? 'the dispatch door refused' }
      if (r.sessionId === undefined) {
        await doors.withdraw(birthKey)
        return { ok: false, detail: `held by the dispatch door${r.heldReason !== undefined ? ` (${r.heldReason})` : ''} — banked for retry` }
      }
      sessionId = r.sessionId
      workspaceId = r.workspaceId ?? spec.workspaceDir
    } else {
      const r = await doors.admit({
        workspaceDir: spec.workspaceDir,
        ...(spec.modelKey !== undefined ? { modelKey: spec.modelKey } : {}),
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        ...(spec.kitPreset !== undefined ? { kitPreset: spec.kitPreset } : {}),
        bornBlank: true,
      })
      if (!r.ok) return { ok: false, detail: r.error ?? 'the admission door refused' }
      sessionId = r.sessionId
      workspaceId = r.workspaceId
    }
    if (spec.contract !== undefined && spec.contract !== null) {
      const set = doors.contract(sessionId, spec.contract.text, by)
      if (set.outcome === 'refused') {
        rowSaturnTickReceipt({ workspaceId, sessionId }, by, 'schedule-fire', `born by schedule '${scheduleId}' — contract pre-answer refused: ${set.detail ?? 'no detail'}`, {
          outcome: 'born',
          scheduleId,
          contract: 'refused',
        })
        return { ok: true, sessionId }
      }
    }
    rowSaturnTickReceipt({ workspaceId, sessionId }, by, 'schedule-fire', `born by schedule '${scheduleId}'${spec.opening !== undefined ? ' — working its opening mission' : ' — waiting'}`, {
      outcome: 'born',
      scheduleId,
      mode: spec.opening !== undefined ? 'born-working' : 'born-waiting',
      presence: spec.presence,
      ...(spec.kitPreset !== undefined ? { kitPreset: spec.kitPreset } : {}),
      ...(spec.contract !== undefined && spec.contract !== null ? { contract: 'set' } : { contract: 'none' }),
    })
    return { ok: true, sessionId }
  }
}
