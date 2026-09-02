// ============================================================================
//  run-core/call-reference — the per-call FROZEN capability/tool reference
//
//
//  One sampling step = one immutable reference to what the call was made
//  with: the capability envelope (model · requested effort · output-token
//  override) and the FINALIZED tool plan for that specific step (the Codex
//  step-scoped-router law: "execution must retain the finalized tool plan
//  for that specific step"). The turn machine builds it per attempt at the
//  model_call_started emit seam — a provider-fallback retry is a new
//  attempt and mints a NEW reference; the tool catalogue refresh stays at
//  turn boundaries (turn-machine close-of-turn), so an in-flight call's
//  reference can never drift under it.
//
//  Digest form: content-addressed sha256 over explicit array material
//  (never incidental object-key order) — the changeSetPlan planDigest
//  precedent. Tool names ride in WIRE ORDER: serialization order is
//  prompt-cache identity, so an order change is a real identity change.
//
//  Consumers: the model_call_started event payload (run-core/events.ts);
//  the prompt-state receipt at the sampling-call sites; the
//  TransitionPlan capability-epoch stale check.
// ============================================================================
import { createHash } from 'node:crypto'

export type ModelCallReference = {
  v: 1
  /** The capability envelope for THIS call. */
  model: string
  /** REQUESTED effort intent (pre-resolution — see model_call_started). */
  effortRequested: string | undefined
  maxOutputTokensOverride: number | undefined
  /** The finalized tool plan for this step, in wire order. */
  toolCount: number
  toolNames: readonly string[]
  /** Digest of the tool plan alone (names, wire order). */
  toolPlanDigest: string
  /** Digest of the whole reference — the call's frozen identity. */
  digest: string
}

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data).digest('hex')

/**
 * Build the frozen reference for one model-call attempt. Deterministic:
 * identical inputs yield identical digests; any change to model, effort,
 * override, tool membership, or tool ORDER changes `digest`. The returned
 * object (and its toolNames array) is deep-frozen.
 */
export function buildModelCallReference(args: {
  model: string
  effort: string | number | undefined
  maxOutputTokensOverride: number | undefined
  tools: ReadonlyArray<{ name: string }>
}): ModelCallReference {
  const effortRequested =
    args.effort === undefined ? undefined : String(args.effort)
  const toolNames = Object.freeze(args.tools.map(t => t.name))
  const toolPlanDigest = sha256Hex(
    JSON.stringify({ v: 1, tools: toolNames }),
  )
  const digest = sha256Hex(
    JSON.stringify({
      v: 1,
      model: args.model,
      effort: effortRequested ?? null,
      maxOut: args.maxOutputTokensOverride ?? null,
      tools: toolNames,
    }),
  )
  return Object.freeze({
    v: 1,
    model: args.model,
    effortRequested,
    maxOutputTokensOverride: args.maxOutputTokensOverride,
    toolCount: toolNames.length,
    toolNames,
    toolPlanDigest,
    digest,
  })
}
