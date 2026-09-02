// ============================================================================
//  dispatchRouter — the "open-router-like" per-task routing decision (#42 R3).
// ----------------------------------------------------------------------------
//  Every dispatch today goes to ONE Implementer pinned at a fixed effort regardless
//  of how hard the task is — a trivial rename and a deep migration pay identical
//  effort. This is the pure, deterministic, inspectable classifier that matches
//  effort to task hardness so MAX is spent only where it pays (the effort-payoff
//  doctrine, now per-task instead of per-role) — the benchmark-quality lever.
//
//  PURE (no React, no I/O, no LLM-judge in the hot path) — mirrors decideRoute /
//  scribeRoute's shape, bun-run testable. The Scribe MAY override by setting a
//  `route` on the dispatch envelope (it has the refined spec + repo context); this
//  is the daemon's backstop when the envelope omits one. Cheap signals only:
//  deep-work keywords, file-count, task length, mechanical-edit keywords.
//
//  SAFETY FLOOR (the no-trade-off requirement): applying effort is a RESPAWN (fresh
//  transcript), so the daemon applies a route change ONLY at a real turn boundary
//  (never mid-task) and folds the handoff summary into the new child's first frame.
//  And the floor here: never route a NON-trivial task below 'xhigh' — only a clearly
//  mechanical one drops to 'high'. Gated MERCURY_SCRIBE_TASK_ROUTER (default-OFF until
//  A/B-benchmarked); OFF ⇒ the fixed pin, byte-identical.
// ============================================================================

export type RouteEffort = 'high' | 'xhigh' | 'max'
export type RouteLane = 'quick' | 'standard' | 'deep'

export interface DispatchRouteDecision {
  effort: RouteEffort
  lane: RouteLane
  reason: string
}

/** Deep-work signals: substantial, multi-step, or risk-bearing work that earns MAX. */
const DEEP_KW =
  /\b(refactor|refactoring|migrat\w*|architect\w*|rewrite|re-?write|redesign|debug\w*|root[- ]?cause|investigat\w*|overhaul|concurren\w*|race[- ]?condition|deadlock|security|vulnerab\w*|audit|optimiz\w*|performance|design\b|algorithm|end[- ]?to[- ]?end)\b/

/** Mechanical signals: a small, well-bounded edit that does not need MAX. */
const QUICK_KW =
  /\b(rename|typo|comment|docstring|format\w*|lint|prettier|bump|version|whitespace|reorder imports?|one[- ]?liner|trivial|tweak|nit|rename the|fix the comment|update the comment)\b/

/** Count distinct file-path-looking tokens in the task (a proxy for blast radius). */
function fileMentions(text: string): number {
  const m = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|md|json|ya?ml|sh|css|scss|html|sql|toml)\b/gi)
  return m ? new Set(m.map(s => s.toLowerCase())).size : 0
}

/**
 * Decide the routed effort/lane for a dispatched task. Deterministic + pure.
 *   - DEEP (deep keywords, or ≥3 files, or a long spec ≥600 chars)  ⇒ max / deep.
 *   - MECHANICAL (quick keyword, ≤1 file, short <220 chars)         ⇒ high / quick.
 *   - everything else                                                ⇒ xhigh / standard.
 * The floor: a non-mechanical task NEVER drops below xhigh (never under-power real work).
 */
export function decideDispatchRoute(task: string, opts?: { title?: string }): DispatchRouteDecision {
  const text = `${opts?.title ?? ''}\n${task ?? ''}`.toLowerCase()
  const len = (task ?? '').length
  const files = fileMentions(text)
  const deep = DEEP_KW.test(text) || files >= 3 || len >= 600
  if (deep) {
    return { effort: 'max', lane: 'deep', reason: `deep work (keywords/${files} files/${len} chars) — earns max` }
  }
  const mechanical = QUICK_KW.test(text) && files <= 1 && len < 220
  if (mechanical) {
    return { effort: 'high', lane: 'quick', reason: 'mechanical edit (bounded, single-file) — high is enough' }
  }
  return { effort: 'xhigh', lane: 'standard', reason: 'standard task — xhigh (the non-trivial floor)' }
}

/** Validate/clamp an operator- or Scribe-supplied effort to the allowed set; unknown
 *  ⇒ undefined (the caller falls back to the deterministic classifier). */
export function normalizeRouteEffort(v: unknown): RouteEffort | undefined {
  return v === 'high' || v === 'xhigh' || v === 'max' ? v : undefined
}

/**
 * Resolve the effort to apply for a dispatch: the envelope's explicit route.effort wins
 * (the Scribe's judgment), else the deterministic classifier. Pure.
 */
export function resolveDispatchEffort(
  task: string,
  envelopeEffort: unknown,
  opts?: { title?: string },
): { effort: RouteEffort; source: 'envelope' | 'classifier'; reason: string } {
  const explicit = normalizeRouteEffort(envelopeEffort)
  if (explicit) return { effort: explicit, source: 'envelope', reason: 'Scribe-specified route' }
  const d = decideDispatchRoute(task, opts)
  return { effort: d.effort, source: 'classifier', reason: d.reason }
}
