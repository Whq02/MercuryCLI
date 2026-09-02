// ============================================================================
//  invocationContract — WHAT KIND OF INVOCATION IS THIS, resolved once
//
//
//  The field defect: every surface inherited the interactive
//  ask-and-continue posture because nothing TYPED the difference — a plain
//  `-p` Write earned "Run-state check" continuations (2× per run, 8/8 field
//  runs) after its effects had already settled. The contract names the
//  surface and its terminal policy ONCE, at the earliest ingress that knows,
//  and the stop/continuation authority consumes it instead of re-deriving
//  scattered env checks.
//
//  Product laws (binding):
//    · a plain print request is ONE-SHOT — it completes when requested
//      effects settle and a terminal result exists;
//    · print with a DECLARED mission (/mission armed) is mission-led;
//    · SDK stays client-led (the client owns continuation);
//    · interactive keeps ask-and-continue (operator-led).
//
//  Pure resolution — callers pass what they know; nothing here reads env.
// ============================================================================

export type InvocationSurface =
  | 'interactive'
  | 'print'
  | 'sdk'
  | 'worker'
  | 'workflow'
  | 'external'

export type TerminalPolicy = 'operator-led' | 'one-shot' | 'client-led' | 'mission-led'

export interface InvocationContract {
  surface: InvocationSurface
  terminalPolicy: TerminalPolicy
}

/** Resolve the contract from ingress facts. `missionArmed` = a /mission (or
 *  equivalent declared multi-turn mission) is active for this session. */
export function resolveInvocationContract(facts: {
  interactive: boolean
  missionArmed: boolean
  querySource?: string
}): InvocationContract {
  const source = facts.querySource ?? ''
  if (facts.interactive) {
    return { surface: 'interactive', terminalPolicy: facts.missionArmed ? 'mission-led' : 'operator-led' }
  }
  if (source === 'sdk') {
    return { surface: 'sdk', terminalPolicy: facts.missionArmed ? 'mission-led' : 'client-led' }
  }
  if (source.startsWith('agent:')) {
    return { surface: 'worker', terminalPolicy: 'one-shot' }
  }
  return { surface: 'print', terminalPolicy: facts.missionArmed ? 'mission-led' : 'one-shot' }
}
