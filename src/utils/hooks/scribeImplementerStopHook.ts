import {
  engageTurnSettlementEffect,
  disengageTurnSettlementEffect,
  type TurnSettlementDecision,
  type TurnSettlementEffect,
} from '../../query/settlementEffects.js'
import { isUnfinishedTail } from './unfinishedTail.js'
import { evaluateStopAttempt, lastAssistantText, repromptWithNextAction } from './runStopAdapter.js'
import { briefTurnSatisfiedByScribeBus } from '../scribe/scribeAwareness.js'

// ============================================================================
//  utils/hooks/scribeImplementerStopHook.ts — Scribe Mode "Amanuensis"
//  keep-working-until-done, role-specialized — an ENGINE settlement effect.
// ----------------------------------------------------------------------------
//  Both roles' packs *request* "keep working; don't end a turn on a plan, a
//  promise, or a question you can answer yourself". This settlement effect
//  ENFORCES it at the turn engine's settle phase (query/settlementEffects.ts
//  — the product's own semantics run as typed engine effects, not as
//  function hooks riding the user's hook registry; law 3: hooks belong to
//  the user). Same discipline as before the move: a per-TURN loop-brake so
//  a refusing agent is never wedged, the shared unfinished-tail detector
//  (isUnfinishedTail, unfinishedTail.ts), and the bus-send credit. What
//  differs is the RE-PROMPT, which is role-specific:
//    • Implementer: "keep working; escalate to the Scribe (operator proxy),
//      never the human" — the Implementer has no direct human channel.
//    • Scribe: "keep working as the operator's proxy; escalate to the human
//      only for a genuine operator-level decision".
//  The re-prompt never licenses bypassing a permission/approval/safety gate.
// ============================================================================

export type ScribeStopRole = 'scribe' | 'implementer'

/** Per-turn block cap before the keep-working effect gives up. The operator-
 *  facing Scribe gets a cap of 1 (a misclassified tail can cost at most ONE
 *  silent nudge, never a visible cascade); the autonomous Implementer keeps 3. */
const MAX_BLOCKS_BY_ROLE: Record<ScribeStopRole, number> = {
  scribe: 1,
  implementer: 3,
}

export const SCRIBE_STOP_HOOK_ID = 'scribe-stop-keep-working'
export const IMPLEMENTER_STOP_HOOK_ID = 'implementer-stop-keep-working'

// Leak-proof re-prompts. These are INTERNAL coordination nudges — the model must
// never mention, quote, or explain them to the operator, and must never make one
// its own visible turn (the observed friction: the Scribe narrated "that's the
// stop-rule hook firing…"). Worded affirmatively (what to do) so Opus generalizes
// rather than over-triggers, and they NEVER fire on a Scribe operator-question
// (the detector treats that as a valid rest), so they only ever land on a real
// promise/plan tail.
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

/**
 * Does the Implementer's CURRENT turn already carry a bus send (progress/escalate)?
 * Scopes the keep-working credit to this turn — everything since the last REAL inbound
 * user frame — exactly like the Scribe-side `since` window (stopHooks.ts:227-230).
 *
 * The credit must not scan the FULL transcript: after the
 * Implementer's first-ever envelope `briefTurnSatisfiedByScribeBus` would return true for
 * EVERY later Stop — keep-working permanently dead for the process lifetime and a
 * genuine "next I'll run the tests" tail was wrongly allowed to stop. Windowing restores
 * per-turn semantics: only a turn that ITSELF reported over the bus is credited. Pure +
 * defensive over the runtime message shape ⇒ unit-testable under `bun run`.
 */
export function implementerBusSendThisTurn(messages: readonly unknown[]): boolean {
  const arr = messages as ReadonlyArray<{ type?: string; isMeta?: boolean; toolUseResult?: unknown }>
  const lastUserIdx = arr.findLastIndex((m: { type?: string; isMeta?: boolean; toolUseResult?: unknown }) => m?.type === 'user' && !m.isMeta && !m.toolUseResult)
  return briefTurnSatisfiedByScribeBus(messages.slice(lastUserIdx + 1))
}

/**
 * Build the keep-working settlement effect for a role. Exported for the
 * proofs; production goes through register/unregister below. The evaluation
 * is the retired Stop hook's, verbatim in substance:
 *  - the per-TURN loop-brake (`blocks` resets when a fresh real user frame
 *    starts a new turn — the brake stops a refusal loop WITHIN one turn,
 *    never wedges across turns);
 *  - the bus-send credit (BOTH roles): a turn that already sent an envelope
 *    over the bus is a satisfied turn — its ONE envelope IS its report;
 *  - the shared completion evaluator decides (evidence over wording); the
 *    Scribe's trailing operator question stays a valid rest.
 */
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
      if (blocks >= maxBlocks) return { action: 'settle' } // loop-brake: never wedge the agent within a turn
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

/**
 * Engage the keep-working settlement effect for a session + role. Returns
 * the effect id. Idempotent via the fixed per-role id (re-engaging replaces
 * the prior effect).
 */
export function registerScribeImplementerStopHook(
  sessionId: string,
  role: ScribeStopRole,
  options?: { maxBlocks?: number },
): string {
  const effect = scribeImplementerSettlementEffect(role, options)
  engageTurnSettlementEffect(sessionId, effect)
  return effect.id
}

/** Remove the keep-working settlement effect for a session + role. */
export function unregisterScribeImplementerStopHook(
  sessionId: string,
  role: ScribeStopRole,
): void {
  disengageTurnSettlementEffect(sessionId, effectIdFor(role))
}
