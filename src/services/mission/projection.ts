import { createHash } from 'node:crypto'
import type { RunSnapshot } from '../run/runKernel.js'
import type { SnapshotRead } from '../projectIntel/contracts.js'
import type { MemoryRef } from '../../mneme/memoryRefs.js'
import {
  MISSION_EXECUTION_CAP,
  MISSION_MEMORY_CAP,
  MISSION_SCHEMA,
  missionEnabled,
  type MissionCardView,
  type MissionExecutionRef,
  type MissionView,
} from './contracts.js'

const TERMINAL_RUN = new Set(['completed', 'cancelled', 'failed'])

export interface MissionInputs {
  workspace: string
  runObjective: string | null
  runLifecycle: string | null
  snapshot: SnapshotRead | null
  memoryRefs: MemoryRef[]
  executions: MissionExecutionRef[]
  evidenceDigest: string | null

  model: string | null

  card?: MissionCardView | null
  now: number
}

export function composeMissionView(inputs: MissionInputs): MissionView | null {
  const hasRunGoal =
    inputs.runObjective !== null &&
    inputs.runObjective.trim() !== '' &&
    inputs.runLifecycle !== null &&
    inputs.runLifecycle !== 'idle'

  const armedCard = inputs.card && inputs.card.state === 'armed' ? inputs.card : null

  if (!hasRunGoal && armedCard === null) return null

  const goal: MissionView['goal'] = hasRunGoal
    ? { source: 'run-objective', text: inputs.runObjective }
    : { source: 'mission-card', text: armedCard!.goal }

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

  const policy: MissionView['policy'] = { model: inputs.model, source: 'session-model' }

  let outcome: MissionView['outcome'] = null
  if (inputs.runLifecycle !== null && TERMINAL_RUN.has(inputs.runLifecycle)) {
    outcome = {
      state: inputs.runLifecycle as 'completed' | 'cancelled' | 'failed',
      at: inputs.now,
    }
  }

  const missionId =
    'mv1-' +
    createHash('sha256')
      .update(inputs.workspace + '|' + (goal.text ?? ''))
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
    executions: inputs.executions.slice(0, MISSION_EXECUTION_CAP),
    evidence: { treeDigest: inputs.evidenceDigest, available: inputs.evidenceDigest !== null },
    outcome,
    generatedAtMs: inputs.now,
  }
}

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
  }

  let snapshot: SnapshotRead | null = null
  try {

    const { getProjectSnapshotAsync } = await import('../projectIntel/snapshot.js')
    snapshot = await getProjectSnapshotAsync(workspace, { maxStaleMs: 30_000 })
  } catch {
    snapshot = null
  }

  let memoryRefs: MemoryRef[] = []
  try {
    const { collectMemoryRefs } = await import('../../mneme/memoryRefs.js')
    const goalText = runObjective ?? ''
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
    const { computeWorkingTreeDigestAsync, verifyEvidenceEnabled } = await import(
      '../../utils/verification/verificationState.js'
    )
    evidenceDigest = verifyEvidenceEnabled() ? await computeWorkingTreeDigestAsync(workspace) : null
  } catch {
    evidenceDigest = null
  }

  let model: string | null = null
  try {
    const { getEngineModel } = await import('../../utils/model/model.js')
    model = String(getEngineModel())
  } catch {
    model = null
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

  return composeMissionView({
    workspace,
    runObjective,
    runLifecycle,
    snapshot,
    memoryRefs,
    executions,
    evidenceDigest,
    model,
    card,
    now: Date.now(),
  })
}

export interface MissionRow {
  section: string
  line: string
  detail: string[]
  tone: 'ok' | 'warn' | 'fail' | 'neutral' | 'accent'
}

export function buildMissionRow(view: MissionView | null): MissionRow | null {
  if (view === null) return null
  const line = (view.policy.model ?? 'the session model') + ' · goal[' + view.goal.source + ']'
  const detail: string[] = [
    'mission: ' + view.missionId + ' · goal[' + view.goal.source + ']: ' + (view.goal.text ?? '—'),
    'model: ' + (view.policy.model ?? '—') + ' (the session model)',
    'fingerprint: ' +
      (view.fingerprint.available
        ? (view.fingerprint.branch ?? '?') + '@' + (view.fingerprint.headSha?.slice(0, 8) ?? '?') + ' · ' + view.fingerprint.changedCount + ' changed · ' + (view.fingerprint.provenance ?? '')
        : 'unavailable'),
    'evidence: ' + (view.evidence.available ? 'digest ' + (view.evidence.treeDigest?.slice(0, 12) ?? '') : 'unavailable'),
  ]
  for (const ref of view.memory) detail.push('memory ' + ref.refId + ' [' + ref.status + '] — ' + ref.why)
  if (view.outcome) detail.push('outcome: ' + view.outcome.state)
  return {
    section: 'MISSION',
    line,
    detail,
    tone: view.outcome ? 'ok' : 'accent',
  }
}
