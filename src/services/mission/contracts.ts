import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function missionEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_MISSION'))
}

export const MISSION_SCHEMA = 1 as const

interface MissionGoal {
  source: 'run-objective' | 'mission-card' | 'none'
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

interface MissionFingerprint {
  available: boolean
  workspace: string
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  changedCount: number

  provenance: string | null
}

interface MissionMemoryRef {
  refId: string
  status: string
  why: string
}

interface MissionPolicy {
  model: string | null
  source: 'session-model'
}

export interface MissionExecutionRef {
  kind: string
  id: string
  state: string
}

interface MissionEvidenceRef {
  treeDigest: string | null
  available: boolean
}

interface MissionOutcome {
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
  executions: MissionExecutionRef[]
  evidence: MissionEvidenceRef

  card: MissionCardView | null
  outcome: MissionOutcome | null
  generatedAtMs: number
}

export const MISSION_MEMORY_CAP = 6
export const MISSION_EXECUTION_CAP = 12
