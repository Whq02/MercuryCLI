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
