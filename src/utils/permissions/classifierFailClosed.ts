// ============================================================================
//  utils/permissions/classifierFailClosed.ts — the auto-mode fail-closed guard.
// ----------------------------------------------------------------------------
//  By the time the permission ladder reaches the auto-mode classifier the
//  decision is already 'ask'. classifyYoloAction short-circuits an EMPTY
//  projection (`toAutoClassifierInput → ''`) to shouldBlock:false — "this tool
//  declares no classifier-relevant input, allow it". That is correct for a tool
//  that DELIBERATELY opted out (its own `() => ''`), but it is a fail-OPEN
//  footgun for a tool that NEVER overrode the projection at all: it never opted
//  in OR out, yet it is silently auto-allowed with no classification.
//
//  This guard closes that hole. When enabled, an empty projection that came from
//  the still-defaulted `toAutoClassifierInput` (it carries the buildTool default
//  marker — isToolDefaultFn) is routed to a human-review BLOCK instead of a
//  silent allow. A deliberate per-tool `() => ''` is UNMARKED and so is honored
//  as before (allow).
//
//  GATED DEFAULT-OFF, opt-in via MERCURY_CLASSIFIER_FAIL_CLOSED=1. OFF ⇒ the guard
//  never fires ⇒ byte-identical to base (same silent allow as today). This is a
//  pure, loadable module (no `feature()`/bundle deps) so the proof can drive the
//  real decision with real Tool objects — see scripts/permissions/prove-classifier-fail-closed.ts.
// ============================================================================

import type { Tool } from '../../Tool.js'
import { isToolDefaultFn } from '../../Tool.js'
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/**
 * Minimal shapes mirrored from yoloClassifier's TranscriptEntry + ToolLookup so
 * this module stays loadable (yoloClassifier itself is not — it pulls a
 * bundle-only `feature()` macro). Structurally compatible with the real types.
 */
export type FailClosedAction = {
  content: ReadonlyArray<{ type: string; name?: string }>
}
export type FailClosedLookup = { get(name: string): Tool | undefined }

/**
 * Is the auto-mode fail-closed guard enabled? DEFAULT-OFF — opt-in only via
 * MERCURY_CLASSIFIER_FAIL_CLOSED=1. Pure env gate (no fork dependency) so OFF is
 * byte-identical and the behavior is identical headless / interactive / in the
 * proof harness.
 */
export function classifierFailClosedEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_CLASSIFIER_FAIL_CLOSED'))
}

/**
 * The reason surfaced when the guard fires — names the cause and the opt-out so
 * the operator/model can act on it (set the tool's toAutoClassifierInput, or
 * disable the guard).
 */
export const FAIL_CLOSED_REASON =
  'Tool declares no classifier-relevant input and did not override the security projection — blocking for safety (set toAutoClassifierInput, or unset MERCURY_CLASSIFIER_FAIL_CLOSED)'

/**
 * True when a tool reaching the classifier with an EMPTY projection is a
 * fail-OPEN footgun: it is a real, resolved tool whose `toAutoClassifierInput`
 * is STILL the buildTool default (marked) — i.e. the author never opted in OR
 * out. A tool that resolves to null/undefined (unknown tool / text action) is
 * NOT caught (returns false — preserve the prior allow). A deliberate `() => ''`
 * override is unmarked ⇒ returns false ⇒ honored as before.
 */
export function isDefaultProjectorTool(tool: Tool | null | undefined): boolean {
  return tool != null && isToolDefaultFn(tool.toAutoClassifierInput)
}

/**
 * Decide whether an empty-projection action must be blocked by the fail-closed
 * guard. Returns true ⇒ the caller returns shouldBlock:true with
 * FAIL_CLOSED_REASON; false ⇒ the caller keeps the prior silent-allow.
 *
 * `tool` is the resolved Tool for the action's single tool_use block (null when
 * the action is text or names an unknown tool). Pure — no I/O, never throws.
 */
export function shouldFailClosedOnEmptyProjection(
  tool: Tool | null | undefined,
): boolean {
  return classifierFailClosedEnabled() && isDefaultProjectorTool(tool)
}

/**
 * Resolve the single tool_use block of an action to its Tool, or null. The
 * action is a one-block tool_use entry (formatActionForClassifier); a text /
 * multi-block / unknown-tool action returns null.
 */
export function actionToolFor(
  action: FailClosedAction,
  lookup: FailClosedLookup,
): Tool | null {
  if (action.content.length !== 1) return null
  const block = action.content[0]
  if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') {
    return null
  }
  return lookup.get(block.name) ?? null
}

/**
 * The full empty-projection verdict for the classifier: when the guard is ON
 * and the action's tool is a still-defaulted projector, returns BLOCK (with the
 * fail-closed reason); otherwise null ⇒ the caller keeps the prior silent-allow.
 * This is the EXACT decision classifyYoloAction runs for an empty projection —
 * exported so the proof drives the real path (yoloClassifier is unloadable).
 */
export function emptyProjectionFailClosedVerdict(
  action: FailClosedAction,
  lookup: FailClosedLookup,
): { shouldBlock: true; reason: string } | null {
  const tool = actionToolFor(action, lookup)
  if (shouldFailClosedOnEmptyProjection(tool)) {
    return { shouldBlock: true, reason: FAIL_CLOSED_REASON }
  }
  return null
}
