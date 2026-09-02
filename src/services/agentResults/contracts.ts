
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
  summary: string
  findings: string[]
  changedPaths: string[]
  failedAttempts: number
  artifacts: string[]
  checks: EnvelopeCheck[]
  unresolved: string[]
  recommendedNextAction?: string
  usage?: { totalTokens?: number; toolUseCount?: number; durationMs?: number }
  fullOutputRef: string
  evidenceRefs?: string[]
  malformedDeclarationRef?: string
}

export const declaredEnvelopeSchema = z
  .object({
    summary: z.string().max(2000).optional(),
    findings: z.array(z.string().max(500)).max(20).optional(),
    unresolved: z.array(z.string().max(500)).max(20).optional(),
    recommendedNextAction: z.string().max(500).optional(),
    checks: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict()

export type DeclaredEnvelope = z.infer<typeof declaredEnvelopeSchema>

export const ENVELOPE_DOCTRINE = `Structured completion (optional but preferred): end your FINAL message with a <${ENVELOPE_TAG}>{…}</${ENVELOPE_TAG}> block — JSON with any of: "summary" (one paragraph), "findings" (string[]), "unresolved" (string[]), "recommendedNextAction", "checks" (names of verification commands you actually ran). Changed paths and check outcomes are cross-checked against observed tool effects — never claim work the tools did not record.`
