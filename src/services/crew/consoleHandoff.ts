
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
  question: string
  askedBy: ActorRefV1
  parentConversationId?: CrewConversationId
  originRef?: string
  dir?: string
}

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
  })
  return {
    ok: true,
    from: sideConversationId,
    to: targetConversationId,
    ...(opts?.deliveryRef !== undefined ? { ref: opts.deliveryRef } : {}),
  }
}
