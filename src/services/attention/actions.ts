/**
 * operator-action contracts — typed intents and receipts over the ONE
 * delivery door (steer-removal: a sent message is delivered instantly and
 * read at the session's next readable moment, exactly once).
 *
 * The old route wrote the cockpit-process command-queue — a store no
 * consumer in this process reads (every engine runs in the session's own
 * runner), so every receipt was an accepted-looking lie over words that
 * would never run. The intents now ride the focused connector's own send
 * doors, and the receipt is the DOOR's answer, honestly: `dispatch-accepted`
 * when the session took the words (they run at its next readable moment),
 * `dispatch-unavailable` when the door refused (no chat open, an
 * unaddressable thread, an empty intent) — never an optimistic
 * acknowledgement, never a fabricated queue entry.
 *
 * There is no replace-next verb any more: under instant delivery there is
 * no replaceable window — a dispatched instruction is with its session the
 * moment the receipt says so.
 *
 * Proved by scripts/attention/prove-dispatch-actions.ts.
 */

import { randomUUID } from 'crypto'
import { getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'

export const RECEIPT_KINDS = ['dispatch-accepted', 'dispatch-unavailable'] as const
export type DispatchReceiptKind = (typeof RECEIPT_KINDS)[number]

export const mintIntentId = (): string =>
  `di-${randomUUID().replace(/-/g, '').slice(0, 12)}`

export interface DispatchIntent {
  /** Caller-minted correlation id (mintIntentId) — echoed on every receipt. */
  intentId: string
  /** What the text is: an ordinary prompt, or board-dispatched work. Both
   *  deliver the same way now — the kind survives for receipt forensics. */
  kind: 'prompt' | 'board-dispatch'
  value: string
  /** Placeholder payloads for the EXISTING [Pasted text #N] expansion — the
   *  scoped composers ride the same machinery the main composer ships. */
  pastedContents?: Record<number, { id: number; type: 'text'; content: string }>
}

export type DispatchReceipt =
  | {
      kind: 'dispatch-accepted'
      intentId: string
      /** Which door took the words: the focused session's own send, or its
       *  addressed agent-note form. */
      route: 'session' | 'agent'
    }
  | { kind: 'dispatch-unavailable'; intentId: string; reason: string }

/** Submit a dispatch intent to the focused session — the one delivery door. */
export async function submitDispatch(intent: DispatchIntent): Promise<DispatchReceipt> {
  if (intent.value.trim() === '') {
    return {
      kind: 'dispatch-unavailable',
      intentId: intent.intentId,
      reason: 'empty dispatch',
    }
  }
  const receipt = await getFocusedSessionConnector().sendWords(intent.value, {
    ...(intent.pastedContents !== undefined
      ? { pastedContents: intent.pastedContents as never }
      : {}),
  })
  if (receipt.state === 'refused') {
    return { kind: 'dispatch-unavailable', intentId: intent.intentId, reason: receipt.detail }
  }
  return { kind: 'dispatch-accepted', intentId: intent.intentId, route: 'session' }
}

export interface ReplyIntent {
  intentId: string
  /** The attention subject the reply addresses (`thread:<id>` vocabulary). */
  targetSubjectId: string
  /** The REAL agent id inside the session's runner (the drain-scope
   *  vocabulary — never a workbench row id: seat:/crew:/execution ids are
   *  not drain scopes). Required for every non-root target; the surface
   *  supplies it from the owner row. */
  agentId?: string
  value: string
}

/**
 * Reply to a subject through the delivery door: the session root rides
 * sendWords (ordinary words to the focused session); a live agent thread
 * rides the door's ADDRESSED form (sendAgentNote — the same identity and
 * exactly-once laws, delivered into that agent's own next turn by the
 * runner's scoped drain). Surface gates eligibility (liveness is the
 * board's knowledge); this layer owns routes and receipts only.
 */
export async function submitReply(intent: ReplyIntent): Promise<DispatchReceipt> {
  if (intent.value.trim() === '') {
    return { kind: 'dispatch-unavailable', intentId: intent.intentId, reason: 'empty reply' }
  }
  if (!intent.targetSubjectId.startsWith('thread:')) {
    return {
      kind: 'dispatch-unavailable',
      intentId: intent.intentId,
      reason: `no reply route for '${intent.targetSubjectId}'`,
    }
  }
  const threadId = intent.targetSubjectId.slice('thread:'.length)
  if (threadId === 'root') {
    const receipt = await getFocusedSessionConnector().sendWords(intent.value, {})
    if (receipt.state === 'refused') {
      return { kind: 'dispatch-unavailable', intentId: intent.intentId, reason: receipt.detail }
    }
    return { kind: 'dispatch-accepted', intentId: intent.intentId, route: 'session' }
  }
  if (intent.agentId) {
    const receipt = await getFocusedSessionConnector().sendAgentNote(intent.agentId, intent.value)
    if (receipt.state === 'refused') {
      return { kind: 'dispatch-unavailable', intentId: intent.intentId, reason: receipt.detail }
    }
    return { kind: 'dispatch-accepted', intentId: intent.intentId, route: 'agent' }
  }
  return {
    kind: 'dispatch-unavailable',
    intentId: intent.intentId,
    reason: `no addressable route to '${threadId}' — steer it from its own surface`,
  }
}
