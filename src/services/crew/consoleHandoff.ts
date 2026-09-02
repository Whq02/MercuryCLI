// ============================================================================
//  crew/consoleHandoff — Console side-conversation identity + the explicit
//  handoff.
//
//  The side-question ENGINE (utils/sideQuestion.ts) stays pure — it forks,
//  answers once, and never touches a store. THIS owner gives each console
//  side conversation its stable, distinct identity in the conversation
//  registry and records the ONLY legal way its content reaches another
//  thread: an explicit handoff.
//
//  LAWS:
//    · an ordinary console ask means "ask this side helper" — it mints a NEW
//      console-side conversation with parent lineage (default: the main
//      thread); it never steers the main agent and never reuses its id;
//    · a handoff records the edge on BOTH sides (linkConversation) and
//      changes NO id — the transcript never moves into the target thread;
//      what travels is the TYPED side-question context item, visibly, through
//      the operator's own dispatch (never hidden instructions);
//    · cancellation/completion/failure of the side helper appends events to
//      ITS conversation only — the main agent's lifecycle is unreachable
//      from here by construction (no import of any execution owner).
// ============================================================================

import {
  appendConversationEvent,
  linkConversation,
  mintConversation,
  MAIN_CONVERSATION_ID,
  type ConversationV1,
  type CrewConversationId,
} from './conversations.js'
import type { ActorRefV1 } from './identity.js'

export interface OpenSideConversationArgs {
  /** The question as asked (the conversation title + first event). */
  question: string
  /** Who asked (the operator actor ref). */
  askedBy: ActorRefV1
  /** The thread the ask branched FROM (default: the main thread). */
  parentConversationId?: CrewConversationId
  /** The fork-source ref (mercury:// ref, attention subject, board row key). */
  originRef?: string
  dir?: string
}

/** Mint the side conversation — a NEW id with parent lineage, never the
 *  parent id. The asked question is its first event. */
export async function openSideConversation(
  args: OpenSideConversationArgs,
): Promise<ConversationV1> {
  const conversation = await mintConversation({
    kind: 'console-side',
    title: args.question.slice(0, 60) || 'side question',
    participants: [args.askedBy],
    parentConversationId: args.parentConversationId ?? MAIN_CONVERSATION_ID,
    ...(args.dir !== undefined ? { dir: args.dir } : {}),
  })
  await appendConversationEvent(
    conversation.conversationId,
    {
      kind: 'message',
      label: args.question.slice(0, 80),
      ...(args.originRef !== undefined ? { ref: args.originRef } : {}),
      actor: args.askedBy,
    },
    args.dir !== undefined ? { dir: args.dir } : undefined,
  )
  return conversation
}

/** Record the side helper's settlement on ITS conversation: an answer is a
 *  message + completion; a failure/abort is a failure event the inbox holds
 *  as stalled until the operator resolves or dismisses it. Nothing here can
 *  reach the main agent. */
export async function recordSideOutcome(
  conversationId: CrewConversationId,
  outcome:
    | { kind: 'answered'; response: string; ref?: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'dismissed' },
  opts?: { dir?: string },
): Promise<void> {
  if (outcome.kind === 'answered') {
    await appendConversationEvent(
      conversationId,
      {
        kind: 'message',
        label: outcome.response.slice(0, 80),
        ...(outcome.ref !== undefined ? { ref: outcome.ref } : {}),
      },
      opts,
    )
    await appendConversationEvent(conversationId, { kind: 'completion', label: 'answered' }, opts)
    return
  }
  if (outcome.kind === 'failed') {
    await appendConversationEvent(
      conversationId,
      { kind: 'failure', label: outcome.reason.slice(0, 80), requiresResolution: true },
      opts,
    )
    return
  }
  await appendConversationEvent(conversationId, { kind: 'completion', label: 'dismissed' }, opts)
}

export type HandoffReceipt =
  | { ok: true; from: CrewConversationId; to: CrewConversationId; ref?: string }
  | { ok: false; reason: string }

/**
 * THE explicit handoff: lineage on BOTH conversations, no id change, no
 * transcript move. `deliveryRef` (when the operator's dispatch of the typed
 * context item settles) rides the edge so the graph can name the exact
 * delivery — the handoff itself never sends anything.
 */
export async function handOffSideConversation(
  sideConversationId: CrewConversationId,
  targetConversationId: CrewConversationId,
  opts?: { deliveryRef?: string; dir?: string },
): Promise<HandoffReceipt> {
  if (sideConversationId === targetConversationId) {
    return { ok: false, reason: 'a conversation cannot hand off to itself' }
  }
  const linked = await linkConversation(sideConversationId, targetConversationId, 'handoff', {
    ...(opts?.deliveryRef !== undefined ? { ref: opts.deliveryRef } : {}),
    ...(opts?.dir !== undefined ? { dir: opts.dir } : {}),
  })
  if (!linked) {
    return { ok: false, reason: 'one of the conversations does not exist in the registry' }
  }
  await appendConversationEvent(
    sideConversationId,
    {
      kind: 'activity',
      label: `handed off → ${targetConversationId}`,
      ...(opts?.deliveryRef !== undefined ? { ref: opts.deliveryRef } : {}),
    },
    opts?.dir !== undefined ? { dir: opts.dir } : undefined,
  ).catch(() => {
    // the lineage edge is the durable truth; the event is presentation
  })
  return {
    ok: true,
    from: sideConversationId,
    to: targetConversationId,
    ...(opts?.deliveryRef !== undefined ? { ref: opts.deliveryRef } : {}),
  }
}
