
export type RouteEffort = 'high' | 'xhigh' | 'max'
export type RouteLane = 'quick' | 'standard' | 'deep'

export interface DispatchRouteDecision {
  effort: RouteEffort
  lane: RouteLane
  reason: string
}

const DEEP_KW =
  /\b(refactor|refactoring|migrat\w*|architect\w*|rewrite|re-?write|redesign|debug\w*|root[- ]?cause|investigat\w*|overhaul|concurren\w*|race[- ]?condition|deadlock|security|vulnerab\w*|audit|optimiz\w*|performance|design\b|algorithm|end[- ]?to[- ]?end)\b/

const QUICK_KW =
  /\b(rename|typo|comment|docstring|format\w*|lint|prettier|bump|version|whitespace|reorder imports?|one[- ]?liner|trivial|tweak|nit|rename the|fix the comment|update the comment)\b/

function fileMentions(text: string): number {
  const m = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|md|json|ya?ml|sh|css|scss|html|sql|toml)\b/gi)
  return m ? new Set(m.map(s => s.toLowerCase())).size : 0
}

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

export function normalizeRouteEffort(v: unknown): RouteEffort | undefined {
  return v === 'high' || v === 'xhigh' || v === 'max' ? v : undefined
}

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
