// ============================================================================
//  runContinuationCapsule — the deterministic continuation block a compaction
//  installs beside the model summary.
//
//  Deterministic facts come from the RUN/task/effect/evidence stores — never
//  from the summarizing model's memory: current objective, still-open
//  deliverables, completed receipts (concise), changed files, recent failed
//  attempts (what they ruled out), the verification state and gap, IDE
//  feedback freshness, the precise next action/blocker, and a bounded recall
//  list of files that mattered (path-only references — re-readable, never
//  pasted contents). Bounded by construction; returns null when the owner
//  has no substantive run (a lightweight conversation compacts as before).
// ============================================================================

import { openDeliverables } from './runKernel.js'
import { getRunSnapshot } from './runCoordinator.js'
import type { OwnerKey } from './ownerKey.js'

const MAX_LIST = 12

function ago(at: number | null | undefined): string {
  if (!at) return 'unknown age'
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/**
 * Build the capsule text for an owner, or null when no substantive run
 * exists. `recallPaths` is the bounded pre-compaction read-file set (paths
 * only — the capsule tells the model these are RE-READABLE, not lost).
 */
export function buildRunContinuationCapsule(
  owner: OwnerKey,
  recallPaths: readonly string[] = [],
): string | null {
  const snap = getRunSnapshot(owner)
  if (!snap || !snap.substantive) return null

  const lines: string[] = []
  lines.push('## Active run (deterministic — from the run kernel, not summarized)')
  lines.push(`Objective: ${snap.objective}`)
  lines.push(`Lifecycle: ${snap.lifecycle} · phase ${snap.phase} (${snap.phaseReason})`)

  const open = openDeliverables(snap)
  const done = snap.deliverables.filter(d => d.state === 'done')
  if (open.length > 0) {
    lines.push(`Open deliverables (${open.length}):`)
    for (const d of open.slice(0, MAX_LIST)) lines.push(`- [${d.state}] ${d.title || d.id}`)
    if (open.length > MAX_LIST) lines.push(`- …and ${open.length - MAX_LIST} more`)
  }
  if (done.length > 0) {
    lines.push(
      `Completed (receipts only — do NOT redo): ${done
        .slice(0, MAX_LIST)
        .map(d => d.title || d.id)
        .join('; ')}${done.length > MAX_LIST ? ` …+${done.length - MAX_LIST}` : ''}`,
    )
  }

  if (snap.changedPaths.length > 0) {
    lines.push(
      `Changed files (${snap.totalChangedPaths} total): ${snap.changedPaths
        .slice(-MAX_LIST)
        .join(', ')}`,
    )
  }

  const failures = snap.recentEffects.filter(
    e => e.outcome === 'failed' || e.outcome === 'indeterminate',
  )
  if (failures.length > 0) {
    lines.push('Failed/indeterminate attempts (ruled out — do not repeat blindly):')
    for (const f of failures.slice(-5)) {
      lines.push(`- ${f.operation || f.toolName}: ${f.outcome} (${ago(f.at)})`)
    }
  }
  if (snap.pendingTools.length > 0) {
    lines.push(
      `Interrupted mid-flight (inspect real state before retrying): ${snap.pendingTools
        .map(p => p.toolName)
        .join(', ')}`,
    )
  }

  lines.push(`Verification: ${snap.verification.state} — ${snap.verification.detail}`)
  lines.push(
    `IDE feedback: ${snap.ideFeedback.state}${snap.ideFeedback.at ? ` (${ago(snap.ideFeedback.at)})` : ''}`,
  )
  if (snap.blocker) {
    lines.push(
      `BLOCKER (${snap.blocker.ownedBy}): ${snap.blocker.description} — resumes when: ${snap.blocker.resumeCondition}`,
    )
  }
  if (snap.nextAction) {
    lines.push(`Next concrete action: ${snap.nextAction}`)
  }
  if (recallPaths.length > 0) {
    lines.push(
      `Files that mattered (re-READ on demand — contents not carried): ${recallPaths
        .slice(0, MAX_LIST)
        .join(', ')}${recallPaths.length > MAX_LIST ? ` …+${recallPaths.length - MAX_LIST}` : ''}`,
    )
  }
  // Compaction retains the active working-set capsule digest +
  // primary refs (the post-compaction attachment re-derives and VALIDATES
  // against the live tree; this line preserves what the set was). Lazy —
  // absent when the projectIntel slice is off or nothing attached.
  try {
    const { capsuleContinuationLine } =
      require('../../utils/attachments/contextCapsule.js') as typeof import('../../utils/attachments/contextCapsule.js')
    const capsuleLine = capsuleContinuationLine(String(owner))
    if (capsuleLine) lines.push(capsuleLine)
  } catch {
    /* slice absent — nothing to retain */
  }
  return lines.join('\n')
}
