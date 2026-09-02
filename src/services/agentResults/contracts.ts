// ============================================================================
//  agentResults/contracts — the versioned AgentResultEnvelope (
// every agent completion converges on ONE structured product at
//  the parent boundary.
//
//  The honesty split that makes this trustworthy:
//    · DECLARED fields (summary, findings, unresolved, next action, checks
//      the agent SAYS it ran) come from the agent's optional structured
//      tail block — <mercury-envelope>{json}</mercury-envelope>;
//    · OBSERVED fields (changedPaths, failed attempts, check outcomes) come
//      from the effect observer's receipts + the verification evidence for
//      the agent's OWNER LANE — a completion can never claim a mutation or
//      a check the chokepoint did not see.
//
//  Boundary map (recorded — the convergence contract):
//    · foreground AgentTool + background LocalAgentTask → THIS envelope
//      (built by normalize.ts at their parent boundaries);
//    · Workflow agents → the Workflow engine's StructuredOutput schema
//      results (an existing, stricter structured-completion contract);
//    · teammates → the typed bus envelopes + HANDOFF PACKET at
//      the subagent-doctrine addendum seam (existing structured products).
// ============================================================================

import { z } from 'zod/v4'

export const AGENT_ENVELOPE_VERSION = 1
export const ENVELOPE_TAG = 'mercury-envelope'

export type CheckState = 'requested' | 'observed' | 'failed' | 'skipped' | 'unknown'

export interface EnvelopeCheck {
  name: string
  state: CheckState
  detail?: string
}

export interface AgentResultEnvelope {
  version: typeof AGENT_ENVELOPE_VERSION
  agentId: string
  agentType?: string
  status: 'completed' | 'failed' | 'stopped'
  /** One paragraph — declared by the agent, or clipped from its final text. */
  summary: string
  findings: string[]
  /** OBSERVED — from the agent lane's receipts, never prose claims. */
  changedPaths: string[]
  /** OBSERVED failed/indeterminate mutation attempts in the lane. */
  failedAttempts: number
  artifacts: string[]
  checks: EnvelopeCheck[]
  unresolved: string[]
  recommendedNextAction?: string
  usage?: { totalTokens?: number; toolUseCount?: number; durationMs?: number }
  /** Where the full output lives (mercury://agent/<id>). */
  fullOutputRef: string
  /** Canonical evidence refs from the agent's owner lane (
   *  additive and optional; existing consumers are unaffected). */
  evidenceRefs?: string[]
  /** Set when the agent's structured tail failed validation — the raw block
   *  is preserved at this artifact ref, never silently dropped. */
  malformedDeclarationRef?: string
}

/** What an agent may DECLARE in its structured tail (everything optional —
 *  a partial declaration is still a declaration). */
export const declaredEnvelopeSchema = z
  .object({
    summary: z.string().max(2000).optional(),
    findings: z.array(z.string().max(500)).max(20).optional(),
    unresolved: z.array(z.string().max(500)).max(20).optional(),
    recommendedNextAction: z.string().max(500).optional(),
    /** Names of checks the agent says it ran — cross-checked against the
     *  observer; unverifiable names surface as 'unknown', never 'observed'. */
    checks: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict()

export type DeclaredEnvelope = z.infer<typeof declaredEnvelopeSchema>

/** The doctrine text spliced into subagent prompts (the ONE addendum seam). */
export const ENVELOPE_DOCTRINE = `Structured completion (optional but preferred): end your FINAL message with a <${ENVELOPE_TAG}>{…}</${ENVELOPE_TAG}> block — JSON with any of: "summary" (one paragraph), "findings" (string[]), "unresolved" (string[]), "recommendedNextAction", "checks" (names of verification commands you actually ran). Changed paths and check outcomes are cross-checked against observed tool effects — never claim work the tools did not record.`
