import { daemonControlRpc } from '../../daemon/controlSocket.js'
import type { DaemonRequest } from '../../daemon/protocol.js'
import { resolveImplementerSeat, setOperatorSeatSlot } from '../model/seatSlots.js'
import { registerReslotExpectation } from '../model/seatReceipts.js'

export type ScribeTarget = 'scribe' | 'implementer'

export type SeatTarget = {
  target: 'scribe' | 'implementer'
  kind: 'local' | 'daemon'
}

export function parseScribeTargetArg(args: string): { target: ScribeTarget | null; rest: string } {
  const trimmed = (args ?? '').trim()
  const m = trimmed.match(/^(scribe|implementer)\b\s*([\s\S]*)$/i)
  if (!m) return { target: null, rest: trimmed }
  return { target: m[1]!.toLowerCase() as ScribeTarget, rest: (m[2] ?? '').trim() }
}

export function parseSeatTargetArg(
  args: string,
  opts: { scribeOn: boolean; scribeFeatureOn?: boolean },
): { seat: SeatTarget | null; rest: string } {
  const trimmed = (args ?? '').trim()
  if (opts.scribeOn || opts.scribeFeatureOn) {
    const { target, rest } = parseScribeTargetArg(trimmed)
    if (target === 'implementer') return { seat: { target, kind: 'daemon' }, rest }
    if (target === 'scribe' && opts.scribeOn) return { seat: { target, kind: 'local' }, rest }
  }
  return { seat: null, rest: trimmed }
}

export type ReconfigurableSeat = 'implementer'

const SEAT_LABEL: Record<ReconfigurableSeat, string> = {
  implementer: 'Implementer',
}

let lastAckedImplementerPatch: { model?: string; effort?: string } = {}

export function implementerSeatView(): { model: string; effort: string } {
  const seat = resolveImplementerSeat()
  return {
    model: lastAckedImplementerPatch.model ?? seat.model,
    effort: lastAckedImplementerPatch.effort ?? String(seat.effort),
  }
}

export function resetImplementerSeatViewForTest(): void {
  lastAckedImplementerPatch = {}
}

export async function reconfigureSeat(
  short: ReconfigurableSeat,
  patch: {
    model?: string
    effort?: string
  },
): Promise<string> {
  const label = SEAT_LABEL[short]
  const isImplementer = short === 'implementer'
  const isReslot = patch.model !== undefined || patch.effort !== undefined
  let resolvedModel = patch.model
  let resolvedEffort = patch.effort
  let persistNote = ''
  if (isReslot) {
    const saved = setOperatorSeatSlot(short, {
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    })
    if (!saved.ok) return saved.message
    resolvedModel = saved.applied?.model ?? patch.model
    resolvedEffort =
      saved.applied?.effort !== undefined ? String(saved.applied.effort) : patch.effort
    persistNote = saved.envShadow ? ` · slot saved — note: ${saved.envShadow}` : ' · slot saved'
  }
  const what =
    [
      resolvedModel ? `model ${resolvedModel}` : null,
      resolvedEffort ? `@${resolvedEffort}` : null,
    ]
      .filter(Boolean)
      .join(' ') || 'spec'
  try {
    const reply = await daemonControlRpc({
      op: 'reconfigure',
      short,
      model: resolvedModel,
      effort: resolvedEffort,
    } as DaemonRequest)
    if (!reply.ok) {
      if (reply.code === 'ENOCONN' || reply.code === 'ESTARTING') {
        return `${label} not reachable — no daemon responding (is it running? ${isImplementer ? 'engage Scribe Mode' : 'engage the party'} or restart the daemon).${isReslot ? ' Slot saved — applies at the next engage.' : ''}`
      }
      if (reply.code === 'ENOJOB') {
        return `No ${label} in the roster to retarget.${isReslot ? ' Slot saved — applies at the next engage.' : ''}`
      }
      return `${label} reconfigure failed: ${reply.code}`
    }
    if (reply.op !== 'reconfigure') return `${label} reconfigure: unexpected reply.`
    const note = 'note' in reply && reply.note ? ` · ${reply.note}` : ''
    if (!reply.respawned && !reply.pending) {
      return `${label} unchanged${note || ' — patch refused'}`
    }
    if (isImplementer) {
      lastAckedImplementerPatch = {
        ...lastAckedImplementerPatch,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      }
    }
    if (isReslot) {
      registerReslotExpectation({
        role: short,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      })
    }
    return reply.respawned
      ? `${label} → ${what} · respawning now${note}${persistNote}`
      : `${label} → ${what} · queued (applies when idle)${note}${persistNote}`
  } catch (e) {
    return `${label} reconfigure error: ${String(e)}`
  }
}

export async function reconfigureImplementer(patch: {
  model?: string
  effort?: string
}): Promise<string> {
  return reconfigureSeat('implementer', patch)
}
