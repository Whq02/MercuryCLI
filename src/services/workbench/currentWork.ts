
import { useEffect, useState } from 'react'
import type { RunSnapshot } from '../run/runKernel.js'
import { isTerminalLifecycle } from '../run/runKernel.js'
import { getRunSnapshot, subscribeRuns } from '../run/runCoordinator.js'
import { loadRunSidecar } from '../run/runSidecar.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  resolveWorkbenchSnapshot,
  subscribeWorkbench,
  getWorkbenchSnapshot,
} from './projection.js'
import { serialCoalescer } from './serialCoalescer.js'
import { classifyReadFailure, wasObserved } from '../../substrate/sourceState.js'
import type { WorkbenchSnapshot } from './contracts.js'

export const CURRENT_WORK_SCHEMA = 2 as const

export type WorkScale = 'none' | 'direct' | 'substantial'

export interface CurrentWorkPlanItem {
  id: string
  title: string
  state: 'open' | 'in-progress' | 'done' | 'dropped'
  blockedBy: string[]
}

export interface CurrentWorkReview {
  openArtifacts: number
  openComments: number
  awaitingReview: number
  latestRef: string | null
  anyStale: boolean
}

export type CurrentWorkRecovery =
  | { state: 'live' }
  | { state: 'none' }
  | { state: 'unreconciled'; runId: string }
  | { state: 'terminal-receipt'; runId: string }
  | { state: 'recoverable'; reason: string }
  | { state: 'unavailable'; reason: string; retryable: boolean }

export interface CurrentWork {
  schema: typeof CURRENT_WORK_SCHEMA
  identity: { owner: string; workspace: string; runId: string | null }
  outcome: string | null
  scale: WorkScale
  lifecycle: string | null
  phase: string | null
  planItems: CurrentWorkPlanItem[]
  activeItem: CurrentWorkPlanItem | null
  completedCount: number
  blockedItems: CurrentWorkPlanItem[]
  ledger: 'live' | 'unavailable'
  blocker: { description: string; ownedBy: string; resumeCondition: string } | null
  nextAction: string | null
  agents: { active: number; lanes: number } | null
  changedPaths: string[]
  totalChangedPaths: number
  review: CurrentWorkReview | null
  verification: { state: string; detail: string } | null
  executionShape: { profile: string; source: string; reasonCodes: string[] } | null
  effectiveModelAndEffort: { model: string; effortLabel: string | null }
  usage: { contextPct: number | null }
  artifactRefs: string[]
  recovery: CurrentWorkRecovery
  generatedAt: number
}


export interface CurrentWorkInputs {
  now: number
  owner: string
  workspace: string
  run: RunSnapshot | null
  tasks: Array<{ id: string; subject: string; status: string; blockedBy: string[] }> | null
  workbench: WorkbenchSnapshot | null
  model: string
  effortLabel: string | null
  contextPct: number | null
  executionShape: { profile: string; source: string; reasonCodes: string[] } | null
  recovery: CurrentWorkRecovery
}

const ACTIVE_THREAD_STATES = new Set(['running', 'ready', 'starting', 'waiting'])

export function deriveCurrentWork(inputs: CurrentWorkInputs): CurrentWork {
  const run = inputs.run
  const hasRun =
    run !== null && run.objective.trim() !== '' && run.lifecycle !== 'idle'

  const scale: WorkScale = !hasRun || !run.substantive
    ? 'none'
    : run.deliverables.length >= 2
      ? 'substantial'
      : 'direct'

  const openBlockedIds = new Set(
    (inputs.tasks ?? [])
      .filter(t => t.status !== 'completed')
      .flatMap(t =>
        t.blockedBy.length > 0 &&
        (inputs.tasks ?? []).some(b => t.blockedBy.includes(b.id) && b.status !== 'completed')
          ? [t.id]
          : [],
      ),
  )
  const blockedByOf = new Map(
    (inputs.tasks ?? []).map(t => [t.id, t.blockedBy] as const),
  )

  const planItems: CurrentWorkPlanItem[] = (run?.deliverables ?? []).map(d => ({
    id: d.id,
    title: d.title,
    state: d.state,
    blockedBy: blockedByOf.get(d.id) ?? [],
  }))
  const activeItem = planItems.find(i => i.state === 'in-progress') ?? null
  const blockedItems = planItems.filter(
    i => (i.state === 'open' || i.state === 'in-progress') && openBlockedIds.has(i.id),
  )

  const wb = inputs.workbench
  let review: CurrentWorkReview | null = null
  if (wb !== null && wasObserved(wb.sources.artifacts)) {
    const awaiting = wb.reviewQueue.length
    review = {
      openArtifacts: wb.artifactHeads.length,
      openComments: wb.reviewQueue.filter(r => r.ref.endsWith('/comments')).length,
      awaitingReview: awaiting,
      latestRef: wb.artifactHeads[0]?.ref ?? null,
      anyStale: wb.artifactHeads.some(a => a.stale === true),
    }
  }

  const runId =
    run?.runId ??
    (inputs.recovery.state === 'unreconciled' || inputs.recovery.state === 'terminal-receipt'
      ? inputs.recovery.runId
      : null)

  return {
    schema: CURRENT_WORK_SCHEMA,
    identity: { owner: inputs.owner, workspace: inputs.workspace, runId },
    outcome: hasRun ? run.objective : null,
    scale,
    lifecycle: run?.lifecycle ?? null,
    phase: hasRun ? run.phase : null,
    planItems,
    activeItem,
    completedCount: planItems.filter(i => i.state === 'done').length,
    blockedItems,
    ledger: inputs.tasks === null ? 'unavailable' : 'live',
    blocker: run?.blocker
      ? {
          description: run.blocker.description,
          ownedBy: run.blocker.ownedBy,
          resumeCondition: run.blocker.resumeCondition,
        }
      : null,
    nextAction: wb?.nextAction ?? (hasRun && run.nextAction ? run.nextAction : null),
    agents: wb
      ? {
          active: wb.threads.filter(t => ACTIVE_THREAD_STATES.has(t.state)).length,
          lanes: wb.lanes.length,
        }
      : null,
    changedPaths: run?.changedPaths ?? [],
    totalChangedPaths: run?.totalChangedPaths ?? 0,
    review,
    verification: run ? { state: run.verification.state, detail: run.verification.detail } : null,
    executionShape: scale === 'none' ? null : inputs.executionShape,
    effectiveModelAndEffort: { model: inputs.model, effortLabel: inputs.effortLabel },
    usage: { contextPct: inputs.contextPct },
    artifactRefs: wb?.artifactHeads.map(a => a.ref) ?? [],
    recovery: inputs.recovery,
    generatedAt: inputs.now,
  }
}


export async function classifyRecovery(
  owner: string,
  run: RunSnapshot | null,
): Promise<CurrentWorkRecovery> {
  if (run !== null) return { state: 'live' }
  try {
    const load = await loadRunSidecar(owner as Parameters<typeof loadRunSidecar>[0])
    if (load.state === 'none') return { state: 'none' }
    if (load.state === 'unavailable') {
      return { state: 'unavailable', reason: load.reason, retryable: load.retryable }
    }
    if (load.state === 'recoverable') return { state: 'recoverable', reason: load.reason }
    return isTerminalLifecycle(load.snapshot.lifecycle)
      ? { state: 'terminal-receipt', runId: load.snapshot.runId }
      : { state: 'unreconciled', runId: load.snapshot.runId }
  } catch (e) {
    const cls = classifyReadFailure(e)
    return cls.state === 'empty'
      ? { state: 'none' }
      : { state: 'unavailable', reason: cls.reason, retryable: cls.retryable }
  }
}

export async function gatherCurrentWork(opts?: {
  getAppState?: () => unknown
}): Promise<CurrentWork> {
  const owner = processMainOwner()
  const run = getRunSnapshot(owner)

  let tasks: CurrentWorkInputs['tasks'] = null
  try {
    const { getTaskListId, listTasks } = await import('../../utils/tasks.js')
    tasks = (await listTasks(getTaskListId())).map(t => ({
      id: t.id,
      subject: t.subject,
      status: String(t.status),
      blockedBy: t.blockedBy,
    }))
  } catch {
    tasks = null
  }

  let workbench: WorkbenchSnapshot | null = null
  try {
    workbench = await resolveWorkbenchSnapshot(
      opts?.getAppState ? { getAppState: opts.getAppState } : undefined,
    )
  } catch (e) {
    logForDebugging(`[currentWork] workbench resolve failed (degrading): ${e}`)
  }

  let model = 'unknown'
  let effortLabel: string | null = null
  try {
    const { getMainLoopModel } = await import('../../utils/model/model.js')
    model = String(getMainLoopModel())
    const { getDisplayedEffortLabel } = await import('../../utils/effort.js')
    const state = opts?.getAppState?.() as { effortValue?: unknown } | undefined
    effortLabel = getDisplayedEffortLabel(
      model,
      typeof state?.effortValue === 'string' ? (state.effortValue as never) : undefined,
    )
  } catch {
    effortLabel = null
  }

  let contextPct: number | null = null
  try {
    const { getLiveContextUsage } = await import('../../utils/cockpit/contextUsageLive.js')
    const ctx = getLiveContextUsage()
    contextPct = ctx.usedPct != null ? Math.round(ctx.usedPct) : null
  } catch {
    contextPct = null
  }

  let executionShape: CurrentWorkInputs['executionShape'] = null
  try {
    if (run && run.substantive && run.deliverables.length >= 2 && run.objective.trim() !== '') {
      const { gatherPolicyDecision } = await import('../mission/projection.js')
      const decision = await gatherPolicyDecision(run.objective, run.totalChangedPaths)
      if (decision) {
        executionShape = {
          profile: decision.profile.id,
          source: decision.source,
          reasonCodes: decision.reasonCodes.slice(0, 8),
        }
      }
    }
  } catch {
    executionShape = null
  }

  return deriveCurrentWork({
    now: Date.now(),
    owner,
    workspace: getCwd(),
    run,
    tasks,
    workbench,
    model,
    effortLabel,
    contextPct,
    executionShape,
    recovery: await classifyRecovery(owner, run),
  })
}


export function useCurrentWork(): CurrentWork | null {
  const [work, setWork] = useState<CurrentWork | null>(null)
  useEffect(() => {
    let alive = true
    const coalescer = serialCoalescer(async () => {
      const w = await gatherCurrentWork()
      if (alive) setWork(w)
    }, 'current-work')
    const refresh = () => coalescer.poke()
    const unsubs: Array<() => void> = [subscribeRuns(refresh), subscribeWorkbench(refresh)]
    void import('../../utils/tasks.js')
      .then(m => {
        if (alive) unsubs.push(m.onTasksUpdated(refresh))
      })
      .catch(() => {})
    refresh()
    return () => {
      alive = false
      coalescer.release()
      for (const u of unsubs) u()
    }
  }, [])
  void getWorkbenchSnapshot
  return work
}
