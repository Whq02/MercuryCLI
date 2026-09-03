// ============================================================================
//  engine-connector/workCounts — the ONE counting law for a session's work.
//
//  Every surface that numbers a session's running work — the concourse
//  row's work chip, the /tasks board, the agents view — derives from THIS
//  function over the SAME roster rows (the session's runner's own store,
//  published through the facts projection). One source, so the counts
//  agree everywhere they paint; the work-counts prover diffs the surfaces
//  against it from one fixture.
// ============================================================================
import type { ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import type { WorkRowV1 } from './types.js'

/** A row counts while it RUNS. 'pending' is queued-to-run motion the
 *  operator cares about; 'paused' spins nothing and never counts. */
export function workRowRuns(row: WorkRowV1): boolean {
  return row.status === 'running' || row.status === 'pending'
}

export interface WorkCountsV1 {
  /** Running workflow runs. */
  workflows: number
  /** Running dispatched agents — the session's subagents, nested included
   *  (a nested spawn registers in the same runner store and rides the
   *  same roster). */
  agents: number
  /** Running named agents (the session's named sub-agents). */
  teammates: number
  /** Running shells + monitors. */
  shells: number
  /** Permission asks parked across the running work. */
  asks: number
}

export function workCounts(rows: readonly WorkRowV1[]): WorkCountsV1 {
  const counts: WorkCountsV1 = { workflows: 0, agents: 0, teammates: 0, shells: 0, asks: 0 }
  for (const row of rows) {
    if (!workRowRuns(row)) continue
    switch (row.kind) {
      case 'workflow':
        counts.workflows += 1
        break
      case 'agent':
        counts.agents += 1
        break
      case 'teammate':
        counts.teammates += 1
        break
      case 'shell':
      case 'monitor':
        counts.shells += 1
        break
      default:
        break
    }
    counts.asks += row.pendingAsks ?? 0
  }
  return counts
}

/** The chip's words — the board vocabulary ("⚙ 1 workflow · 2 agents"),
 *  counts only, no color (the chip's surface owns the amber token). An
 *  idle session answers null: no chip, no noise. */
export function workChipLine(counts: WorkCountsV1): string | null {
  const parts: string[] = []
  if (counts.workflows > 0) parts.push(`${counts.workflows} workflow${counts.workflows === 1 ? '' : 's'}`)
  if (counts.agents > 0) parts.push(`${counts.agents} agent${counts.agents === 1 ? '' : 's'}`)
  if (counts.teammates > 0) parts.push(`${counts.teammates} named agent${counts.teammates === 1 ? '' : 's'}`)
  if (counts.shells > 0) parts.push(`${counts.shells} shell${counts.shells === 1 ? '' : 's'}`)
  if (parts.length === 0) return null
  const line = parts.join(' · ')
  return counts.asks > 0 ? `${line} · ${counts.asks} ask${counts.asks === 1 ? '' : 's'}` : line
}

/** The RUNNER-liveness law the work views share: a worker record whose
 *  runner is live — its pid answers (`alive`, the caller's pid probe), or
 *  the session is attached (the child dies by design at the attach
 *  boundary; the operator's terminal hosts it). An ended record is never
 *  live, and an un-ended one is not live by itself: the crash law keeps a
 *  dead runner's record on the board, crash fact standing, until the
 *  operator's own act — a row kept for the operator's eyes is not a live
 *  engine. Pure over the injected probe, so the counts prover pins it. */
export function runnerRecordAlive(
  rec: Pick<ConcourseWorkerRecordV1, 'endedAt' | 'attachedAt' | 'pid'>,
  alive: (pid: number) => boolean,
): boolean {
  if (rec.endedAt !== undefined) return false
  if (rec.attachedAt !== undefined) return true
  return rec.pid !== undefined && alive(rec.pid)
}
