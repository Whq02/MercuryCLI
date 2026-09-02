// ============================================================================
//  scripts/mission-runner/live/policies.ts — the measured policy arms (H1
//  baseline set; H3 narrows these into the product's bounded profile layer).
//
//  Every policy is DATA: schema-validated, digest-stable, explainable.
//  Applicability is declared per family — an unavailable/unsuitable policy is
//  recorded NOT APPLICABLE with a typed reason, never forced.
//  Spend law (§12.2 destalement): Anthropic on the Max subscription, Sol on
//  the ChatGPT subscription — never API-key funding, never Fable without an
//  explicit operator opt-in.
// ============================================================================
import { createHash } from 'node:crypto'
import type { HelixFamilyId, HelixTask } from '../corpus/contracts.js'

export interface HelixPolicy {
  id: string
  description: string
  /** --model for the primary dispatch. */
  model: string
  /** The effort wire: MERCURY_EFFORT_LEVEL (and the external arm's own env contract). */
  effort: 'medium' | 'high' | 'xhigh' | 'max'
  /** Extra env for the launch. */
  env: Record<string, string>
  briefPrefix?: string
  briefSuffix?: string
  /** Requests + parses the typed REVIEW tail (H4 §9). */
  reviewerArmed?: boolean
  /** undefined = applicable to every family. */
  applicableFamilies?: HelixFamilyId[]
  /** Policies that are structurally unavailable to the headless runner. */
  headlessUnavailableReason?: string
  /** Family-16 only rides the lab. */
  collaborationOnly?: boolean
}

export const HELIX_POLICIES: HelixPolicy[] = [
  {
    id: 'solo',
    description: 'solo-current-default — one normal strong-model Mercury run',
    // close: 'current default' had drifted a generation —
    // the strong model is Opus 5 (operator-directed for the paid close
    // benchmarks). The digest changes with this, which is why the freeze is
    // re-minted before any qualified run.
    model: 'claude-opus-5',
    effort: 'high',
    env: {},
  },
  {
    id: 'solo-fable',
    description:
      'solo-fable — the identical solo path on Fable 5 (the per-model half of the action-interface measure; subscription-included)',
    model: 'claude-fable-5',
    effort: 'high',
    env: {},
  },
  {
    id: 'crucible-anchor',
    description:
      "crucible-anchor — the crucible R2 same-model pair's Mercury side: built Mercury, Fable 5 at max effort (one predeclared demanding effort, fixed at CR-0; the external side is the claude-code-max adapter arm)",
    model: 'claude-fable-5',
    effort: 'max',
    env: {},
  },
  {
    id: 'solo-reviewer',
    description:
      'solo-reviewer-assisted — the same base path armed with the current verification red-team subagent before completion',
    model: 'claude-opus-4-8',
    effort: 'high',
    env: {},
    reviewerArmed: true,
    briefSuffix:
      ' Before declaring completion, dispatch the verification subagent (Task tool, subagent_type "verification") to adversarially review the work against this mission, then address any real findings it reports. End your final message with ONE line of the exact form: REVIEW: accept|revise|reject [reqs: <ids>] [next: <one action>] reflecting the reviewer’s verdict.',
  },
  {
    id: 'specialist-sol',
    description:
      'specialist-current — the native GPT lane (gpt-5.6-sol in-process on the Responses transport), the measurable §4.1 #11/#13 policy axis',
    model: 'gpt-5.6-sol',
    effort: 'high',
    env: {},
    applicableFamilies: [1, 8, 11, 13],
  },
  {
    id: 'workflow',
    description:
      'workflow-current — the dynamic Workflow engine composes the work (explicit opt-in phrase in the mission text)',
    model: 'claude-opus-4-8',
    effort: 'high',
    env: {},
    briefPrefix:
      'Use a workflow to organize this work where parallel fan-out genuinely helps (the lanes are disjoint). ',
    applicableFamilies: [7, 9],
  },
  {
    id: 'router',
    description:
      'router-current — adaptive routing (the Scribe/party routing brain)',
    model: 'claude-opus-4-8',
    effort: 'high',
    env: {},
    headlessUnavailableReason:
      'Route compilation engages via the operator-engaged Scribe/party surfaces (RouteWork over the seat bus); a headless -p run has no routing seat — no current product path',
  },
  {
    id: 'collaboration',
    description:
      'collaboration-current — the accepted two-seat collaboration lab on the one collaboration task',
    model: 'claude-opus-4-8',
    effort: 'high',
    env: {},
    applicableFamilies: [16],
    collaborationOnly: true,
    headlessUnavailableReason:
      'the accepted collaboration lab drives its own seeded world + journeys (J1–J14); no accepted path mounts an external corpus mission — the collaboration task runs under the single-seat arms instead',
  },
]

export function policyById(id: string): HelixPolicy {
  const policy = HELIX_POLICIES.find(p => p.id === id)
  if (!policy) throw new Error('unknown helix policy: ' + id)
  return policy
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function policyDigest(policy: HelixPolicy): string {
  return 'hp1-' + createHash('sha256').update(stableStringify(policy)).digest('hex').slice(0, 16)
}

/** Typed applicability — NOT APPLICABLE is a recorded outcome, never a skip. */
export function policyApplicability(
  policy: HelixPolicy,
  task: HelixTask,
): { applicable: true } | { applicable: false; reason: string } {
  if (policy.headlessUnavailableReason) {
    return { applicable: false, reason: policy.headlessUnavailableReason }
  }
  if (policy.collaborationOnly && !task.runner?.collaboration) {
    return { applicable: false, reason: 'collaboration policy rides the two-seat lab; this task is single-seat' }
  }
  if (task.runner?.collaboration && !policy.collaborationOnly) {
    return { applicable: true } // single-seat arms may still run the collab task solo (the honest baseline)
  }
  if (policy.applicableFamilies && !policy.applicableFamilies.includes(task.family)) {
    return {
      applicable: false,
      reason: 'policy ' + policy.id + ' is declared for families ' + policy.applicableFamilies.join('/') + ', task family is ' + task.family,
    }
  }
  return { applicable: true }
}
