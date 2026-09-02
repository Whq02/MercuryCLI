import {
  engageTurnSettlementEffect,
  disengageTurnSettlementEffect,
  type TurnSettlementDecision,
  type TurnSettlementEffect,
} from '../../query/settlementEffects.js'
import { isUnfinishedTail } from './unfinishedTail.js'
import { evaluateStopAttempt, lastAssistantText, repromptWithNextAction } from './runStopAdapter.js'
import { briefTurnSatisfiedByScribeBus } from '../scribe/scribeAwareness.js'


export type ScribeStopRole = 'scribe' | 'implementer'

const MAX_BLOCKS_BY_ROLE: Record<ScribeStopRole, number> = {
  scribe: 1,
  implementer: 3,
}

export const SCRIBE_STOP_HOOK_ID = 'scribe-stop-keep-working'
export const IMPLEMENTER_STOP_HOOK_ID = 'implementer-stop-keep-working'

export const SCRIBE_STOP_REPROMPT =
  'Internal coordination nudge — never mention, quote, or explain this to the operator, and ' +
  'never make it its own turn. Your last paragraph is a plan or a promise to do something ' +
  'yourself: do it now with tool calls — dispatch the refined work to the Implementer over the ' +
  'bus and continue. If there is genuinely nothing left to do and the next move is the ' +
  'operator’s, end cleanly with no commentary. Never bypass a permission, approval, capability, ' +
  'or refusal gate.'

export const IMPLEMENTER_STOP_REPROMPT =
  'Internal coordination nudge — never mention or explain this. Keep working: your last ' +
  'paragraph is a plan, a promise, or a question. Do that work NOW with tool calls (retry after ' +
  'errors, gather missing info yourself). You have no direct human channel: if you are genuinely ' +
  'blocked or facing an out-of-scope decision, ESCALATE TO THE SCRIBE over the bus — never ' +
  'address the human, and do not end the turn on the open item. Never bypass a permission, ' +
  'approval, capability, or refusal gate. A task that needs a capability, tool, or access ' +
  'you do not have is FINISHED by escalating the gap to the Scribe — never grind at an ' +
  'impossible ask. End only when the task is genuinely complete or the escalation has ' +
  'been sent.'

function effectIdFor(role: ScribeStopRole): string {
  return role === 'scribe' ? SCRIBE_STOP_HOOK_ID : IMPLEMENTER_STOP_HOOK_ID
}
function repromptFor(role: ScribeStopRole): string {
  return role === 'scribe' ? SCRIBE_STOP_REPROMPT : IMPLEMENTER_STOP_REPROMPT
}

export function implementerBusSendThisTurn(messages: readonly unknown[]): boolean {
  const arr = messages as ReadonlyArray<{ type?: string; isMeta?: boolean; toolUseResult?: unknown }>
  const lastUserIdx = arr.findLastIndex((m: { type?: string; isMeta?: boolean; toolUseResult?: unknown }) => m?.type === 'user' && !m.isMeta && !m.toolUseResult)
  return briefTurnSatisfiedByScribeBus(messages.slice(lastUserIdx + 1))
}

export function scribeImplementerSettlementEffect(
  role: ScribeStopRole,
  options?: { maxBlocks?: number },
): TurnSettlementEffect {
  const maxBlocks = options?.maxBlocks ?? MAX_BLOCKS_BY_ROLE[role]
  const allowOperatorQuestion = role === 'scribe'
  let blocks = 0
  let lastTurnIdx = -1
  return {
    id: effectIdFor(role),
    evaluate: async ({ messages, signal }): Promise<TurnSettlementDecision> => {
      const turnIdx = (
        messages as Array<{ type?: string; isMeta?: boolean; toolUseResult?: unknown }>
      ).findLastIndex((m: { type?: string; isMeta?: boolean; toolUseResult?: unknown }) => m?.type === 'user' && !m.isMeta && !m.toolUseResult)
      if (turnIdx !== lastTurnIdx) {
        lastTurnIdx = turnIdx
        blocks = 0
      }
      if (blocks >= maxBlocks) return { action: 'settle' }
      if (implementerBusSendThisTurn(messages)) return { action: 'settle' }
      const text = lastAssistantText(messages)
      const verdict = await evaluateStopAttempt(messages, {
        maxBlocks,
        wordingUnfinished: isUnfinishedTail(text, { allowOperatorQuestion }),
        signal,
      })
      if (verdict.allowStop) return { action: 'settle' }
      blocks++
      return {
        action: 'continue',
        reprompt: repromptWithNextAction(repromptFor(role), verdict.decision),
      }
    },
  }
}

export function registerScribeImplementerStopHook(
  sessionId: string,
  role: ScribeStopRole,
  options?: { maxBlocks?: number },
): string {
  const effect = scribeImplementerSettlementEffect(role, options)
  engageTurnSettlementEffect(sessionId, effect)
  return effect.id
}

export function unregisterScribeImplementerStopHook(
  sessionId: string,
  role: ScribeStopRole,
): void {
  disengageTurnSettlementEffect(sessionId, effectIdFor(role))
}
