// ============================================================================
//  services/concourse/projectActivity — THE ONE OWNER of "what is going on in
//  the OTHER projects" (cross-project awareness, laws 4 and 6 — the operator:
//  "there should be a small indicator saying '3 sessions running
//  in <that project>' … click on projects and switch to this project to put
//  them back in the live session viewer").
//
//  The daemon's roster, grouped by the catalog's project KEY (the session-
//  store dir — the same identity inProject compares, realpath-safe), counted
//  by the board's own state derivation: running (a live runner), needs-you
//  (an open ask or a crash), finished (a turn settled and unreviewed). The
//  CURRENT project never has a line (its sessions are the rows); the one
//  carried-over focused session is not counted where it came from (it is on
//  the board already — the line counts what you do NOT see). The board
//  paints one door line per project (bounded, name-ordered — content-keyed,
//  never re-sorted by a count) and the Boot face's Projects rows read the
//  same numbers through the same predicate. Cheap: one memoised key
//  resolution per record; no I/O beyond the records read the caller made.
// ============================================================================

import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { listConcourseWorkers } from '../../daemon/concourseSupervisor.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { inProject, projectDisplayName, type ProjectIdentity } from '../../utils/bootCardFacts.js'
import type { ConcourseElsewhereV1, ConcourseRowV1 } from '../../components/concourse/contracts.js'

/** The board paints this many project lines; the rest fold into one honest
 *  "+N more" door that opens the picker. */
export const ELSEWHERE_CAP = 3

/** THE ONE "RUNNING" PREDICATE (the board's line and the face's count read
 *  it): a live runner — working, a turn settled and unreviewed, or the
 *  operator's own terminal; a session that needs you counts while its
 *  runner is alive (it is running AND waiting), never when it crashed. */
export function isRunningState(state: ConcourseRowV1['state'], alive: boolean): boolean {
  return state === 'working' || state === 'ready-to-review' || state === 'attached' || (state === 'needs-you' && alive)
}

/** The PURE fold: every row of the roster → the other projects' activity,
 *  most active first (running + needs-you + finished, then name). Rows of
 *  the current project and the excluded (carried-over) session never count. */
export function projectActivity(
  rows: ReadonlyArray<Pick<ConcourseRowV1, 'sessionId' | 'state' | 'workspaceDir'>>,
  opts: { current: ProjectIdentity; excludeSessionId?: string | null; aliveOf?: (sessionId: string) => boolean },
): ConcourseElsewhereV1[] {
  const byKey = new Map<string, ConcourseElsewhereV1>()
  for (const row of rows) {
    if (row.workspaceDir === undefined || row.workspaceDir.length === 0) continue
    if (row.sessionId === opts.excludeSessionId) continue
    if (inProject(opts.current, row.workspaceDir)) continue
    let key: string
    try {
      key = getProjectDir(row.workspaceDir)
    } catch {
      continue
    }
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = { dir: row.workspaceDir, key, name: projectDisplayName(row.workspaceDir), running: 0, needsYou: 0, finished: 0 }
      byKey.set(key, entry)
    }
    if (isRunningState(row.state, opts.aliveOf?.(row.sessionId) ?? true)) entry.running += 1
    if (row.state === 'needs-you') entry.needsYou += 1
    if (row.state === 'ready-to-review') entry.finished += 1
  }
  return [...byKey.values()]
    .filter(p => p.running + p.needsYou + p.finished > 0)
    .sort((a, b) => activityOf(b) - activityOf(a) || a.name.localeCompare(b.name))
}

export function activityOf(p: ConcourseElsewhereV1): number {
  return p.running + p.needsYou + p.finished
}

/** The board's compact grammar for one project's line — the count that
 *  leads is the one the operator asked for ("N running"); the others
 *  follow only when non-zero. The door's verb ("switch to see them") is the
 *  NOW cell's, not this line's. */
export function elsewhereLine(p: ConcourseElsewhereV1): string {
  const needs = `${p.needsYou} need${p.needsYou === 1 ? 's' : ''} you`
  const lead = p.running > 0 ? `${p.running} running` : p.finished > 0 ? `${p.finished} finished` : needs
  const rest: string[] = []
  if (p.running > 0 && p.needsYou > 0) rest.push(needs)
  if (p.running > 0 && p.finished > 0) rest.push(`${p.finished} finished`)
  if (p.running === 0 && p.finished > 0 && p.needsYou > 0) rest.push(needs)
  return `${lead} in ${p.name}${rest.length > 0 ? ` · ${rest.join(' · ')}` : ''}`
}

/** The Boot face's read (law 6): the running count per project key, from
 *  the records file and positive liveness alone through the SAME predicate
 *  — bounded, fail-soft to an empty map. The face pairs each Projects row
 *  with its key through the same catalog resolver. Asks and finishes need
 *  the async obligations store and stay the board's; the face shows what
 *  runs. The state derivation is the builder's (imported at call time —
 *  the builder imports this owner statically). */
export async function runningByProjectKey(recordsDir?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const { concourseRecordState } = await import('./concourseSnapshot.js')
    for (const rec of listConcourseWorkers(null, recordsDir)) {
      const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
      const state = concourseRecordState(rec, { needsYou: rec.crash !== undefined, alive })
      if (!isRunningState(state, alive)) continue
      let key: string
      try {
        key = getProjectDir(rec.workspaceId)
      } catch {
        continue
      }
      out.set(key, (out.get(key) ?? 0) + 1)
    }
  } catch {
    /* a torn records file reads as nothing running */
  }
  return out
}
