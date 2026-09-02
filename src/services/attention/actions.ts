
import { randomUUID } from 'crypto'
import { getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'

export const RECEIPT_KINDS = ['dispatch-accepted', 'dispatch-unavailable'] as const
export type DispatchReceiptKind = (typeof RECEIPT_KINDS)[number]

export const mintIntentId = (): string =>
  `di-${randomUUID().replace(/-/g, '').slice(0, 12)}`

export interface DispatchIntent {
  intentId: string
  kind: 'prompt' | 'board-dispatch'
  value: string
  pastedContents?: Record<number, { id: number; type: 'text'; content: string }>
}

export type DispatchReceipt =
  | {
      kind: 'dispatch-accepted'
      intentId: string
      route: 'session' | 'agent'
    }
  | { kind: 'dispatch-unavailable'; intentId: string; reason: string }

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
  targetSubjectId: string
  agentId?: string
  value: string
}

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
