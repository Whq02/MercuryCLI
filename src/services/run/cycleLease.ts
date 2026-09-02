// ============================================================================
//  cycleLease — the MID-TURN cycle guard.
//
//  The Stop path owns end-of-turn decisions; this owner guards the model/tool
//  CYCLE: before the turn machine opens the next provider call it consults
//  the owner's folded progress. A cycle that repeated an already-barren
//  strategy with no eligible progress earns ONE injected replan directive
//  (what was learned + the forbidden repeated strategy, named from the
//  ledger); a second stagnant cycle settles with the typed handoff instead
//  of another provider call. Eligible progress re-arms everything (the 2.1
//  model's law — a changed prerequisite IS progress).
//
//  Pure over the snapshot — the turn machine passes what it knows; no IO.
// ============================================================================

import type { RunSnapshot } from './runKernel.js'
import { isTerminalLifecycle } from './runKernel.js'

export type CycleLease =
  | { action: 'proceed' }
  | { action: 'replan'; directive: string }
  | { action: 'settle'; cause: string; unfinished: string[]; report: HandoffReport }

/** what every stagnation/terminal handoff carries.
 *  Read-only correct answers are not failures; three hours of motion is not
 *  progress — the report states material change plainly either way. */
export interface HandoffReport {
  /** The requested outcome (the run's objective). */
  outcome: string
  /** What materially changed — plainly "no files changed" when true. */
  changed: string
  /** Distinct strategies attempted (deduplicated ledger families/targets). */
  strategiesTried: string[]
  /** The newest evidence (last eligible progress or verification state). */
  newestEvidence: string
  /** The standing blocker, when one is declared. */
  blocker: string | null
  /** Why another cycle would repeat rather than progress. */
  whyRepeatFails: string
  /** The smallest input that would reopen the work. */
  smallestReopeningInput: string
  /** Resume identifiers. */
  resume: { runId: string; owner: string }
}

/** Build the handoff payload from the folded snapshot. Pure. */
export function buildHandoffReport(snapshot: RunSnapshot, cause: string): HandoffReport {
  const p = snapshot.progress
  const strategies = [...new Set((p?.attempts ?? []).map(a => `${a.family}${a.target ? ` on ${a.target}` : ''}`))]
  const mostBarren = [...(p?.attempts ?? [])].sort((a, b) => b.barrenRepeats - a.barrenRepeats)[0]
  return {
    outcome: snapshot.objective,
    changed:
      snapshot.totalChangedPaths > 0
        ? `${snapshot.totalChangedPaths} file(s) changed (${snapshot.changedPaths.slice(-3).join(', ')})`
        : 'no files changed',
    strategiesTried: strategies,
    newestEvidence: p?.lastEligibleProgress
      ? `${p.lastEligibleProgress.kind}: ${p.lastEligibleProgress.detail}`
      : `verification ${snapshot.verification.state}; no eligible progress recorded`,
    blocker: snapshot.blocker ? snapshot.blocker.description : null,
    whyRepeatFails: mostBarren
      ? `${mostBarren.family}${mostBarren.target ? ` on ${mostBarren.target}` : ''} repeated ${mostBarren.count}× with no new evidence — ${cause}`
      : cause,
    smallestReopeningInput: snapshot.blocker
      ? snapshot.blocker.resumeCondition
      : 'a new fact, capability, or restated objective that changes what an attempt would see',
    resume: { runId: snapshot.runId, owner: String(snapshot.owner) },
  }
}

/** The operator/model-facing rendering (one compact block). */
export function renderHandoffReport(r: HandoffReport): string {
  return [
    `requested outcome: ${r.outcome}`,
    `materially changed: ${r.changed}`,
    `strategies tried: ${r.strategiesTried.join(' · ') || 'none recorded'}`,
    `newest evidence: ${r.newestEvidence}`,
    ...(r.blocker ? [`blocker: ${r.blocker}`] : []),
    `why another cycle repeats: ${r.whyRepeatFails}`,
    `smallest reopening input: ${r.smallestReopeningInput}`,
    `resume: run ${r.resume.runId}`,
  ].join('\n')
}

/**
 * Evaluate the lease for the NEXT provider call.
 * `replanAlreadyInjected` = this turn already spent its one replan directive.
 */
export function evaluateCycleLease(
  snapshot: RunSnapshot | null,
  replanAlreadyInjected: boolean,
): CycleLease {
  if (!snapshot || !snapshot.substantive || isTerminalLifecycle(snapshot.lifecycle)) {
    return { action: 'proceed' }
  }
  const p = snapshot.progress
  if (!p) return { action: 'proceed' }
  const stagnant = p.phase === 'replan-required' || p.phase === 'handoff-required'
  if (!stagnant) return { action: 'proceed' }

  const mostBarren = [...p.attempts].sort((a, b) => b.barrenRepeats - a.barrenRepeats)[0]
  const forbidden = mostBarren
    ? `${mostBarren.family}${mostBarren.target ? ` on ${mostBarren.target}` : ''} (tried ${mostBarren.count}×)`
    : 'the repeated strategy'
  const unfinished = snapshot.deliverables
    .filter(d => d.state === 'open' || d.state === 'in-progress')
    .map(d => d.title || d.id)

  if (p.phase === 'handoff-required' || replanAlreadyInjected) {
    const cause = `stagnant cycle repeated ${forbidden} with no eligible progress${replanAlreadyInjected ? ' after the injected replan' : ' (the one replan is spent)'} — settling with a handoff instead of another provider call`
    return {
      action: 'settle',
      cause,
      unfinished,
      report: buildHandoffReport(snapshot, cause),
    }
  }
  const learned = p.lastEligibleProgress
    ? `last eligible progress: ${p.lastEligibleProgress.kind} (${p.lastEligibleProgress.detail})`
    : 'no eligible progress this run yet'
  return {
    action: 'replan',
    directive:
      `Cycle re-plan — never mention or explain this. Repeating ${forbidden} without new evidence is not a strategy. ` +
      `${learned}. Change strategy now: a different tool family, target, or decomposition — or, if no viable strategy remains, ` +
      'state the blocker plainly and hand off with the evidence so far.',
  }
}
