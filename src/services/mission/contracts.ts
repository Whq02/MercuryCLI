
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

export interface MissionCardView {
  sessionId: string
  goal: string
  state: string
  nextStep: string | null
  iterations: number
  updatedAt: string
}

export interface MissionFingerprint {
  available: boolean
  workspace: string
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  changedCount: number
  provenance: string | null
}

export interface MissionMemoryRef {
  refId: string
  status: string
  why: string
}

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
  nodeAttemptCeiling: number
  planRevisions: number
}

export interface MissionOutcome {
  state: 'accepted' | 'failed' | 'cancelled' | 'completed'
  at: number
}

export interface MissionView {
  schema: typeof MISSION_SCHEMA
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
  decisionPoints: string[]
  synthesisGaps: string[]
  card: MissionCardView | null
  outcome: MissionOutcome | null
  generatedAtMs: number
}

export const MISSION_MEMORY_CAP = 6
export const MISSION_DECISION_POINT_CAP = 4
export const MISSION_PLAN_CAP = 4
export const MISSION_EXECUTION_CAP = 12
