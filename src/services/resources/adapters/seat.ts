import { canAnswerAsks, getAskChannel, getSessionId, getSessionKind } from '../../../bootstrap/state.js'
import { stampLocal } from '../../../mneme/entryPage.js'
import { ledgerEntryOf } from '../../../mneme/ledger.js'
import { mnemeProjectKey } from '../../../mneme/paths.js'
import type { LedgerEngine } from '../../../mneme/types.js'
import { getMarketingNameForModel, normalizeModelStringForAPI } from '../../../utils/model/model.js'
import type { ParsedRef, ResourceAdapter, ResourceContext, ResourceResult } from '../contracts.js'

export const SEAT_REF = 'mercury://seat'

export interface SeatReference {
  model: string
  effort: string | null
  posture: string
  engines: LedgerEngine[]
}

export const OCULUS_SEAT_WORDS = 'oculus: a screen belongs to this session — a permission ask or a question travels to the operator on the screen and waits for their answer, however long they are away; nothing expires it'

export function seatPostureWords(permissionMode: string | null): string {
  const channel = getAskChannel()
  const asks =
    channel === 'operator'
      ? 'interactive: a permission ask or a question reaches the operator at the prompt'
      : canAnswerAsks() && getSessionKind() === 'oculus'
        ? OCULUS_SEAT_WORDS
        : canAnswerAsks()
          ? 'headless, a host holds the asks: a permission ask or a question travels to the connected client, which answers allow or deny'
          : 'headless, non-interactive: no host answers an ask, so a call that would need an interactive approval is denied; a denial is policy, not tool failure'
  return permissionMode === null ? asks : `${asks}; permission mode ${permissionMode}`
}

function modelWords(model: string): string {
  const wireId = normalizeModelStringForAPI(model)
  const marketing = getMarketingNameForModel(wireId)
  return marketing !== null && marketing.length > 0 ? `${wireId} (${marketing})` : wireId
}

export function seatReference(ctx: ResourceContext): SeatReference | null {
  if (ctx.engineModel === undefined) return null
  const state = ctx.getAppState?.() as { effortValue?: unknown; toolPermissionContext?: { mode?: unknown } } | undefined
  const effort = state?.effortValue
  const mode = state?.toolPermissionContext?.mode
  const entry = ledgerEntryOf(mnemeProjectKey(), String(getSessionId()))
  return {
    model: ctx.engineModel,
    effort: typeof effort === 'string' || typeof effort === 'number' ? String(effort) : null,
    posture: seatPostureWords(typeof mode === 'string' ? mode : null),
    engines: entry?.engines ?? [],
  }
}

export const SEAT_SWITCH_SENTENCE = 'The operator switches the model with /model and the effort with /effort, typed in the chat; a switch takes effect from the next message, and this page is read live, so it already shows it.'

export const SEAT_EVIDENCE_SENTENCE =
  'Asked which model runs you, answer from this reference: the id above is the one this turn dispatched on. The engines list is the record of switches in this session, in local time with the zone in brackets; a model named in an earlier reply, an environment variable such as MERCURY_MODEL, or a copy of the ledger read earlier is not evidence of the one running now.'

export function seatReferenceText(seat: SeatReference): string {
  const engines =
    seat.engines.length === 0
      ? ['engines this session: no ledger entry for this session yet']
      : ['engines this session, from the lineage ledger (local time, the zone in brackets; the first row is the start, each later row a switch, stamped by the clock at the write):', ...seat.engines.map(engine => `  ${stampLocal(engine.at)}  ${modelWords(engine.model)}`)]
  return [
    `model this turn runs on: ${modelWords(seat.model)}`,
    `effort: ${seat.effort ?? 'not set (the provider default applies)'}`,
    `posture: ${seat.posture}`,
    ...engines,
    SEAT_SWITCH_SENTENCE,
    '',
    SEAT_EVIDENCE_SENTENCE,
  ].join('\n')
}

export const seatAdapter: ResourceAdapter = {
  kind: 'seat',
  describe: 'this seat: the model this turn runs on, the effort, the posture, and the engines this session has run on with their switch times (mercury://seat)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id !== '') {
      return { state: 'absent', note: 'the seat reference has one form: mercury://seat' }
    }
    const seat = seatReference(ctx)
    if (seat === null) {
      return { state: 'unavailable', note: 'the seat reference answers inside a session turn (the model it runs on is a fact of the turn)' }
    }
    return {
      state: 'ok',
      resource: {
        ref: SEAT_REF,
        kind: 'seat',
        title: 'this seat',
        summary: `model ${modelWords(seat.model)} · effort ${seat.effort ?? 'not set'} · ${seat.engines.length} engine${seat.engines.length === 1 ? '' : 's'} this session`,
        mutable: true,
        structured: seat,
        text: seatReferenceText(seat),
      },
    }
  },
}
