/**
 * DecisionTrace — the machine-readable record of ONE run through the owned
 * permission decision engine.
 *
 * Every stage the engine consults appends a record, in chain order; the stage
 * that produces the terminal decision is marked `decided` and named in
 * `decidedBy`. The trace is the observability contract for the decision
 * chain: scripts/decisions/prove-decision-trace.ts pins that a trace's stage
 * sequence is always an exact prefix of DECISION_STAGE_ORDER for its entry.
 *
 * Pure data — no clock, no ids, no effects — so identical inputs yield
 * identical traces.
 */

/** Which engine entry produced the trace. `full` is the complete chain behind
 *  hasPermissionsToUseTool; `ruleSubset` is the bypass-immune rule band behind
 *  checkRuleBasedPermissions (the hook-allow guard path). */
export type DecisionEntry = 'full' | 'ruleSubset'

/**
 * The ordered stage vocabulary. Names map onto the frozen matrix contract
 * (scripts/decisions/prove-decision-matrix.ts):
 *   killSwitch         — 0   operator capability kill-switch
 *   toolDenyRule       — 1a  tool-level deny rule (bypass-immune)
 *   toolAskRule        — 1b  tool-level ask rule (fires even in bypass)
 *   toolVerdict        — 1c  tool.checkPermissions resolution (never decides;
 *                            failures degrade to passthrough, never allow)
 *   toolVerdictDeny    — 1d  tool deny (bypass-immune)
 *   userInteractionAsk — 1e  requiresUserInteraction ask (bypass-immune)
 *   contentAskRule     — 1f  content-specific ask RULE (bypass-immune)
 *   orgAskCeiling      — 1f' MCP org ask-ceiling (bypass-immune)
 *   safetyCheckAsk     — 1g  safetyCheck ask (bypass-immune)
 *   bypassPosture      — 2a  bypass-posture modes → allow
 *   toolAllowRule      — 2b  tool-level allow rule → allow
 *   resolution         — 3   passthrough→ask conversion / verdict stands
 */
export type DecisionStageId =
  | 'killSwitch'
  | 'toolDenyRule'
  | 'toolAskRule'
  | 'toolVerdict'
  | 'toolVerdictDeny'
  | 'userInteractionAsk'
  | 'contentAskRule'
  | 'orgAskCeiling'
  | 'safetyCheckAsk'
  | 'bypassPosture'
  | 'toolAllowRule'
  | 'resolution'

/** The exact stage order per entry. A trace's stage sequence is always a
 *  prefix of this list (the engine records every stage it consults, in order,
 *  and stops at the deciding one). */
export const DECISION_STAGE_ORDER: Record<
  DecisionEntry,
  readonly DecisionStageId[]
> = {
  full: [
    'killSwitch',
    'toolDenyRule',
    'toolAskRule',
    'toolVerdict',
    'toolVerdictDeny',
    'userInteractionAsk',
    'contentAskRule',
    'orgAskCeiling',
    'safetyCheckAsk',
    'bypassPosture',
    'toolAllowRule',
    'resolution',
  ],
  // The rule subset never consults the kill-switch (enforced by the full chain
  // + the toolExecution.ts execution gate) nor requiresUserInteraction (the
  // caller pre-checks it), and terminates after the bypass-immune band.
  ruleSubset: [
    'toolDenyRule',
    'toolAskRule',
    'toolVerdict',
    'toolVerdictDeny',
    'contentAskRule',
    'orgAskCeiling',
    'safetyCheckAsk',
  ],
} as const

export interface DecisionStageRecord {
  stage: DecisionStageId
  /** `decided` — this stage produced the terminal decision; `pass` — consulted,
   *  no decision. */
  outcome: 'pass' | 'decided'
  /** Free-form diagnostic detail (verdict behavior, fallthrough cause, …). */
  note?: string
}

export interface DecisionTrace {
  entry: DecisionEntry
  toolName: string
  /** Permission mode at chain entry (stage 2a re-reads live state; its record
   *  notes the re-read mode when it decides). */
  mode: string
  stages: DecisionStageRecord[]
  /** The deciding stage, or 'none' for a ruleSubset run with no objection
   *  (the null decision — the mode layer decides later). */
  decidedBy: DecisionStageId | 'none'
}

/**
 * The MODE-WRAPPER band — the stages the wrapper (decision/wrapper.ts)
 * consults AFTER the engine chain yields its decision. Unlike the engine
 * band, wrapper stages are mode-gated, so a wrapper trace is an ordered
 * SUBSEQUENCE of this list (gaps allowed), not a prefix:
 *   allowDenialReset     — engine allow in flow resets the denial streak
 *   dontAskConversion    — dontAsk mode converts ask → deny
 *   autoSafetyImmunity   — non-approvable safetyCheck stays a human ask
 *                          (headless: structured deny)
 *   autoUserInteraction  — requiresUserInteraction ask stands in flow
 *   autoFloors           — ask-rule / org-ceiling / strategy-floor /
 *                          workflow-consent force the human ask (headless:
 *                          deny)
 *   powershellGuard      — PowerShell never reaches the classifier
 *   fastPathDangerFilter — dangerous prefix-allows hidden from the
 *                          fast-path's view (records, never decides)
 *   acceptEditsFastPath  — would-be-allowed-in-implement skips the classifier
 *                          (stage id predates the mode-identity migration)
 *   allowlistFastPath    — safe-tool allowlist skips the classifier
 *   classifier           — the flow (YOLO) classifier verdict
 *   denialLimit          — too many classifier denials → fall back to prompting
 *   headlessHooks        — PermissionRequest hooks for prompt-less agents
 *   headlessAutoDeny     — the final headless auto-deny
 */
export type WrapperStageId =
  | 'allowDenialReset'
  | 'dontAskConversion'
  | 'autoSafetyImmunity'
  | 'autoUserInteraction'
  | 'autoFloors'
  | 'powershellGuard'
  | 'fastPathDangerFilter'
  | 'acceptEditsFastPath'
  | 'allowlistFastPath'
  | 'classifier'
  | 'denialLimit'
  | 'headlessHooks'
  | 'headlessAutoDeny'

export const WRAPPER_STAGE_ORDER: readonly WrapperStageId[] = [
  'allowDenialReset',
  'dontAskConversion',
  'autoSafetyImmunity',
  'autoUserInteraction',
  'autoFloors',
  'powershellGuard',
  'fastPathDangerFilter',
  'acceptEditsFastPath',
  'allowlistFastPath',
  'classifier',
  'denialLimit',
  'headlessHooks',
  'headlessAutoDeny',
] as const

export interface WrapperStageRecord {
  stage: WrapperStageId
  outcome: 'pass' | 'decided'
  note?: string
}

/** The wrapper band's walk. `decidedBy: 'engine'` means the wrapper passed
 *  the engine decision through unchanged. */
export interface WrapperTrace {
  stages: WrapperStageRecord[]
  decidedBy: WrapperStageId | 'engine'
}

/** One-line rendering for debug logs: entry, tool, mode, then the stage walk
 *  with the deciding stage capitalized. */
export function formatDecisionTrace(trace: DecisionTrace): string {
  const walk = trace.stages
    .map(s =>
      s.outcome === 'decided'
        ? `${s.stage.toUpperCase()}${s.note ? `(${s.note})` : ''}`
        : `${s.stage}${s.note ? `(${s.note})` : ''}`,
    )
    .join(' → ')
  return `decision[${trace.entry}] ${trace.toolName} mode=${trace.mode}: ${walk} ⇒ ${trace.decidedBy}`
}
