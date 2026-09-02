// ============================================================================
//  daemon/saturnBirth — THE BIRTH TIER's engine half: a schedule births a
//  fresh session at fire time, through the LANDED doors only.
//
//  TWO ARMS, per the spec's own grammar:
//   · BORN-WORKING (an opening mission): the ONE dispatch door — admit +
//     first delivery in one idempotent call (clientMessageId
//     saturn-birth-<owner>-<scheduleId>-<dueAt>; the owner — the authoring
//     session's id, or 'box' — scopes the daemon-wide ledger so colliding
//     (scheduleId, dueAt) pairs never dedupe each other), the kit preset riding the
//     admit's own preset road (typed closed-roster refusals are the
//     door's). A dispatch the door HOLDS (git offer, repo-held, seat) is
//     WITHDRAWN and refused back to the ticker — SATURN's held-fire bank
//     is the ONE owner of a pending birth, so the contract pre-answer and
//     the born-by receipt can never be lost to a ledger replay that knows
//     nothing of them (and a birth can never land twice from two replay
//     machineries).
//   · BORN-WAITING (no opening): the admission door with bornBlank — the
//     session appears on the concourse and waits (the newborn grace is the
//     admission's own law).
//
//  After either arm lands: the CONTRACT pre-answer (spec.contract text ⇒
//  the advisory contract's one writer sets it, by 'saturn:<scheduleId>';
//  null/absent ⇒ no-contract — pre-answered either way), and the born
//  session's OWN receipt rows "born by schedule '<id>'" (kind
//  'schedule-fire', outcome 'born') beside the authoring session's fire
//  row. Refusals carry the door's own typed sentence — the ticker banks
//  them 'admission-refused' and retries.
// ============================================================================
import type { ConcourseAdmitRequest, ConcourseAdmitResult } from './concourseSupervisor.js'
import { rowSaturnTickReceipt, type SaturnBirthSpecV1 } from './saturn.js'
import type { SaturnTickerPortsV1 } from './saturnTicker.js'

/** The landed doors the birth rides — injected (the daemon wires the real
 *  dispatch handler, admit handler and contract writer; provers inject
 *  fixtures). */
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
  /** SB-C6: the handler's own tail-riding withdraw — a held birth's row is
   *  withdrawn so SATURN's bank stays the one owner of the pending birth. */
  withdraw(clientMessageId: string): Promise<boolean>
  admit(req: ConcourseAdmitRequest): Promise<ConcourseAdmitResult>
  contract(sessionId: string, text: string, by: string): { outcome: 'applied' | 'noop' | 'refused'; detail?: string }
}

export function makeSaturnBirthPort(doors: SaturnBirthDoorsV1): SaturnTickerPortsV1['birth'] {
  return async (spec: SaturnBirthSpecV1, opts: { scheduleId: string; dueAt: number; by: string; owner: string }) => {
    const { scheduleId, dueAt, by, owner } = opts
    // The dispatch ledger dedupes daemon-wide by this key alone — the
    // owner (the authoring session's id, or 'box') scopes it so a box row
    // and a session row colliding on (scheduleId, dueAt) never dedupe each
    // other's births away.
    const birthKey = `saturn-birth-${owner}-${scheduleId}-${dueAt}`
    let sessionId: string
    let workspaceId: string
    if (spec.opening !== undefined) {
      // BORN-WORKING — the one dispatch door (admit + first delivery).
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
        // The door HELD the launch — withdraw its row and refuse back to
        // the ticker's bank (one owner of the pending birth; the retry
        // re-dispatches whole, contract and receipt included).
        await doors.withdraw(birthKey)
        return { ok: false, detail: `held by the dispatch door${r.heldReason !== undefined ? ` (${r.heldReason})` : ''} — banked for retry` }
      }
      sessionId = r.sessionId
      workspaceId = r.workspaceId ?? spec.workspaceDir
    } else {
      // BORN-WAITING — the admission door, born blank.
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
    // The contract pre-answer (null/absent = no-contract, pre-answered).
    if (spec.contract !== undefined && spec.contract !== null) {
      const set = doors.contract(sessionId, spec.contract.text, by)
      if (set.outcome === 'refused') {
        // The birth landed; the contract did not — say so on the record,
        // never silently.
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
