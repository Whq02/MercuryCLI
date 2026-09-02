// ============================================================================
//  projectIntel/split — advisory two-operator work-split suggestion.
//
//  Given N task descriptions, derive per-task file sets from the SAME
//  deterministic evidence the capsule uses (exact names → import adjacency →
//  tests via the impact scan), then flag every CONTESTED path (needed by
//  more than one task) with a sequencing note. ADVISORY by construction:
//  the output is path lists in the landed zone owner's vocabulary — zones
//  are provisioned/accepted only through the existing parcel/zone
//  verbs; nothing here mints a second delegation model.
// ============================================================================

import { assembleContextCapsule } from './capsule.js'
import { projectImpact } from './impact.js'
import { projectIntelEnabled, type SnapshotGeneration } from './contracts.js'
import { getProjectSnapshot } from './snapshot.js'

export interface WorkSplitSuggestion {
  advisory: true
  generation: SnapshotGeneration
  perTask: Array<{
    task: string
    /** Files this stream owns (exact + adjacency evidence). */
    files: string[]
    /** Tests established for those files (impact scan). */
    tests: string[]
  }>
  /** Paths more than one stream needs — must be sequenced or transferred. */
  contested: Array<{ path: string; tasks: number[]; note: string }>
  caps: { omissions: string[] }
}

export function suggestWorkSplit(workspace: string, tasks: string[]): WorkSplitSuggestion | null {
  if (!projectIntelEnabled()) return null
  const read = getProjectSnapshot(workspace)
  if (!read || tasks.length === 0) return null

  const omissions: string[] = []
  const perTask = tasks.map(task => {
    const capsule = assembleContextCapsule({
      workspace,
      task,
      budget: { maxItems: 16 },
    })
    // Task-anchored evidence only (tiers 1-3): exact names + adjacency.
    // Changed-path/instruction tiers are shared session state, not ownership.
    const files = new Set<string>(
      (capsule?.items ?? []).filter(i => i.tier <= 3).map(i => i.path),
    )
    const tests = new Set<string>()
    for (const f of [...files].slice(0, 6)) {
      const impact = projectImpact(workspace, f)
      for (const t of impact?.established.tests ?? []) tests.add(t)
    }
    if (capsule && capsule.caps.omitted.count > 0) {
      omissions.push(`task '${task.slice(0, 40)}…': ${capsule.caps.omitted.count} capsule candidate(s) omitted`)
    }
    return { task, files: [...files].sort(), tests: [...tests].sort() }
  })

  const claim = new Map<string, number[]>()
  perTask.forEach((entry, index) => {
    for (const p of [...entry.files, ...entry.tests]) {
      const owners = claim.get(p) ?? []
      owners.push(index)
      claim.set(p, owners)
    }
  })
  const contested = [...claim.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([path, owners]) => ({
      path,
      tasks: owners,
      note: `needed by ${owners.length} streams — sequence it (one edits, others wait) or transfer through the zone owner`,
    }))
    .sort((x, y) => x.path.localeCompare(y.path))

  return {
    advisory: true,
    generation: read.snapshot.generation,
    perTask,
    contested,
    caps: { omissions },
  }
}
