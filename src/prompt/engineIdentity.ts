// ============================================================================
//  prompt/engineIdentity — the ONE owner of the harness+engine identity line
//  that every assembled seat prompt carries, harness-supplied: Mercury is what
//  the seat IS, and the resolved model id is what it RUNS ON. Identity is
//  layered, never hidden — both halves are stated, so "what model are you" has
//  a grounded answer instead of a guess.
//
//  ONE owner, every seat: the coordinator (services/concourse/coordinatorCall),
//  the main loop and every subagent (constants/prompts env blocks), and the
//  workers the daemon spawns (full Mercury sessions — the main-loop path).
//
//  Provider-neutral by construction: the id is whatever the harness resolved
//  for THIS seat at assembly time — anthropic, gpt-*, glm-*, a compat id, a
//  local server — and the marketing name rides only when the registry knows
//  one. No family is assumed and no family is named in the sentence itself.
//
//  THE EQUALITY: the id in the assembled prompt is the id the dispatch stamps
//  for that seat. Prompt-side and wire-side read the same resolution, so a
//  model switch mid-session re-assembles onto the new id.
// ============================================================================

import { getMarketingNameForModel, normalizeModelStringForAPI } from '../utils/model/model.js'

/**
 * The harness-supplied engine line for a seat running on `modelId`. The id
 * appears as the WIRE id (backticked) so a seat can quote exactly what the
 * dispatch stamps; the marketing name rides beside it when the model
 * registry knows one. A context-window suffix on the setting (`[1m]`) is a
 * window, not a model: it is normalized away here, so toggling the window on
 * one model keeps the top-level system prompt byte-identical and every
 * thinking block bound to it.
 */
export function mercuryEngineIdentityLine(modelId: string): string {
  const wireId = normalizeModelStringForAPI(modelId)
  const marketing = getMarketingNameForModel(wireId)
  // The ID LEADS, always in the same place and the same shape — a seat
  // quoting itself, and a prover reading the line back, both find it without
  // knowing whether the registry happened to know a name for it.
  const named = marketing !== null && marketing.length > 0 ? ` (${marketing})` : ''
  return `Mercury is what you are; the model you run through Mercury is \`${wireId}\`${named}. That id is your engine, never a second name for you: asked which model runs you, name it plainly and exactly; asked who you are, the answer is Mercury.`
}
