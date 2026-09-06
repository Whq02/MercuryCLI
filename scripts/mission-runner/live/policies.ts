import { createHash } from 'node:crypto'
import type { HelixFamilyId, HelixTask } from '../corpus/contracts.js'

export interface HelixPolicy {
  id: string
  description: string
  model: string
  effort: 'medium' | 'high' | 'xhigh' | 'max'
  env: Record<string, string>
  briefPrefix?: string
  briefSuffix?: string
  reviewerArmed?: boolean
  applicableFamilies?: HelixFamilyId[]
  headlessUnavailableReason?: string
  collaborationOnly?: boolean
}

export const HELIX_POLICIES: HelixPolicy[] = [
  {
    id: 'solo',
    description: 'solo-current-default — one normal strong-model Mercury run',
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
      ' Before declaring completion, dispatch the verification subagent (Task tool, subagent_type "mercury-verifier") to adversarially review the work against this mission, then address any real findings it reports. End your final message with ONE line of the exact form: REVIEW: accept|revise|reject [reqs: <ids>] [next: <one action>] reflecting the reviewer’s verdict.',
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
      'router-current — adaptive routing (the route fabric)',
    model: 'claude-opus-4-8',
    effort: 'high',
    env: {},
    headlessUnavailableReason:
      'Route compilation engages via the operator-engaged routing surfaces (RouteWork over the coordination bus); a headless -p run has no routing seat — no current product path',
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
    return { applicable: true }
  }
  if (policy.applicableFamilies && !policy.applicableFamilies.includes(task.family)) {
    return {
      applicable: false,
      reason: 'policy ' + policy.id + ' is declared for families ' + policy.applicableFamilies.join('/') + ', task family is ' + task.family,
    }
  }
  return { applicable: true }
}
