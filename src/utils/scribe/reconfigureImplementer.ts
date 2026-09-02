// ============================================================================
//  reconfigureImplementer — the foreground caller for per-agent targeting (W2).
//
//  /effort and /model can target the daemon-hosted Implementer instead of the
//  foreground Scribe. This issues the `reconfigure` control RPC (the daemon then
//  respawn-if-idle-else-queues the worker with the patched model/effort) and
//  returns a one-line operator-facing message. Never throws.
// ============================================================================
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import type { DaemonRequest } from '../../daemon/protocol.js'
import { resolveImplementerSeat, setOperatorSeatSlot } from '../model/seatSlots.js'
import { registerReslotExpectation } from '../model/seatReceipts.js'

export type ScribeTarget = 'scribe' | 'implementer'

/** Every addressable seat: the scribe router's two + the party's five.
 *  `kind` says where the change applies — 'local' seats are FOREGROUND session
 *  pins (scribe); 'daemon' seats are roster workers retargeted over
 *  the reconfigure RPC. */
export type SeatTarget = {
  target: 'scribe' | 'implementer'
  kind: 'local' | 'daemon'
}

/**
 * Parse a leading `scribe`|`implementer` target token from a command's args — the
 * fast path that bypasses the interactive chooser (`/effort implementer xhigh`,
 * `/model scribe opus`). Returns the target (or null) + the remaining args. Pure.
 */
export function parseScribeTargetArg(args: string): { target: ScribeTarget | null; rest: string } {
  const trimmed = (args ?? '').trim()
  const m = trimmed.match(/^(scribe|implementer)\b\s*([\s\S]*)$/i)
  if (!m) return { target: null, rest: trimmed }
  return { target: m[1]!.toLowerCase() as ScribeTarget, rest: (m[2] ?? '').trim() }
}

/**
 * The seat-target parser: accepts the scribe pair, gated on the scribe
 * engagement/feature the caller passes, so a plain session treats a seat
 * word as ordinary args. Pure.
 *
 * L-6: the IMPLEMENTER token also parses on
 * `scribeFeatureOn` (scribeModeEnabled — the FEATURE, not the engagement).
 * The seat SLOT is durable operator intent: `/model implementer gpt-5.6-sol`
 * with Scribe off would otherwise answer "Model 'implementer gpt-5.6-sol' not found",
 * so a typed-only gpt id could never be slotted onto a not-engaged
 * Implementer. reconfigureSeat persists the slot FIRST and the unreachable-
 * daemon note already says "Slot saved — applies at the next engage", so the
 * disengaged path is honest end-to-end. The SCRIBE token stays engagement-
 * gated: its local-seat handling strips the token and falls through to the
 * FOREGROUND model set, which would silently switch the main session's model
 * in a scribe-off session.
 */
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

/** Roster workers addressable by the reconfigure RPC. */
export type ReconfigurableSeat = 'implementer'

const SEAT_LABEL: Record<ReconfigurableSeat, string> = {
  implementer: 'Implementer',
}

/**
 * Retarget a daemon-hosted seat's model and/or effort via the reconfigure RPC
 * (the W2 primitive, generalized over the roster). Returns a one-line
 * operator-facing message reflecting the outcome (respawning now vs queued
 * until idle, a validation refusal note, or an honest unreachable/error note).
 * Never throws.
 */
// The last daemon-ACKED implementer patch this session (respawned or queued).
// The /effort Implementer slider seeds from the Implementer's ACTUAL spec —
// the validated spawn-seat defaults overlaid with what this session
// successfully reconfigured — never from the foreground Scribe's state.
let lastAckedImplementerPatch: { model?: string; effort?: string } = {}

/** The Implementer's current model+effort as best known in-session: the
 *  validated seat spec (MERCURY_IMPLEMENTER_MODEL/_EFFORT over the pinned
 *  defaults) overlaid with the last daemon-acked reconfigure. Effort is
 *  stringified (a SeatSpec effort may be numeric) for display/seed use. */
export function implementerSeatView(): { model: string; effort: string } {
  const seat = resolveImplementerSeat()
  return {
    model: lastAckedImplementerPatch.model ?? seat.model,
    effort: lastAckedImplementerPatch.effort ?? String(seat.effort),
  }
}

/** Test seam. */
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
  // a model/effort patch is an OPERATOR RESLOT — every foreground
  // caller of this function (the /model·/effort seat tokens, the /party board
  // keys, the picker ROLES rows) is an operator act. Persist the slot FIRST
  // (validated, fail-closed — a refusal returns here and never even RPCs),
  // then ride the daemon's idle-boundary reconfigure with the RESOLVED values
  // and register the receipt expectation.
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
    // Carry the env-shadow warning through (logic-flaw F3: the
    // store composed the honest "VAR overrides this session" note and this
    // ACK discarded it — claiming a clean reslot while an env pin still owns
    // the axis for every FRESH engagement).
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
        // Don't assume "not engaged yet" — the party/scribe may BE engaged but
        // the daemon crashed or is still starting (refute pass wording nit).
        return `${label} not reachable — no daemon responding (is it running? ${isImplementer ? 'engage Scribe Mode' : 'engage the party'} or restart the daemon).${isReslot ? ' Slot saved — applies at the next engage.' : ''}`
      }
      if (reply.code === 'ENOJOB') {
        return `No ${label} in the roster to retarget.${isReslot ? ' Slot saved — applies at the next engage.' : ''}`
      }
      return `${label} reconfigure failed: ${reply.code}`
    }
    if (reply.op !== 'reconfigure') return `${label} reconfigure: unexpected reply.`
    // Seat-slot validation note (P1): surface the honest refusal/adjustment. A
    // refused patch arrives as respawned:false + pending:false + note.
    const note = 'note' in reply && reply.note ? ` · ${reply.note}` : ''
    if (!reply.respawned && !reply.pending) {
      return `${label} unchanged${note || ' — patch refused'}`
    }
    // ACKED (respawning or queued) — remember it so the next /effort
    // implementer slider seeds from the Implementer's actual spec.
    if (isImplementer) {
      lastAckedImplementerPatch = {
        ...lastAckedImplementerPatch,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      }
    }
    // ONE receipt row when the retarget actually APPLIES (the running spec
    // matches) — the ACK below is the request, not the apply (wait-doctrine).
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

/**
 * Retarget the daemon-hosted Implementer (the original W2 caller — kept as a
 * thin alias over the generalized reconfigureSeat).
 */
export async function reconfigureImplementer(patch: {
  model?: string
  effort?: string
}): Promise<string> {
  return reconfigureSeat('implementer', patch)
}
