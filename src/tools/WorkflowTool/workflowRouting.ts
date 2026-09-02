// ============================================================================
//  workflowRouting — the opt-in orchestrator/executor tier default (P9).
//
//  agent({tier:'orchestrator'|'executor'}) lets a workflow script express WHICH
//  doctrine tier an agent belongs to instead of naming a model. OPT-IN
//  (default-OFF): a default-ON flip was reverted because routing a
//  declared `executor` tier to claude-sonnet-5 with no operator asked
//  contradicts Mercury's standing "ASK THE OPERATOR which model before
//  spawning any agent/workflow" rule (scripts/workflows/prove-workflow-routing.ts
//  pins the OFF default) — the operator opts in with
//  MERCURY_WORKFLOW_ROUTING=1. With the flag ON, an 'executor' agent with no
//  explicit model routes to THE NEUTRAL SEAT DEFAULT — the most recent
//  sign-in's provider, its newest usable row (the one seat resolver the
//  coordinator's launches and the crew spawn ask; no family is favoured) —
//  while 'orchestrator' keeps the main-loop model; with no usable sign-in
//  anywhere nothing routes (undefined — never a family the account does not
//  hold). An EXPLICIT opts.model always wins over the tier, with the flag
//  OFF the tier changes nothing (byte-identical), and a junk tier value
//  ALWAYS throws (typos fail fast regardless of the flag, mirroring the
//  agent({effort}) validation). Live env read on every call (authority-
//  toggles rule).
// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'

export const WORKFLOW_TIERS = ['orchestrator', 'executor'] as const
export type WorkflowTier = (typeof WORKFLOW_TIERS)[number]

/** The routed execution-tier model: the neutral seat default's setting, or
 *  undefined with no usable sign-in (a pinned first-party id here was the
 *  favoured family — an account signed into another provider alone had
 *  every routed executor refuse; the pinned id's last repin, opus-5 over
 *  the drifted sonnet-5 remnant, retired with the pin). The seat owner is
 *  required at call time (the deferred-require idiom) so the router's
 *  module graph stays light. */
export function workflowExecutorModel(): string | undefined {
  const { neutralSeatDefault } =
    require('../../services/concourse/workerModels.js') as typeof import('../../services/concourse/workerModels.js')
  return neutralSeatDefault()?.setting
}

/** Opt-in gate — live env read per call (default-OFF; =1 arms routing;
 *  anything else leaves the declared tiers inert). */
export function workflowRoutingEnabled(): boolean {
  return flagEnv('MERCURY_WORKFLOW_ROUTING') === '1'
}

/** Throws on a junk tier value (ALWAYS — flag-independent, typos fail fast). */
export function validateWorkflowTier(tier: unknown): void {
  if (tier === undefined) return
  if (typeof tier !== 'string' || !(WORKFLOW_TIERS as readonly string[]).includes(tier)) {
    throw new TypeError(
      `agent({tier}) must be one of ${WORKFLOW_TIERS.join(' | ')}; got ${JSON.stringify(tier)}`,
    )
  }
}

/**
 * The model agent({tier}) routes to, or undefined when nothing should change:
 * flag OFF, no tier, an explicit model present, orchestrator tier (which
 * IS the main-loop fallthrough — writing it would be a no-op that could still
 * perturb resume cache keys, so we deliberately write nothing), or no usable
 * sign-in anywhere (nothing to route to honestly).
 */
export function resolveWorkflowRoutedModel(opts: {
  tier?: unknown
  model?: unknown
}): string | undefined {
  if (!workflowRoutingEnabled()) return undefined
  if (opts.tier !== 'executor') return undefined
  if (opts.model !== undefined && opts.model !== null) return undefined
  return workflowExecutorModel()
}
