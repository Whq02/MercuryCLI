// ============================================================================
//  services/mission/contracts — the MissionView vocabulary (H2).
//
//  ONE typed PROJECTION over facts other owners already produce — the run
//  kernel's objective/lifecycle, the router's durable route plans + decisions,
//  the project-intel snapshot generation, the memory refs, the execution
//  plane's live census and the verify-evidence digest. It is a composition
//  RECORD: every field is a reference or a bounded summary of an owner's
//  fact — never a second lifecycle machine, never copied status booleans
// that could drift from their owners (brief).
//
//  Idle law: no mission-shaped fact (no substantive run objective, no live
//  route plan) ⇒ NO view — surfaces render nothing, zero standing cost.
//
//  Gate: MERCURY_MISSION (flagRegistry, default-on, additive). `=0` ⇒ no
//  projection, mercury://mission unavailable, no /run row — byte-identical.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function missionEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_MISSION'))
}

export const MISSION_SCHEMA = 1 as const

export interface MissionGoal {
  source: 'run-objective' | 'route-plan' | 'mission-card' | 'none'
  text: string | null
}

/** REFERENCES the session's persisted mission card (services/mission/
 *  missionCard.ts owns the lifecycle) — goal · state · next step, the
 *  continuity fact a resumed session or a concourse teammate reads. */
export interface MissionCardView {
  sessionId: string
  goal: string
  state: string
  nextStep: string | null
  iterations: number
  updatedAt: string
}

/** REFERENCES the project-intel snapshot generation — never a copied snapshot. */
export interface MissionFingerprint {
  available: boolean
  workspace: string
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  changedCount: number
  /** The snapshot cache provenance ('cache-validated' · 'fresh' · …). */
  provenance: string | null
}

export interface MissionMemoryRef {
  refId: string
  status: string
  why: string
}

/** The policy fact: the router's own decision record when a plan exists, else the
 *  current accepted default. H3 layers the measured selector onto the same
 *  field — the source names which authority chose. */
export interface MissionPolicy {
  profile: string
  source: 'route-decision' | 'current-default' | 'operator-pin' | 'measured-selector'
  reasonCodes: string[]
  posture: string | null
}

export interface MissionNodeRef {
  planId: string
  nodeId: string
  title: string
  state: string
  attempt: number
  dependsOn: string[]
  ownsPaths: string[]
  model: string | null
  worker: string | null
}

export interface MissionPlanRef {
  planId: string
  revision: number
  mode: string
  state: string
  profile: string
  reasonCodes: string[]
  synthesisOwner: string | null
  nodes: MissionNodeRef[]
}

export interface MissionExecutionRef {
  kind: string
  id: string
  state: string
}

export interface MissionEvidenceRef {
  treeDigest: string | null
  available: boolean
}

export interface MissionReplanAllowance {
  /** The router's own per-node attempt ceiling (referenced, not re-invented). */
  nodeAttemptCeiling: number
  /** Revisions observed across the active plans. */
  planRevisions: number
}

export interface MissionOutcome {
  state: 'accepted' | 'failed' | 'cancelled' | 'completed'
  at: number
}

export interface MissionView {
  schema: typeof MISSION_SCHEMA
  /** Stable identity: digest over workspace + goal + active plan ids. */
  missionId: string
  workspace: string
  goal: MissionGoal
  fingerprint: MissionFingerprint
  memory: MissionMemoryRef[]
  policy: MissionPolicy
  plans: MissionPlanRef[]
  executions: MissionExecutionRef[]
  evidence: MissionEvidenceRef
  replan: MissionReplanAllowance
  /** Bounded, derived from observable facts (held nodes, revising plans). */
  decisionPoints: string[]
  /** The synthesis view NAMES missing/rejected nodes — never prose-fills. */
  synthesisGaps: string[]
  /** The session's own /mission card, when one exists (additive; null when
   *  no card or the card store is unreadable). */
  card: MissionCardView | null
  outcome: MissionOutcome | null
  generatedAtMs: number
}

export const MISSION_MEMORY_CAP = 6
export const MISSION_DECISION_POINT_CAP = 4
export const MISSION_PLAN_CAP = 4
export const MISSION_EXECUTION_CAP = 12
