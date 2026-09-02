// ============================================================================
//  operatorPause — the typed OPERATOR pause/stop directive.
//
//  The guarded field defect: the operator writes "stop the workflow rq
//  lets pause here"; the workflow is killed, but the run contract still holds
//  open deliverables, so the very next stop evaluation demands "work the
//  open deliverable"
//  — default pressure pointing at overriding an explicit human stop (the
//  agent argued out via BLOCKED ON OPERATOR; a literal agent restarts a
//  halted Opus fan-out). The operator's pause must SETTLE the run state
//  BEFORE completion evaluation and beat open-deliverable pressure.
//
//  This module is the ONE conservative grammar for "the operator just told
//  the run to pause/stop". Precision over recall, by construction:
//   · terse directives only (length-capped) — long messages are new
//     instructions, never a pause;
//   · verb-anchored: pause / stop / hold (off|on) as a VERB — noun usage
//     ("the pause menu") and preceding negation ("don't stop") never match;
//   · the verb's OBJECT must be the work itself (workflow/run/agents/
//     everything/here/now/…) — "stop the leak", "stop worrying", "pause
//     playback" never match.
//  Resumption stays the kernel's existing law: ONLY a new operator request
//  ('request-accepted') reactivates a paused run — the stop path never
//  auto-resumes, whatever the deliverable state says.
//
//  Pure + React-free; proven in scripts/longrun-invariants/prove-operator-pause.ts.
// ============================================================================

/** Directives longer than this are instructions, not a pause. */
export const MAX_PAUSE_DIRECTIVE_CHARS = 160

const PAUSE_VERBS = new Set(['pause', 'stop', 'hold'])

/** Tokens that negate or nominalize the verb when immediately before it. */
const PRE_VERB_BLOCKERS = new Set([
  "don't", 'dont', 'not', 'never', 'no', "won't", 'wont', "shouldn't",
  'shouldnt', "can't", 'cant', 'cannot', 'without', 'the', 'a', 'an', 'my',
  'our', 'this', 'that', 'implement', 'add', 'build', 'support', 'make',
  'fix', 'test', 'handle',
])

/** Articles skipped between the verb and its object. */
const OBJECT_ARTICLES = new Set(['the', 'this', 'that', 'all'])

/** Objects that mean "the current work" (plus pause-idiom particles). */
const WORK_OBJECTS = new Set([
  'workflow', 'workflows', 'run', 'runs', 'work', 'working', 'agent',
  'agents', 'fanout', 'fan-out', 'task', 'tasks', 'everything', 'it', 'this',
  'that', 'here', 'now', 'there', 'on', 'off', 'up', 'rq', 'please', 'for',
  'sec', 'second', 'bit', 'moment', 'minute', 'min', 'real', 'quick', 'a',
])

export type OperatorPauseVerdict =
  | { kind: 'pause'; directive: string }
  | { kind: 'none' }

/**
 * Parse ONE user message for an explicit operator pause/stop directive.
 * Conservative: any doubt ⇒ 'none' (a wrongly-continued run costs an
 * expensive fan-out; a wrongly-paused one costs a single operator message,
 * so precision guards the MATCH side, not the miss side).
 */
export function parseOperatorPauseDirective(text: string): OperatorPauseVerdict {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw || raw.length > MAX_PAUSE_DIRECTIVE_CHARS) return { kind: 'none' }
  const tokens = raw
    .toLowerCase()
    .replace(/[.,!?…;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!PAUSE_VERBS.has(tok)) continue
    // "lets"/"let's" before the verb is a strong imperative signal; a blocker
    // token immediately before rejects (negation / article / build-verb).
    const prev = tokens[i - 1]
    if (prev !== undefined && PRE_VERB_BLOCKERS.has(prev)) continue
    // Resolve the object: skip articles, then test the work vocabulary.
    let j = i + 1
    while (j < tokens.length && OBJECT_ARTICLES.has(tokens[j]!)) j++
    const object = tokens[j]
    if (object === undefined || WORK_OBJECTS.has(object)) {
      return { kind: 'pause', directive: raw.slice(0, 120) }
    }
    // Wrong object ("stop the leak") — keep scanning later clauses
    // ("stop the leak … actually, pause here" still pauses).
  }
  return { kind: 'none' }
}
