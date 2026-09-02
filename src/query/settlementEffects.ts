import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

export type TurnSettlementDecision =
  | { action: 'settle' }
  | { action: 'continue'; reprompt: string }

export interface TurnSettlementInput {
  messages: Message[]
  signal?: AbortSignal
}

export interface TurnSettlementEffect {
  id: string
  evaluate: (
    input: TurnSettlementInput,
  ) => Promise<TurnSettlementDecision> | TurnSettlementDecision
}

const effectsBySession = new Map<string, TurnSettlementEffect[]>()

export function engageTurnSettlementEffect(
  sessionId: string,
  effect: TurnSettlementEffect,
): void {
  const list = effectsBySession.get(sessionId) ?? []
  const next = list.filter(existing => existing.id !== effect.id)
  next.push(effect)
  effectsBySession.set(sessionId, next)
}

export function disengageTurnSettlementEffect(
  sessionId: string,
  effectId: string,
): void {
  const list = effectsBySession.get(sessionId)
  if (!list) return
  const next = list.filter(effect => effect.id !== effectId)
  if (next.length === 0) effectsBySession.delete(sessionId)
  else effectsBySession.set(sessionId, next)
}

export function isTurnSettlementEffectEngaged(
  sessionId: string,
  effectId: string,
): boolean {
  return (effectsBySession.get(sessionId) ?? []).some(effect => effect.id === effectId)
}

export function __resetTurnSettlementEffectsForTest(): void {
  effectsBySession.clear()
}

export async function runTurnSettlementEffects(
  sessionId: string,
  input: TurnSettlementInput,
): Promise<{ reprompts: string[] }> {
  const reprompts: string[] = []
  for (const effect of effectsBySession.get(sessionId) ?? []) {
    try {
      const decision = await effect.evaluate(input)
      if (decision.action === 'continue') reprompts.push(decision.reprompt)
    } catch (error) {
      logForDebugging(
        `turn-settlement effect '${effect.id}' failed: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }
  return { reprompts }
}
