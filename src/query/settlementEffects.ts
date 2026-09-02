// ============================================================================
//  src/query/settlementEffects.ts — TYPED turn-settlement effects, owned by
//  the turn engine.
//
//  The engine settles the turn; the product's own settle-time semantics run
//  HERE, as typed effects — not as function hooks riding the user's hook
//  registry. Law 3 (the ideology): hooks belong to the user; the product
//  taxing its own turns through the hooks surface made its keep-working
//  discipline look like user configuration and coupled it to the hook
//  executor's delivery shape. What moved: the retired seats' keep-working
//  semantics (their bundled Stop hooks retired with them).
//  What did NOT move: user-authored hooks — handleStopHooks still runs the
//  full Stop/SubagentStop hook machinery exactly as documented, after these
//  effects.
//
//  Contract:
//    · Effects are per-session, keyed by a fixed id (re-engage replaces).
//    · The engine evaluates them at turn settlement, MAIN THREAD only, in
//      engagement order, before the user's stop hooks (phase 4b in
//      handleStopHooks).
//    · A 'continue' decision re-prompts the model with the effect's text —
//      delivered as a meta user message, hidden from the operator-facing
//      transcript, with no error row and no notification (the silent
//      keep-working delivery the retired hooks used).
//    · Effect failures log and never disturb the turn (the sentinel
//      posture); the engine never wedges on its own effects.
// ============================================================================
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

export type TurnSettlementDecision =
  | { action: 'settle' }
  | { action: 'continue'; reprompt: string }

export interface TurnSettlementInput {
  /** The full turn history (messages for query + this turn's assistants). */
  messages: Message[]
  signal?: AbortSignal
}

export interface TurnSettlementEffect {
  /** Fixed id — engaging the same id again replaces the prior effect. */
  id: string
  evaluate: (
    input: TurnSettlementInput,
  ) => Promise<TurnSettlementDecision> | TurnSettlementDecision
}

/** Per-session effect registries (session id → ordered effects). Module
 *  state, engine-owned — deliberately NOT AppState: effects are process
 *  runtime wiring, not user configuration. */
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

/** Test seam — clears every session's effects. */
export function __resetTurnSettlementEffectsForTest(): void {
  effectsBySession.clear()
}

/**
 * Evaluate the session's settlement effects in engagement order. Returns
 * the re-prompts of every effect that decided 'continue'; a failing effect
 * contributes nothing (logged, never thrown).
 */
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
