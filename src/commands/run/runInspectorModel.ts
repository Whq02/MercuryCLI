// ============================================================================
//  runInspectorModel — the PURE row model behind /run.
//  React-free so the proof suite exercises the real projection: a
//  RunSnapshot folds into ordered, bounded display rows; the component only
//  paints them. One source of truth — the same snapshot the stop evaluator
//  reads.
// ============================================================================

import {
  openDeliverables,
  type RunSnapshot,
} from '../../services/run/runKernel.js'
import {
  bootRecoveryStatusLine,
  type BootRecoveryState,
} from '../../substrate/recoveryOrchestrator.js'
import { truncateToWidth } from '../../utils/truncate.js'

export interface RunRow {
  section: string
  /** One collapsed line (already bounded; the renderer truncates to width). */
  line: string
  /** Expanded evidence lines (↵ on the row). */
  detail: string[]
  tone: 'ok' | 'warn' | 'fail' | 'neutral' | 'accent'
}

function age(at: number | null | undefined, now: number): string {
  if (!at) return '—'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const LIFECYCLE_TONE: Record<RunSnapshot['lifecycle'], RunRow['tone']> = {
  idle: 'neutral',
  active: 'accent',
  paused: 'warn',
  blocked: 'warn',
  interrupted: 'warn',
  failed: 'fail',
  cancelled: 'neutral',
  completed: 'ok',
}

/** Fold a snapshot into the inspector's ordered rows. */
export function buildRunRows(snapshot: RunSnapshot, now: number): RunRow[] {
  const rows: RunRow[] = []
  rows.push({
    section: 'RUN',
    line: `${snapshot.lifecycle.toUpperCase()} · phase ${snapshot.phase} · started ${age(snapshot.startedAt, now)} · updated ${age(snapshot.updatedAt, now)}`,
    detail: [
      `objective: ${snapshot.objective}`,
      `run id: ${snapshot.runId}`,
      `phase reason: ${snapshot.phaseReason}`,
      `substantive: ${snapshot.substantive ? 'yes' : 'no (lightweight turn — not persisted)'}`,
      `continuations: ${snapshot.continuationCount}`,
    ],
    tone: LIFECYCLE_TONE[snapshot.lifecycle],
  })

  const open = openDeliverables(snapshot)
  const done = snapshot.deliverables.filter(d => d.state === 'done').length
  if (snapshot.deliverables.length > 0) {
    rows.push({
      section: 'DELIVERABLES',
      line: `${done}/${snapshot.deliverables.length} done${open.length ? ` · next open: ${open[0]!.title || open[0]!.id}` : ' · all closed'}`,
      detail: snapshot.deliverables.map(d => `[${d.state}] ${d.title || d.id}`),
      tone: open.length === 0 ? 'ok' : 'accent',
    })
  }

  if (snapshot.blocker) {
    rows.push({
      section: 'BLOCKER',
      line: `${snapshot.blocker.ownedBy}: ${snapshot.blocker.description}`,
      detail: [`resumes when: ${snapshot.blocker.resumeCondition}`, `since: ${age(snapshot.blocker.at, now)}`],
      tone: 'warn',
    })
  } else if (snapshot.nextAction) {
    rows.push({
      section: 'NEXT',
      line: snapshot.nextAction,
      detail: snapshot.lastStopDecision
        ? [
            `last stop decision: ${snapshot.lastStopDecision.decision} (${age(snapshot.lastStopDecision.at, now)})`,
            snapshot.lastStopDecision.detail,
          ]
        : [],
      tone: 'accent',
    })
  }

  rows.push({
    section: 'EFFECTS',
    line:
      snapshot.recentEffects.length === 0
        ? 'no tool effects yet'
        : `${snapshot.totalChangedPaths} path(s) changed · ${snapshot.unresolvedBadEffects} unresolved failed/indeterminate · ${snapshot.pendingTools.length} in flight`,
    detail: [
      ...snapshot.recentEffects
        .slice(-10)
        .map(e => `${e.outcome === 'succeeded' ? '+' : e.outcome === 'failed' ? 'x' : '?'} ${e.operation || e.toolName} ${e.outcome}${e.changedPaths.length ? ` → ${e.changedPaths.join(', ')}` : ''} (${age(e.at, now)})`),
      ...snapshot.changedPaths.slice(-10).map(p => `changed: ${p}`),
    ],
    tone: snapshot.unresolvedBadEffects > 0 ? 'warn' : 'neutral',
  })

  rows.push({
    section: 'EVIDENCE',
    line: `${snapshot.verification.state} — ${snapshot.verification.detail}`,
    detail: [],
    tone:
      snapshot.verification.state === 'verified'
        ? 'ok'
        : snapshot.verification.state === 'failed'
          ? 'fail'
          : snapshot.verification.state === 'stale'
            ? 'warn'
            : 'neutral',
  })

  rows.push({
    section: 'CONTEXT',
    line: `epoch ${snapshot.contextEpoch}${snapshot.lastContextTransition ? ` · last: ${snapshot.lastContextTransition.kind} (${age(snapshot.lastContextTransition.at, now)})` : ' · no transitions yet'}`,
    detail: snapshot.lastContextTransition ? [`reason: ${snapshot.lastContextTransition.reason}`] : [],
    tone: 'neutral',
  })

  rows.push({
    section: 'IDE',
    line: `${snapshot.ideFeedback.state}${snapshot.ideFeedback.at ? ` (${age(snapshot.ideFeedback.at, now)})` : ''} — ${snapshot.ideFeedback.detail}`,
    detail: [],
    tone:
      snapshot.ideFeedback.state === 'clean'
        ? 'ok'
        : snapshot.ideFeedback.state === 'dirty'
          ? 'warn'
          : 'neutral',
  })

  rows.push({
    section: 'TIMELINE',
    line: `${snapshot.totalEvents} event(s) · showing last ${Math.min(12, snapshot.recentEvents.length)}`,
    detail: snapshot.recentEvents
      .slice(-12)
      .map(e => `${e.type} (${age(e.at, now)})`),
    tone: 'neutral',
  })

  return rows
}

/** The boot-recovery row: what the orchestrator
 *  reconciled before this session's projection was built. Null when recovery
 *  ran clean and found nothing — a quiet boot earns no row. Pure. */
export function buildBootRecoveryRow(recovery: BootRecoveryState): RunRow | null {
  const line = bootRecoveryStatusLine(recovery)
  if (!line) return null
  const r = recovery.report
  const detail: string[] = []
  if (r) {
    detail.push(`scope: ${r.scope} · started ${r.startedAt} · ${r.durationMs}ms`)
    detail.push(`orphan temps: ${r.orphanTemps.removed} removed across ${r.orphanTemps.dirsSwept} dir(s)`)
    if (r.teamJournal) {
      detail.push(
        `team journal: ${r.teamJournal.scanned} scanned · ${r.teamJournal.rolledForward.length} rolled forward · ${r.teamJournal.compensated.length} compensated · ${r.teamJournal.waiting.length} waiting · ${r.teamJournal.unrecoverable.length} unrecoverable`,
      )
    }
    if (r.runJournal) {
      detail.push(
        `run journal: ${r.runJournal.scanned} scanned · ${r.runJournal.rolledForward.length} rolled forward · ${r.runJournal.compensated.length} compensated · ${r.runJournal.unrecoverable.length} unrecoverable`,
      )
    }
    detail.push(`dead-epoch tasks: ${r.deadEpochTasks.removed} reclaimed across ${r.deadEpochTasks.listsChecked} list(s)`)
    if (r.leaderProjection) detail.push(`leader projection rebuilt: "${r.leaderProjection.teamName}"`)
    if (r.quarantine.recent > 0) {
      detail.push(`store quarantines: ${r.quarantine.recent} in the last 24h (${r.quarantine.total} on the ledger)`)
    }
    detail.push(...r.errors.map(e => `error: ${e}`))
    detail.push(...r.notes.map(n => `note: ${n}`))
  }
  return {
    section: 'RECOVERY',
    line: line.text,
    detail,
    tone: line.tone === 'ok' ? 'ok' : line.tone === 'warn' ? 'warn' : 'neutral',
  }
}

/** The frame capsule line (one bounded line; null = no capsule shown). */
export function buildRunCapsuleLine(snapshot: RunSnapshot | null, now: number): string | null {
  if (!snapshot || !snapshot.substantive) return null
  if (snapshot.lifecycle === 'completed' || snapshot.lifecycle === 'cancelled') return null
  const open = openDeliverables(snapshot)
  const done = snapshot.deliverables.filter(d => d.state === 'done').length
  const parts: string[] = [`run ${snapshot.lifecycle}`, snapshot.phase]
  if (snapshot.deliverables.length > 0) parts.push(`${done}/${snapshot.deliverables.length}`)
  // SSR-06: the sentence budgets hold, but the cut is HONEST —
  // display cells (grapheme-aware, wide glyphs priced right) with a
  // trailing ellipsis, never a silent mid-cluster code-unit chop. A line
  // that fits its budget is byte-identical to before.
  if (snapshot.blocker) {
    parts.push(`BLOCKED: ${truncateToWidth(snapshot.blocker.description, 40)}`)
  } else if (snapshot.nextAction) {
    parts.push(`next: ${truncateToWidth(snapshot.nextAction, 48)}`)
  } else if (snapshot.lastAction) {
    parts.push(truncateToWidth(snapshot.lastAction, 48))
  }
  if (snapshot.unresolvedBadEffects > 0) parts.push(`${snapshot.unresolvedBadEffects}!`)
  void now
  return parts.join(' · ')
}
