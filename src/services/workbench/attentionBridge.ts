
import {
  registerAttentionGatherer,
} from '../../services/attention/store.js'
import type {
  AttentionFact,
  AttentionReasonCode,
  AttentionBucket,
} from '../../services/attention/contracts.js'
import type { OverlapPath, RelationFact } from '../../services/attention/relations.js'
import type { WorkbenchThreadRow } from './contracts.js'
import { getWorkbenchSnapshot, subscribeWorkbench } from './projection.js'

const STATE_MAP: Record<string, { bucket: AttentionBucket; reason: AttentionReasonCode }> = {
  running: { bucket: 'working', reason: 'run-live' },
  working: { bucket: 'working', reason: 'run-live' },
  streaming: { bucket: 'working', reason: 'turn-active' },
  active: { bucket: 'working', reason: 'run-live' },
  live: { bucket: 'working', reason: 'run-live' },
  failed: { bucket: 'stalled', reason: 'run-failed' },
  killed: { bucket: 'stalled', reason: 'run-killed' },
  paused: { bucket: 'stalled', reason: 'run-paused' },
  wedged: { bucket: 'stalled', reason: 'run-wedged' },
  orphaned: { bucket: 'stalled', reason: 'run-orphaned' },
  blocked: { bucket: 'stalled', reason: 'dependency-blocked' },
  dead: { bucket: 'stalled', reason: 'teammate-dead' },
  completed: { bucket: 'completed', reason: 'run-completed' },
  done: { bucket: 'completed', reason: 'run-completed' },
  settled: { bucket: 'completed', reason: 'settled' },
  succeeded: { bucket: 'completed', reason: 'run-completed' },
  finished: { bucket: 'completed', reason: 'run-completed' },
  stopped: { bucket: 'completed', reason: 'settled' },
  cancelled: { bucket: 'completed', reason: 'settled' },
  interrupted: { bucket: 'completed', reason: 'settled' },
}

const STALLED_URGENCY = 1 as const

function threadFact(t: WorkbenchThreadRow): AttentionFact | null {
  const subjectId = `thread:${t.id}`
  const sinceMs = t.startedAt ?? t.updatedAt
  if (t.blocker) {
    return {
      subjectId,
      owner: 'run-manifest',
      sourceEventId: `wb:${t.id}:blocker:${t.blocker}`,
      bucket: 'needs-you',
      reasonCode: 'question-pending',
      reasonLabel: t.blocker,
      sinceMs,
      atMs: t.updatedAt,
      urgency: 0,
      title: t.title,
    }
  }
  const mapped = STATE_MAP[t.state.toLowerCase()]
  if (!mapped) return null
  return {
    subjectId,
    owner: 'run-manifest',
    sourceEventId: `wb:${t.id}:state:${t.state}`,
    bucket: mapped.bucket,
    reasonCode: mapped.reason,
    reasonLabel: `${t.kind} ${t.state}`,
    sinceMs,
    atMs: t.updatedAt,
    urgency: mapped.bucket === 'stalled' ? STALLED_URGENCY : 2,
    title: t.title,
  }
}

export function workbenchFactsOf(
  snap:
    | (Pick<
        import('./contracts.js').WorkbenchSnapshot,
        'threads' | 'reviewQueue' | 'refreshedAt'
      > & { lanes?: import('./contracts.js').WorkbenchLaneRow[] })
    | null,
): { attention: AttentionFact[]; relations: RelationFact[] } {
  if (!snap) return { attention: [], relations: [] }
  const attention: AttentionFact[] = []
  const relations: RelationFact[] = []

  for (const t of snap.threads) {
    const f = threadFact(t)
    if (f) attention.push(f)
    if (t.parentId) {
      relations.push({
        kind: 'spawned-by',
        from: `thread:${t.id}`,
        to: `thread:${t.parentId}`,
        owner: 'workbench',
        sourceEventId: `wb:${t.id}:parent:${t.parentId}`,
      })
    }
    if (t.worktreePath) {
      relations.push({
        kind: 'worktree',
        from: `thread:${t.id}`,
        to: t.worktreePath,
        owner: 'workbench',
        sourceEventId: `wb:${t.id}:worktree:${t.worktreePath}`,
      })
    }
  }

  const withPaths = snap.threads.filter(t => t.changedPaths.length > 0)
  for (let i = 0; i < withPaths.length; i++) {
    for (let j = i + 1; j < withPaths.length; j++) {
      const a = withPaths[i]!
      const b = withPaths[j]!
      const bSet = new Set(b.changedPaths)
      const shared = a.changedPaths.filter(p => bSet.has(p))
      if (shared.length === 0) continue
      const aTrunc = (a.totalChangedPaths ?? a.changedPaths.length) > a.changedPaths.length
      const bTrunc = (b.totalChangedPaths ?? b.changedPaths.length) > b.changedPaths.length
      const paths: OverlapPath[] = shared.map(p => ({
        path: p,
        from: aTrunc ? 'unknown' : 'changed',
        to: bTrunc ? 'unknown' : 'changed',
      }))
      relations.push({
        kind: 'overlap',
        from: `thread:${a.id}`,
        to: `thread:${b.id}`,
        owner: 'agent-results',
        sourceEventId: `wb:overlap:${a.id}:${b.id}:${shared.join(',')}`,
        paths,
      })
    }
  }

  for (const l of snap.lanes ?? []) {
    if (!l.worktreePath) continue
    relations.push({
      kind: 'worktree',
      from: `lane:${l.laneId}`,
      to: l.worktreePath,
      owner: 'workbench',
      sourceEventId: `wb:lane:${l.laneId}:worktree:${l.worktreePath}`,
    })
  }

  for (const r of snap.reviewQueue) {
    attention.push({
      subjectId: `review:${r.ref}`,
      owner: 'review-queue',
      sourceEventId: `wb:review:${r.ref}:${r.note}`,
      bucket: 'ready-to-review',
      reasonCode: 'review-queued',
      reasonLabel: r.note,
      sinceMs: snap.refreshedAt,
      atMs: snap.refreshedAt,
      urgency: 1,
      title: r.note,
    })
  }

  return { attention, relations }
}

let reported = new Map<string, { firstSeen: number; title?: string }>()

export function gatherWithLifecycle(
  snap: Parameters<typeof workbenchFactsOf>[0],
  nowMs: number,
): { attention: AttentionFact[]; relations: RelationFact[] } {
  const out = workbenchFactsOf(snap)
  const current = new Map<string, { firstSeen: number; title?: string }>()
  for (const f of out.attention) {
    const prev = reported.get(f.subjectId)
    const firstSeen = prev?.firstSeen ?? f.sinceMs
    current.set(f.subjectId, { firstSeen, ...(f.title !== undefined ? { title: f.title } : {}) })
    if (firstSeen < f.sinceMs) f.sinceMs = firstSeen
  }
  for (const [subjectId, info] of reported) {
    if (current.has(subjectId)) continue
    out.attention.push({
      subjectId,
      owner: subjectId.startsWith('review:') ? 'review-queue' : 'run-manifest',
      sourceEventId: `wb:retract:${subjectId}:${nowMs}`,
      bucket: 'completed',
      reasonCode: 'settled',
      reasonLabel: 'the owner no longer reports it',
      sinceMs: info.firstSeen,
      atMs: nowMs,
      urgency: 2,
      ...(info.title !== undefined ? { title: info.title } : {}),
    })
  }
  reported = current
  return out
}

export function _resetBridgeLifecycleForTesting(): void {
  reported = new Map()
}

function workbenchFacts(): { attention: AttentionFact[]; relations: RelationFact[] } {
  return gatherWithLifecycle(getWorkbenchSnapshot(), Date.now())
}

registerAttentionGatherer(workbenchFacts, { subscribe: subscribeWorkbench })
