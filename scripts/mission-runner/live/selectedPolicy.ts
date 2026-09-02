// ============================================================================
//  scripts/mission-runner/live/selectedPolicy.ts — the H3 'selected' runner arm.
// ----------------------------------------------------------------------------
//  Resolves the measured mission-policy selector per corpus task: the task's
//  FAMILY supplies the ground-truth fingerprint (the benchmark's structural
//  facts), the selector picks one of the six named profiles, and the profile
//  maps onto an executable runner arm. In-product 'routed' execution rides
//  the party fabric; the headless runner's equivalent measurable composition
//  is the Workflow engine — the mapping is RECORDED on every row
//  (executedAs), never silent.
// ============================================================================
import type { HelixTask } from '../corpus/contracts.js'
import {
  selectMissionPolicy,
  missionPolicyEpoch,
  type MissionPolicyDecision,
  type MissionTaskFingerprint,
} from '../../../src/services/mission/policyProfiles.js'
import { APEX_ARCHITECTURE_EPOCH } from '../../../src/services/providers/openai/openaiCatalogue.js'
import { readQualificationReceipts } from '../../../src/services/providers/openai/qualificationStore.js'
import { readMissionOutcomeStats } from '../../../src/substrate/routerOutcomeStore.js'

/** Family → ground-truth fingerprint (per-task lane count from the grader's
 *  own mustChange scope where the family is lane-shaped). */
export function taskFingerprint(task: HelixTask): MissionTaskFingerprint {
  const lanes = Math.max(1, (task.grader.mustChange ?? []).length)
  const base: MissionTaskFingerprint = {
    shape: 'bounded',
    separableLanes: 1,
    couplingBand: 1,
    ambiguityBand: 1,
    mechanical: false,
    investigation: false,
  }
  switch (task.family) {
    case 1:
    case 15:
      return { ...base, shape: 'research', investigation: true }
    case 2:
      return base
    case 3:
      return { ...base, shape: 'cross-cutting' }
    case 4:
      return { ...base, ambiguityBand: 2 }
    case 5:
      return { ...base, shape: 'diagnostic' }
    case 6:
      return { ...base, shape: 'diagnostic', ambiguityBand: 2 }
    case 7:
      return { ...base, shape: 'cross-cutting', separableLanes: Math.max(2, Math.min(3, lanes)), couplingBand: 1 }
    case 8:
      return base
    case 9:
    case 16:
      return { ...base, separableLanes: Math.min(3, lanes), couplingBand: 0 }
    case 10:
      return { ...base, separableLanes: 2, couplingBand: 2 }
    case 11:
      return { ...base, shape: 'mechanical', mechanical: true }
    case 12:
      return { ...base, ambiguityBand: 2, couplingBand: 2 }
    case 13:
      return base
    case 14:
      return { ...base, shape: 'diagnostic', ambiguityBand: 2 }
    default:
      return base
  }
}

export interface SelectedArmResolution {
  decision: MissionPolicyDecision
  /** The executable runner arm the profile maps onto. */
  executedAs: 'solo' | 'solo-reviewer' | 'specialist-sol' | 'workflow'
  /** Named when the profile's product execution differs from the runner arm. */
  mappingNote?: string
}

const PROFILE_TO_ARM: Record<string, SelectedArmResolution['executedAs']> = {
  'solo-default': 'solo',
  'solo-reviewer': 'solo-reviewer',
  'specialist-sol': 'specialist-sol',
  'workflow-deep': 'workflow',
  'routed-lite': 'workflow',
  'routed-wide': 'workflow',
}

export async function resolveSelectedArm(task: HelixTask): Promise<SelectedArmResolution> {
  const fingerprint = taskFingerprint(task)
  const epoch = missionPolicyEpoch({
    architectureEpoch: APEX_ARCHITECTURE_EPOCH,
    frontierDefaultModel: 'claude-opus-4-8',
  })
  let solEngineQualified = false
  try {
    solEngineQualified = readQualificationReceipts().some(
      r => r.current && r.receipt.modelId.startsWith('gpt-') && r.receipt.role === 'primary',
    )
  } catch {
    solEngineQualified = false
  }
  const stats = await readMissionOutcomeStats({ taskShape: fingerprint.shape, epoch, now: Date.now() })
  const history = stats.perProfile.map(p => ({
    profileId: p.profile as MissionPolicyDecision['profile']['id'],
    epoch,
    sampleCount: p.sampleCount,
    acceptedRate: p.acceptedRate,
  }))
  const rawPin = process.env.MERCURY_MISSION_POLICY
  const pin = typeof rawPin === 'string' && rawPin.trim() !== '' ? rawPin.trim() : null
  const decision = selectMissionPolicy({ fingerprint, epoch, pin, solEngineQualified, history })
  const executedAs = PROFILE_TO_ARM[decision.profile.id] ?? 'solo'
  const mappingNote = decision.profile.execution === 'routed'
    ? 'routed profile executed via the Workflow engine (the headless composition path)'
    : undefined
  return { decision, executedAs, ...(mappingNote ? { mappingNote } : {}) }
}
