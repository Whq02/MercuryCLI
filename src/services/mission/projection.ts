// ============================================================================
//  services/mission/projection — compose (pure) + gather (live) + fold.
//
//  composeMissionView is the PURE core: inputs in, MissionView | null out —
//  the proof suite drives it directly. gatherMissionView is the live
//  gatherer: it reads each owner best-effort (a failing owner contributes
//  its absence, never an exception) and never blocks the render path — UI
//  callers await it inside effects.
// ============================================================================

import { createHash } from 'node:crypto'
import type { RunSnapshot } from '../run/runKernel.js'
import type { TaskRoutePlan } from '../../utils/router/contracts.js'
import type { SnapshotRead } from '../projectIntel/contracts.js'
import type { MemoryRef } from '../../memdir/memoryRefs.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  MISSION_DECISION_POINT_CAP,
  MISSION_EXECUTION_CAP,
  MISSION_MEMORY_CAP,
  MISSION_PLAN_CAP,
  MISSION_SCHEMA,
  missionEnabled,
  type MissionCardView,
  type MissionExecutionRef,
  type MissionView,
} from './contracts.js'
import type { MissionPolicyDecision, MissionTaskFingerprint } from './policyProfiles.js'
import { evaluateMissionCompletion } from './completion.js'

const ACTIVE_PLAN_STATES = new Set(['committed', 'running', 'synthesizing', 'revising'])
const TERMINAL_RUN = new Set(['completed', 'cancelled', 'failed'])

export interface MissionInputs {
  workspace: string
  runObjective: string | null
  runLifecycle: string | null
  plans: TaskRoutePlan[]
  snapshot: SnapshotRead | null
  memoryRefs: MemoryRef[]
  executions: MissionExecutionRef[]
  evidenceDigest: string | null
  posture: string | null
  nodeAttemptCeiling: number
  /** The H3 measured selector's decision (solo missions; plans keep the router's). */
  selector?: MissionPolicyDecision | null
  /** The session's persisted /mission card (missionCard.ts owns it). */
  card?: MissionCardView | null
  now: number
}

/** The PURE composition — deterministic for identical inputs. */
export function composeMissionView(inputs: MissionInputs): MissionView | null {
  const activePlans = inputs.plans.filter(p => ACTIVE_PLAN_STATES.has(p.state))
  const relevantPlans = (activePlans.length > 0 ? activePlans : inputs.plans.slice(-1)).slice(
    0,
    MISSION_PLAN_CAP,
  )
  const hasRunGoal =
    inputs.runObjective !== null &&
    inputs.runObjective.trim() !== '' &&
    inputs.runLifecycle !== null &&
    inputs.runLifecycle !== 'idle'
  // An ARMED /mission card is a mission-shaped fact of its own; settled
  // cards (met/stood-down/cleared) are history and arm nothing here.
  const armedCard = inputs.card && inputs.card.state === 'armed' ? inputs.card : null
  // Idle law: no mission-shaped fact ⇒ no view.
  if (!hasRunGoal && activePlans.length === 0 && armedCard === null) return null

  const goal: MissionView['goal'] = hasRunGoal
    ? { source: 'run-objective', text: inputs.runObjective }
    : activePlans.length > 0 || armedCard === null
      ? { source: 'route-plan', text: relevantPlans[0]?.objective ?? null }
      : { source: 'mission-card', text: armedCard.goal }

  const generation = inputs.snapshot?.snapshot.generation ?? null
  const fingerprint: MissionView['fingerprint'] = {
    available: generation !== null,
    workspace: inputs.workspace,
    treeDigest: generation?.treeDigest ?? null,
    headSha: generation?.headSha ?? null,
    branch: generation?.branch ?? null,
    changedCount: inputs.snapshot?.snapshot.git.changed.length ?? 0,
    provenance: inputs.snapshot?.from ?? null,
  }

  const decisionPlan = activePlans[0] ?? null
  const selector = inputs.selector ?? null
  const policy: MissionView['policy'] = decisionPlan
    ? {
        profile: decisionPlan.profile,
        source:
          decisionPlan.decision.source === 'operator-pin' ? 'operator-pin' : 'route-decision',
        reasonCodes: decisionPlan.decision.decisiveReasons.slice(0, 8),
        posture: inputs.posture,
      }
    : selector
      ? {
          profile: selector.profile.id,
          source: selector.source === 'operator-pin' ? 'operator-pin' : 'measured-selector',
          reasonCodes: selector.reasonCodes.slice(0, 8),
          posture: inputs.posture,
        }
      : {
          profile: 'solo-default',
          source: 'current-default',
          reasonCodes: ['no-route-plan'],
          posture: inputs.posture,
        }

  const plans: MissionView['plans'] = relevantPlans.map(plan => ({
    planId: plan.id,
    revision: plan.revision,
    mode: plan.mode,
    state: plan.state,
    profile: plan.profile,
    reasonCodes: plan.decision.decisiveReasons.slice(0, 8),
    synthesisOwner: plan.synthesis.required ? plan.synthesis.owner : null,
    nodes: plan.nodes.map(node => ({
      planId: plan.id,
      nodeId: node.id,
      title: node.title,
      state: node.state,
      attempt: node.attempt,
      dependsOn: node.dependsOn,
      ownsPaths: node.ownsPaths,
      model: node.assignedModel?.model ?? null,
      worker: node.assignedWorker ?? null,
    })),
  }))

  const decisionPoints: string[] = []
  for (const plan of relevantPlans) {
    if (plan.state === 'revising') decisionPoints.push('plan ' + plan.id + ' is revising')
    for (const node of plan.nodes) {
      if (node.state === 'held') {
        decisionPoints.push('node ' + node.id + ' held (reconfigure release pending)')
      }
      // Acceptance PREVIEW for reported nodes — the ordered completion
      // evaluator over the node's OBSERVED completion packet (a reported
      // completion is the implementer's claim; the planner still settles).
      if (node.state === 'reported' && node.completion) {
        const preview = evaluateMissionCompletion({
          grader: node.completion.checksReported.length > 0 ? 'pass' : 'absent',
          undeclaredEffectDivergence: node.completion.unresolved.length,
          semanticRequired: plan.synthesis.required,
          reviewer: null,
          implementerClaimedSuccess: true,
        })
        decisionPoints.push(
          'node ' + node.id + ' reported → acceptance preview: ' + preview.state +
            (node.completion.unresolved.length > 0
              ? ' (' + node.completion.unresolved.length + ' unresolved)'
              : ''),
        )
      }
    }
  }

  const synthesisGaps: string[] = []
  for (const plan of plans) {
    for (const node of plan.nodes) {
      if (node.state === 'failed' || node.state === 'cancelled' || node.state === 'superseded') {
        synthesisGaps.push('node ' + node.nodeId + ' [' + node.state + '] — ' + node.title)
      }
    }
  }

  let outcome: MissionView['outcome'] = null
  const allPlansTerminal =
    inputs.plans.length > 0 && inputs.plans.every(p => !ACTIVE_PLAN_STATES.has(p.state))
  if (inputs.runLifecycle !== null && TERMINAL_RUN.has(inputs.runLifecycle) && (inputs.plans.length === 0 || allPlansTerminal)) {
    outcome = {
      state: inputs.runLifecycle as 'completed' | 'cancelled' | 'failed',
      at: inputs.now,
    }
  }

  const missionId =
    'mv1-' +
    createHash('sha256')
      .update(
        inputs.workspace + '|' + (goal.text ?? '') + '|' + relevantPlans.map(p => p.id).join(','),
      )
      .digest('hex')
      .slice(0, 16)

  return {
    schema: MISSION_SCHEMA,
    missionId,
    workspace: inputs.workspace,
    goal,
    fingerprint,
    card: inputs.card ?? null,
    memory: inputs.memoryRefs.slice(0, MISSION_MEMORY_CAP).map(ref => ({
      refId: ref.refId,
      status: ref.status,
      why: ref.why,
    })),
    policy,
    plans,
    executions: inputs.executions.slice(0, MISSION_EXECUTION_CAP),
    evidence: { treeDigest: inputs.evidenceDigest, available: inputs.evidenceDigest !== null },
    replan: {
      nodeAttemptCeiling: inputs.nodeAttemptCeiling,
      planRevisions: relevantPlans.reduce((sum, plan) => sum + Math.max(0, plan.revision - 1), 0),
    },
    decisionPoints: decisionPoints.slice(0, MISSION_DECISION_POINT_CAP),
    synthesisGaps: synthesisGaps.slice(0, 6),
    outcome,
    generatedAtMs: inputs.now,
  }
}

/** Structural-first fingerprint derivation (RGAO law: structure over prose;
 *  the goal text contributes only shape hints). Best-effort — the measured
 *  precision lives in the runner's family-derived fingerprints. */
export function deriveMissionFingerprint(
  goalText: string,
  changedCount: number,
  separableLanes: number | null,
): MissionTaskFingerprint {
  const investigation = /\b(read.only|do not (change|fix|modify)|report only|investigat)/i.test(goalText)
  const mechanical = /\b(per the spec|SPEC\.md|exactly per|mechanical|fill in|implement all (eight|twelve|\d+))\b/i.test(goalText)
  const shape = investigation
    ? 'research'
    : mechanical
      ? 'mechanical'
      : /\b(refactor|migrate|across (all|every|the))\b/i.test(goalText)
        ? 'cross-cutting'
        : /\b(diagnos|debug|failing test|diverg|race)\b/i.test(goalText)
          ? 'diagnostic'
          : 'bounded'
  const couplingBand: 0 | 1 | 2 | 3 = /\b(shared (owner|registry|schema|file)|same (file|registry|owner)|coupl)/i.test(goalText)
    ? 2
    : 1
  const ambiguityBand: 0 | 1 | 2 | 3 = /\b(carefully|ambigu|subtle|hysteres|contract carefully)\b/i.test(goalText) ? 2 : 1
  return {
    shape,
    separableLanes: separableLanes ?? (changedCount >= 6 && shape === 'cross-cutting' ? 2 : 1),
    couplingBand,
    ambiguityBand,
    mechanical,
    investigation,
  }
}

/** The live H3 policy decision for a solo-shaped mission (no route plan). */
export async function gatherPolicyDecision(
  goalText: string,
  changedCount: number,
): Promise<MissionPolicyDecision | null> {
  try {
    const { missionPolicyEpoch, selectMissionPolicy } = await import('./policyProfiles.js')

    let architectureEpoch = 'apex-1'
    try {
      const { APEX_ARCHITECTURE_EPOCH } = await import('../providers/openai/openaiCatalogue.js')
      architectureEpoch = APEX_ARCHITECTURE_EPOCH
    } catch {
      /* keep the literal */
    }
    let frontierDefaultModel = 'opus-fallback'
    try {
      const { frontierOperatorDecision } = await import('../../utils/model/frontierPolicy.js')
      const decision = frontierOperatorDecision()
      frontierDefaultModel = decision.winner?.id ?? decision.setting
    } catch {
      /* keep the fallback label */
    }
    const epoch = missionPolicyEpoch({ architectureEpoch, frontierDefaultModel })

    let solEngineQualified = false
    try {
      const { readQualificationReceipts } = await import('../providers/openai/qualificationStore.js')
      solEngineQualified = readQualificationReceipts().some(
        r => r.current && r.receipt.modelId.startsWith('gpt-') && r.receipt.role === 'primary',
      )
    } catch {
      solEngineQualified = false
    }

    const fingerprint = deriveMissionFingerprint(goalText, changedCount, null)

    let history: Parameters<typeof selectMissionPolicy>[0]['history'] = []
    try {
      const { readMissionOutcomeStats } = await import('../../substrate/routerOutcomeStore.js')
      const stats = await readMissionOutcomeStats({ taskShape: fingerprint.shape, epoch, now: Date.now() })
      history = stats.perProfile.map(p => ({
        profileId: p.profile as (typeof history)[number]['profileId'],
        epoch,
        sampleCount: p.sampleCount,
        acceptedRate: p.acceptedRate,
      }))
    } catch {
      history = []
    }

    const rawPin = flagEnv('MERCURY_MISSION_POLICY')
    const pin = typeof rawPin === 'string' && rawPin.trim() !== '' ? rawPin.trim() : null

    return selectMissionPolicy({ fingerprint, epoch, pin, solEngineQualified, history })
  } catch {
    return null
  }
}

/** Live gatherer — each owner read is best-effort and individually fenced. */
export async function gatherMissionView(): Promise<MissionView | null> {
  if (!missionEnabled()) return null
  const { getCwd } = await import('../../utils/cwd.js')
  const workspace = getCwd()

  let runObjective: string | null = null
  let runLifecycle: string | null = null
  try {
    const { getRunSnapshot } = await import('../run/runCoordinator.js')
    const { processMainOwner } = await import('../run/resolveOwner.js')
    const snap: RunSnapshot | null = getRunSnapshot(processMainOwner())
    runObjective = snap?.objective ?? null
    runLifecycle = snap?.lifecycle ?? null
  } catch {
    /* run kernel absent (e.g. proofs) — contribute absence */
  }

  let plans: TaskRoutePlan[] = []
  try {
    const { routerRunStore } = await import('../../substrate/routerRunStore.js')
    plans = (await routerRunStore().read()).plans
  } catch {
    plans = []
  }

  let snapshot: SnapshotRead | null = null
  try {
    const { getProjectSnapshot } = await import('../projectIntel/snapshot.js')
    snapshot = getProjectSnapshot(workspace, { maxStaleMs: 30_000 })
  } catch {
    snapshot = null
  }

  let memoryRefs: MemoryRef[] = []
  try {
    const { collectMemoryRefs } = await import('../../memdir/memoryRefs.js')
    const goalText = runObjective ?? plans[0]?.objective ?? ''
    memoryRefs = goalText === '' ? [] : collectMemoryRefs(goalText, { maxRefs: MISSION_MEMORY_CAP })
  } catch {
    memoryRefs = []
  }

  let executions: MissionExecutionRef[] = []
  try {
    const { listExecutions } = await import('../primitives/executionPlane.js')
    const { processMainOwner } = await import('../run/resolveOwner.js')
    executions = listExecutions(processMainOwner(), { liveOnly: true, limit: MISSION_EXECUTION_CAP }).map(
      record => ({ kind: record.spec.kind, id: record.spec.id, state: record.state }),
    )
  } catch {
    executions = []
  }

  let evidenceDigest: string | null = null
  try {
    const { computeWorkingTreeDigest, verifyEvidenceEnabled } = await import(
      '../../utils/verification/verificationState.js'
    )
    evidenceDigest = verifyEvidenceEnabled() ? computeWorkingTreeDigest(workspace) : null
  } catch {
    evidenceDigest = null
  }

  let posture: string | null = null
  try {
    const { readRouterPostureFile } = await import('../../utils/router/postures.js')
    posture = readRouterPostureFile().posture
  } catch {
    posture = null
  }

  let card: MissionCardView | null = null
  try {
    const { readMissionCard } = await import('./missionCard.js')
    const { getSessionId } = await import('../../bootstrap/state.js')
    const record = readMissionCard(getSessionId())
    card = record
      ? {
          sessionId: record.sessionId,
          goal: record.goal,
          state: record.state,
          nextStep: record.nextStep,
          iterations: record.iterations,
          updatedAt: record.updatedAt,
        }
      : null
  } catch {
    card = null
  }

  let nodeAttemptCeiling = 3
  try {
    const { NODE_MAX_ATTEMPTS } = await import('../../utils/router/scheduler.js')
    nodeAttemptCeiling = NODE_MAX_ATTEMPTS
  } catch {
    /* keep the conservative literal */
  }

  // The measured selector speaks only for solo-shaped missions — an active
  // route plan keeps the router's own decision as the policy fact.
  let selector: MissionPolicyDecision | null = null
  const hasActivePlan = plans.some(p =>
    p.state === 'committed' || p.state === 'running' || p.state === 'synthesizing' || p.state === 'revising',
  )
  if (!hasActivePlan && runObjective !== null && runObjective.trim() !== '') {
    selector = await gatherPolicyDecision(runObjective, snapshot?.snapshot.git.changed.length ?? 0)
  }

  return composeMissionView({
    workspace,
    runObjective,
    runLifecycle,
    plans,
    snapshot,
    memoryRefs,
    executions,
    evidenceDigest,
    posture,
    nodeAttemptCeiling,
    selector,
    card,
    now: Date.now(),
  })
}

/** The /run drill-in fold — structurally a RunRow (the commands layer owns
 *  that type; services stay import-free of it). */
export interface MissionRow {
  section: string
  line: string
  detail: string[]
  tone: 'ok' | 'warn' | 'fail' | 'neutral' | 'accent'
}

export function buildMissionRow(view: MissionView | null): MissionRow | null {
  if (view === null) return null
  const planBit =
    view.plans.length === 0
      ? 'no route plan'
      : view.plans.length + ' plan(s) · ' + view.plans.map(p => p.state).join('/')
  const line =
    view.policy.profile +
    ' (' + view.policy.source + ') · ' +
    planBit +
    (view.decisionPoints.length > 0 ? ' · ' + view.decisionPoints.length + ' decision point(s)' : '')
  const detail: string[] = [
    'mission: ' + view.missionId + ' · goal[' + view.goal.source + ']: ' + (view.goal.text ?? '—'),
    'policy: ' + view.policy.profile + ' via ' + view.policy.source + ' [' + view.policy.reasonCodes.join(',') + ']' + (view.policy.posture ? ' · posture ' + view.policy.posture : ''),
    'fingerprint: ' +
      (view.fingerprint.available
        ? (view.fingerprint.branch ?? '?') + '@' + (view.fingerprint.headSha?.slice(0, 8) ?? '?') + ' · ' + view.fingerprint.changedCount + ' changed · ' + (view.fingerprint.provenance ?? '')
        : 'unavailable'),
    'evidence: ' + (view.evidence.available ? 'digest ' + (view.evidence.treeDigest?.slice(0, 12) ?? '') : 'unavailable'),
    'replan: ceiling ' + view.replan.nodeAttemptCeiling + ' attempts/node · ' + view.replan.planRevisions + ' plan revision(s)',
  ]
  for (const plan of view.plans) {
    detail.push(
      'plan ' + plan.planId + ' r' + plan.revision + ' [' + plan.state + '] ' + plan.profile +
        (plan.synthesisOwner ? ' · synthesis: ' + plan.synthesisOwner : ''),
    )
    for (const node of plan.nodes.slice(0, 8)) {
      detail.push(
        '  node ' + node.nodeId + ' [' + node.state + ' a' + node.attempt + '] ' + node.title +
          (node.worker ? ' → ' + node.worker : '') +
          (node.model ? ' (' + node.model + ')' : ''),
      )
    }
  }
  for (const ref of view.memory) detail.push('memory ' + ref.refId + ' [' + ref.status + '] — ' + ref.why)
  for (const point of view.decisionPoints) detail.push('decision: ' + point)
  for (const gap of view.synthesisGaps) detail.push('gap: ' + gap)
  if (view.outcome) detail.push('outcome: ' + view.outcome.state)
  return {
    section: 'MISSION',
    line,
    detail,
    tone: view.decisionPoints.length > 0 ? 'warn' : view.outcome ? 'ok' : 'accent',
  }
}
