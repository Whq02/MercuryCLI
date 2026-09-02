// ============================================================================
//  services/concourse/coordinatorReplay — the ONE projection from the durable
//  coordinator conversation to the turn's replayed history.
//
//  A stored conversation is not a prompt. Three facts have to survive the trip
//  or the next turn answers the wrong question:
//   · WHO SPOKE. A harness notice ("the turn did not run", a sign-in refusal,
//     the off hint) is Mercury reporting on the lane. Replayed as the
//     coordinator's own words it becomes something the model believes it said.
//   · WHEN. Turns replay with no clock of their own, so a ten-hour-old ask
//     reads exactly like the live one. Rows past the freshness window carry
//     their age, and the operator's LATEST message is the instruction.
//   · WHETHER IT WAS EVER ANSWERED. An operator message the harness settled
//     (its turn refused, never run) is history — not an open ask waiting for
//     an answer this turn.
//
//  Pure and clock-injected: the caller passes `nowMs`, so a prover pins every
//  boundary without touching a real clock.
// ============================================================================

import type { CoordinatorConversationEntryV1 } from './coordinatorConversation.js'
import type { ManagerAskV1, ManagerPlanV1 } from './managerMode.js'
import { ageLabelOf } from './concourseSnapshot.js'

export interface CoordinatorReplayRowV1 {
  /** 'harness' is its own voice — never folded into the coordinator's. */
  role: 'operator' | 'coordinator' | 'harness'
  text: string
  /** How long before this turn the row was spoken ('3h earlier'), present
   *  only past the freshness window. */
  age?: string
  /** This operator turn was settled by the harness — its request never ran,
   *  so it replays as history and never as an open ask. */
  settled?: true
  receipts?: ReadonlyArray<{ verb: string; outcome: string; label: string }>
}

/** Newest turns replayed. The board carries world-state; the tail carries
 *  the thread of the conversation. */
export const REPLAY_TAIL = 12
/** Per-row clip — the bounded-input law (ids/titles/text, never transcripts). */
export const REPLAY_CLIP = 600
/** A COMPACT-SUMMARY row's own clip (chat-relief): the summary REPLACED the
 *  folded turns and is their only memory — clipping it at the per-row 600
 *  would amputate exactly what the fold preserved. Bounded by the fold's
 *  own summary cap (coordinatorCompact), plus the marker sentence's room. */
export const REPLAY_SUMMARY_CLIP = 4400
/** Inside this window a replayed turn reads as the same sitting. Past it the
 *  row carries its age, so a stale instruction can never pass for the live one. */
export const REPLAY_AGE_FLOOR_MS = 30 * 60_000

/** MANAGER MODE's card payloads replay WHOLE (MGR-3): the plan card's lane
 *  split — goal, lanes with scope · deliverables · territory, seats, its
 *  consent state — and the interview card's options are the model's OWN
 *  words (propose_plan / ask_operator), stored beside a one-line text. The
 *  replay used to carry the harness line alone ("the plan is ready — 2 lanes
 *  on the card below"), so "No, keep the draft — say what to change" handed
 *  the model a split it could no longer see and it re-invented a different
 *  one. The fields are bounded at decode (the card's own caps), never a
 *  transcript, so they ride outside the per-row text clip. */
export function renderPlanForReplay(plan: ManagerPlanV1): string {
  const lanes = plan.lanes
    .map(
      (lane, i) =>
        `lane ${i + 1} · ${lane.title}\n  scope: ${lane.scope}\n  delivers: ${lane.deliverables}\n  territory: ${lane.territory}`,
    )
    .join('\n')
  const waiting = plan.laneWaiting !== undefined && plan.laneWaiting.length > 0 ? `\nwaiting lanes: ${plan.laneWaiting.map(i => i + 1).join(', ')}` : ''
  return `<plan state="${plan.state}" supervision="${plan.supervision}">\ngoal: ${plan.goal}\n${lanes}${
    plan.seats !== undefined ? `\nseats: ${plan.seats}` : ''
  }${waiting}\n</plan>`
}

export function renderAskForReplay(ask: ManagerAskV1): string {
  if (ask.options.length === 0) return ''
  return `<ask${ask.index !== undefined ? ` question="${ask.index}"` : ''}>\n${ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n</ask>`
}

/** A card-bearing entry is the MODEL's turn even when the store flagged its
 *  one-line text as harness-spoken: the plan is what it proposed, the ask is
 *  what it asked. Only a bare notice is the harness's own voice. */
const cardBearing = (e: CoordinatorConversationEntryV1): boolean => e.plan !== undefined || e.ask !== undefined

/**
 * Shape the stored tail for replay. `nowMs` is the turn's clock.
 */
export function buildCoordinatorReplay(
  entries: readonly CoordinatorConversationEntryV1[],
  nowMs: number,
): CoordinatorReplayRowV1[] {
  // An operator message whose paired reply came from the HARNESS never got an
  // answer — the pairing is the store's own id convention (op:<id> / co:<id>).
  // A plan or ask reply DID answer it (MGR-3): the goal that produced a plan
  // is not history, it is the standing instruction the draft answers.
  const settledMessageIds = new Set<string>()
  for (const e of entries) {
    if (e.harness === true && !cardBearing(e) && e.id.startsWith('co:')) settledMessageIds.add(e.id.slice(3))
  }
  const rows: CoordinatorReplayRowV1[] = []
  // THE SUMMARY RIDES THE TAIL (FN-017 rank 2): a compact summary REPLACED
  // the folded turns and is their only memory, seated at position 0 by the
  // fold; two operator exchanges later the twelve-entry tail slid past it
  // and the coordinator forgot everything before the last twelve raw
  // entries — re-asking about work it launched, losing the standing asks
  // the summary was written to preserve. The newest summary now rides
  // ahead of the tail whenever the slice excluded it; its own clip
  // (REPLAY_SUMMARY_CLIP) bounds the cost. Raising the tail would only
  // postpone the loss.
  const tail = entries.slice(-REPLAY_TAIL)
  const newestSummary = [...entries].reverse().find(e => e.summary === true)
  const replayed = newestSummary !== undefined && !tail.includes(newestSummary) ? [newestSummary, ...tail] : tail
  for (const e of replayed) {
    const receipts =
      e.receipts !== undefined && e.receipts.length > 0
        ? e.receipts.slice(0, 12).map(r => ({ verb: r.verb, outcome: r.outcome, label: r.label.slice(0, 240) }))
        : undefined
    if (e.text.length === 0 && receipts === undefined && !cardBearing(e)) continue
    const age =
      Number.isFinite(e.ts) && nowMs - e.ts > REPLAY_AGE_FLOOR_MS
        ? `${ageLabelOf(nowMs, e.ts)} earlier`
        : undefined
    const settled =
      e.role === 'operator' && e.id.startsWith('op:') && settledMessageIds.has(e.id.slice(3))
        ? (true as const)
        : undefined
    const cards = [
      e.ask !== undefined ? renderAskForReplay(e.ask) : '',
      e.plan !== undefined ? renderPlanForReplay(e.plan) : '',
    ].filter(s => s.length > 0)
    const text = [e.text.slice(0, e.summary === true ? REPLAY_SUMMARY_CLIP : REPLAY_CLIP), ...cards]
      .filter(s => s.length > 0)
      .join('\n\n')
    rows.push({
      role: e.harness === true && !cardBearing(e) ? 'harness' : e.role,
      text,
      ...(age !== undefined ? { age } : {}),
      ...(settled !== undefined ? { settled } : {}),
      ...(receipts !== undefined ? { receipts } : {}),
    })
  }
  return rows
}
