
// ============================================================================
//  utils/hooks/unfinishedTail.ts — the keep-working WORDING detector.
//
//  The Mercury doctrine *requests* "just keep working — don't end a turn on a
//  plan, a promise, or a question you can answer yourself". A prompt can only
//  request it; the keep-working Stop hooks ENFORCE it, and every one reads
//  THIS one detector: does the turn's LAST paragraph end on an unfinished tail (a
//  promise "I'll…", a next-steps plan, or a question the model could answer
//  itself)? The model can always escape cleanly: a turn that ends on a real
//  status (done / blocked / past-tense evidence) is NOT an unfinished tail.
//  Pure — no hook registration lives here.
// ============================================================================

/**
 * Future-facing / promise / question fingerprints that mark a turn's last
 * paragraph as an UNFINISHED tail. Deliberately targets FUTURE intent ("I'll…",
 * "next I'll", "let me", "should I", "want me to", "here's the plan", a trailing
 * question) — NOT past-tense completion ("Done", "Fixed", "STATUS: done",
 * file:line evidence), so a normal terse closing summary is allowed to stop.
 */
// Named refs for the two idioms that get a NARROW clause-scoped disarm below
// (the guarded class: a finished, evidenced close that merely NAMES the idiom
// — "No further next steps — complete." / "Let me know if you spot regressions."
// — must not trip the re-prompt). Identity (===) is what the disarm keys on.
const NEXT_STEPS_RE = /\bnext steps?\b/i
const LET_ME_KNOW_RE = /\blet me know\b/i

const UNFINISHED_TAIL_PATTERNS: RegExp[] = [
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bi am going to\b/i,
  /\blet me\b/i,
  /\bnext,?\s+i\b/i,
  NEXT_STEPS_RE,
  /\bi plan to\b/i,
  /\bhere'?s (?:the|my) plan\b/i,
  /\bhere is (?:the|my) plan\b/i,
  /\bshould i\b/i,
  /\bwould you like\b/i,
  /\bwant me to\b/i,
  /\bdo you want (?:me )?to\b/i,
  /\bshall i\b/i,
  LET_ME_KNOW_RE,
]

/**
 * The SOFT-PROMISE subset of the fingerprints — first-person future-intent openers
 * ("I'll…", "I will", "I'm going to", "let me"). These are the ONLY patterns the
 * blocked/refusal carve-out below applies to: a promise that the model NEGATES or
 * hands off in the SAME CLAUSE ("I'll stop here — this is blocked on your approval")
 * is a legitimate rest, not a live self-promise. The non-promise patterns (questions,
 * "next steps", a plan announcement) are NEVER exempted — those are still stalls.
 */
const SOFT_PROMISE_PATTERNS: RegExp[] = [
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bi am going to\b/i,
  /\blet me\b/i,
]

/**
 * In-clause markers that DISARM a soft promise: an immediate negation ("I will NOT…",
 * "I won't…", "I can't…") OR a blocked / handoff / awaiting-the-operator marker
 * ("blocked on your approval", "needs you to decide", "waiting on you", "your call").
 * A promise in a clause that ALSO carries one of these is a blocked/handoff rest, not a
 * live promise. Kept tight so a genuine soft-promise ("I'll fix the test next") still
 * BLOCKS — no generic "approval" word soup; the markers name a real wait-for-operator state.
 */
// Explicit operator-GATE markers — the model is waiting on a REAL operator decision
// ("blocked on your approval", "needs your sign-off", "your call"). Each BOUND to a real
// operator/wait object, never a bare work-noun (a bare /approval/ etc. would disarm a
// genuine live promise that merely NAMES the noun as work — "I'll write the approval test
// cases"). Shared by (a) PROMISE_DISARM_MARKERS below — disarming a soft promise in a
// STATEMENT — and (b) the QUESTION carve-out in isUnfinishedTail, where an explicit
// operator-gate question is a legitimate rest even for the autonomous role (the agent
// literally cannot proceed without the human). NOT the generic "I'll wait for your next
// message" idle hand-back.
const AWAITING_OPERATOR_MARKERS: RegExp[] = [
  /\bblocked (?:on|pending|by|until|awaiting)\b/i,
  /\bpermission (?:from|of) (?:you|the operator)\b/i,
  /\byour (?:decision|call|go-?ahead|approval|sign-?off)\b/i,
  /\b(?:needs?|need) (?:you|your)\b/i,
  /\bup to you\b/i,
  /\bwaiting (?:on|for) (?:you|your)\b.*\b(?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\bawait(?:ing)? your (?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\bpending your (?:approval|decision|go-?ahead|sign-?off|call|review|input|response|reply|confirmation)\b/i,
  /\byou (?:decide|approve|confirm|sign off)\b/i,
]

// DECLARED-INABILITY markers: the model has
// SAID the objective needs a capability/access/tool it does not have. Such a
// tail is a FINISHED status — even when it ends by offering alternatives with
// a question ("I can't render images — want an SVG instead?"): pre-#52 the
// bare-refusal rule pushed exactly that tail, and the field result was a
// 3-hour grind on an impossible image ask with no handoff
// Each pattern BINDS the negation to an
// action/capability object so an investigative "I can't see why X fails yet"
// (a live task, not a missing capability) still blocks.
const CAPABILITY_REFUSAL_MARKERS: RegExp[] = [
  /\b(?:can'?t|cannot|can not|am unable to|won'?t be able to|not able to)\s+(?:do|make|generate|create|produce|render|access|run|execute|perform|provide|send|reach|open|complete|build)\b/i,
  /\b(?:impossible|not (?:possible|supported|available))\b/i,
  /\b(?:lack|don'?t have|do not have|missing)\s+(?:the\s+)?(?:capabilit(?:y|ies)|ability|tool(?:s|ing)?|access|permission|credential)/i,
  /\bno (?:tool|capability|way) (?:for|to)\b/i,
  /\bSTATUS:\s*impossible\b/i,
]

// In-clause markers that DISARM a soft promise: an immediate negation ("I won't…",
// "I will not…", "I can't…") OR an explicit operator-gate (AWAITING_OPERATOR_MARKERS).
// A promise in a clause that ALSO carries one of these is a blocked/handoff rest, not a
// live promise. Negation is deliberately NOT a bare "not"/"never" (a stray negation
// elsewhere — "I'll fix the bug that does not show" — must not disarm a live promise).
const PROMISE_DISARM_MARKERS: RegExp[] = [
  /\b(?:won'?t|will not|can'?t|cannot|can not|shan'?t)\b/i,
  /\bi'?m not going to\b/i,
  /\bi am not going to\b/i,
  /\bi will not\b/i,
  ...AWAITING_OPERATOR_MARKERS,
]

/**
 * DESTRUCTIVE / IRREVERSIBLE-ACTION markers — the ONLY consent-seeking questions that REST
 * in the autonomous role (operator setting: "more autonomous"). Fable stays pushy EXCEPT
 * before a clearly destructive or irreversible action (delete / drop / overwrite / wipe /
 * truncate / force-push / prod). A BARE refusal ("I won't run that — want a safer way?") or
 * a generic "are you sure?" no longer rests; only a question NAMING a high-stakes action
 * does (an explicit operator-gate also rests, via AWAITING_OPERATOR_MARKERS in the question
 * branch). The SAFE failure direction is preserved — a false REST only costs keep-working
 * persistence (never a gate bypass), and the re-prompt still forbids bypassing a
 * permission/approval/capability/REFUSAL gate. Used ONLY for tails that END in a question.
 */
const SAFETY_PAUSE_MARKERS: RegExp[] = [
  // destructive / irreversible action verbs
  /\b(?:delet\w*|drop(?:s|ping|ped)?|destroy\w*|wip(?:e|es|ing|ed)|truncat\w*|overwrit\w*|purg\w*|eras\w*|force[- ]?push\w*)\b/i,
  /\brm\s+-[rf]/i,
  /\breset --hard\b/i,
  // irreversibility / consequence words
  /\b(?:irreversible|irreversibly|destructive|permanent(?:ly)?|unrecoverable)\b/i,
  /\bcan(?:no|')?t be undone\b/i,
  /\b(?:data[- ]?loss|los(?:e|ing) data)\b/i,
  // high-stakes target
  /\b(?:production|prod)\b/i,
]

/**
 * Split a tail into bounded CLAUSES on hard separators — sentence/segment boundaries
 * (`. ; \n :`) but NOT a comma (a comma keeps the clause whole, so "I'll wait, but first
 * I'll dispatch X" stays one live-promise clause). Bounding the negation/blocked scope to
 * the SAME clause is what stops a far-away "not" from disarming an unrelated promise.
 */
function splitClauses(text: string): string[] {
  return text
    .split(/[.;:\n]+/)
    .map(c => c.trim())
    .filter(Boolean)
}

/**
 * Is a soft-promise fingerprint present that is NOT disarmed in its own clause? Returns
 * true only when SOME clause carries a soft-promise opener AND that same clause carries
 * no negation/blocked/handoff marker — i.e. a genuinely LIVE promise. A promise that is
 * negated or handed off in-clause ("I'll stop here — blocked on your approval") yields
 * false here, so the keep-working hook lets that legitimate rest stop.
 */
function hasLiveSoftPromise(probe: string): boolean {
  for (const clause of splitClauses(probe)) {
    // The courtesy close "let me know if …" is not a promise of future work —
    // strip that idiom before probing so its "let me" never reads as a soft
    // promise (any OTHER live promise in the same clause still counts).
    const probeClause = clause.replace(COURTESY_LET_ME_KNOW, '')
    if (!SOFT_PROMISE_PATTERNS.some(re => re.test(probeClause))) continue
    if (PROMISE_DISARM_MARKERS.some(re => re.test(probeClause))) continue
    return true
  }
  return false
}

/**
 * The NON-promise fingerprints — everything in UNFINISHED_TAIL_PATTERNS that is not a
 * soft-promise opener (the questions, "next steps", a plan announcement). These are
 * stalls regardless of any blocked/negation marker, so they are matched against the
 * whole probe with NO carve-out.
 */
const NON_PROMISE_PATTERNS: RegExp[] = UNFINISHED_TAIL_PATTERNS.filter(
  re => !SOFT_PROMISE_PATTERNS.some(p => p.source === re.source),
)

// NARROW disarms for two non-promise idioms (audit LOW — the false-
// positive class: a completed, evidenced close tripping the silent re-prompt and
// burning a wasted turn). Clause-scoped like the soft-promise disarm:
//  • "let me know IF …" — the closing courtesy conditional ("let me know if you
//    spot regressions") is a rest; "let me know WHICH/WHAT/…" (a blocking ask
//    the model needs answered) still stalls.
//  • "next steps" in a clause that ALSO carries a completion/negation marker
//    ("No further next steps — complete.") is a rest; a live plan announcement
//    ("Next steps: …" — the colon splits the clause, so list content can't
//    disarm it) still stalls.
const COURTESY_LET_ME_KNOW = /\blet me know if\b/i
const NEXT_STEPS_COMPLETION_MARKERS =
  /\b(?:done|complete(?:d)?|finished|fixed|resolved|shipped|landed|verified|green|passing|no (?:further|more|remaining|other))\b/i

/** Clause-scoped non-promise stall test (mirrors hasLiveSoftPromise's shape). */
function hasNonPromiseStall(probe: string): boolean {
  for (const clause of splitClauses(probe)) {
    for (const re of NON_PROMISE_PATTERNS) {
      if (!re.test(clause)) continue
      if (re === LET_ME_KNOW_RE && COURTESY_LET_ME_KNOW.test(clause)) continue
      if (re === NEXT_STEPS_RE && NEXT_STEPS_COMPLETION_MARKERS.test(clause)) continue
      return true
    }
  }
  return false
}

/**
 * The full fingerprint test with the blocked/refusal carve-out applied: a probe is an
 * unfinished tail if it matches a NON-promise stall pattern (question/next-steps/plan —
 * clause-scoped, with only the two narrow idiom disarms above) OR carries a LIVE
 * (in-clause non-disarmed) soft promise. A soft promise that is negated or handed off
 * in its own clause is NOT counted. This is the single seam the final return rides.
 */
function probeIsUnfinished(probe: string): boolean {
  return hasNonPromiseStall(probe) || hasLiveSoftPromise(probe)
}

/**
 * Strip markdown list/quote/heading markers from a line so a fingerprint at the
 * start of a bulleted next-step ("- I'll wire it up") still matches.
 */
function stripLineMarkers(line: string): string {
  return line.replace(/^[\s>#*\-\d.)+]+/, '').trim()
}

/**
 * The last non-empty paragraph of a text block (paragraphs split on blank
 * lines). The autonomous-turn-discipline rule is explicitly about the LAST
 * paragraph, so mid-stream worklog terseness never trips the hook.
 */
function lastParagraph(text: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  return paras.length > 0 ? paras[paras.length - 1]! : ''
}

/**
 * Does the given assistant text END on an unfinished tail (a promise/plan/
 * question), as opposed to a finished status? Pure + exported for the proof
 * harness and the ablation. Empty/whitespace text is NOT unfinished (a pure
 * tool-use turn with no prose is fine to stop on — that's peak Fable).
 */
export function isUnfinishedTail(text: string): boolean {
  const tail = lastParagraph(text)
  if (!tail) return false

  // A trailing question to the user (the last sentence ends with '?'). For the
  // autonomous role this is a stall (no human channel) — UNLESS it is a
  // structured option-bearing question ("Scope — whole map, or just this room?").
  if (/\?\s*$/.test(tail)) {
    // A consent-seeking question about a clearly DESTRUCTIVE / irreversible action — one
    // gated on an explicit operator decision — or a DECLARED capability gap (#52) is a
    // legitimate rest even for the autonomous role: pausing before an irreversible action,
    // waiting on the human, or honestly declaring "this needs a capability I don't have —
    // alternatives?" is the SAFE behavior, not a stall. A bare refusal or generic
    // "are you sure?" WITHOUT a named capability/action gap still falls through (fable stays
    // pushy on everything that isn't high-stakes or genuinely impossible). This
    // short-circuits BOTH the trailing-question block here AND the final probeIsUnfinished
    // (a destructive tail can also match a `do you want me to` non-promise pattern, so the
    // carve-out must gate the whole check).
    if (
      SAFETY_PAUSE_MARKERS.some(re => re.test(tail)) ||
      AWAITING_OPERATOR_MARKERS.some(re => re.test(tail)) ||
      CAPABILITY_REFUSAL_MARKERS.some(re => re.test(tail))
    ) {
      return false
    }
    const structuredOption = /—.*,/.test(tail) || /\bor\b.*\?\s*$/i.test(tail)
    if (!structuredOption) return true
  }

  // A promise/plan fingerprint anywhere in the last paragraph or its last line.
  const lines = tail.split('\n').map(stripLineMarkers).filter(Boolean)
  const lastLine = lines.length > 0 ? lines[lines.length - 1]! : tail
  const probe = `${tail}\n${lastLine}`
  // Blocked/refusal carve-out: a soft promise that is negated or handed off in the SAME
  // clause ("I'll stop here — this is blocked on your approval") is a legitimate rest, NOT
  // a live promise — so it does not block the stop. Genuine soft-promise tails ("I'll fix
  // the test next") still block; questions / next-steps / plan announcements are unaffected.
  return probeIsUnfinished(probe)
}

