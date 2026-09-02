// ============================================================================
//  blockerDeclaration — the typed operator-blocker declaration grammar
//
//
//  Before this module the completion evaluator's `blocked` escape was
//  UNREACHABLE: evaluateStop returned blocked only when snap.blocker was
//  already set, but the only minter of a `blocked` run event was the stop
//  adapter's handling of that same decision — mutually circular. The observed
//  live consequence: the run-stop hook re-prompted
//  "state the one blocker plainly", the model stated it, and NOTHING honored
//  it — every turn exited by budget exhaustion and the nag resumed.
//
//  This is the real escape: a STRICT two-line declaration the model ends its
//  message with when it is genuinely blocked on operator-only input:
//
//      BLOCKED ON OPERATOR: <what you need>
//      RESUME WHEN: <what unblocks you>
//
//  The stop adapter parses the stop attempt's final assistant text with
//  parseBlockerDeclaration and, on a well-formed declaration, folds the
//  `blocked` run event (ownedBy 'operator') — the evaluator then answers
//  `blocked`, the loop terminates ONCE with a loud /run + capsule surface,
//  and the next operator turn clears it (request-accepted → active,
//  blocker null).
//
//  Honesty bounds (a model-claimed blocker is a CLAIM, never a lazy exit):
//   · both fields are REQUIRED and need substance (≥ MIN_FIELD_WORDS words) —
//     a bare "BLOCKED ON OPERATOR: stuck" is refused with a named reason;
//   · the declaration must END the message (content after it is refused), so
//     a mid-prose mention or quoted grammar never mints a blocker;
//   · the fold is loud and bounded: one visible blocked transition, the
//     blocker text on /run and the frame capsule, cleared on the operator's
//     next message — a false declaration is always operator-visible.
//
//  Pure + React-free like the rest of the run kernel: proof scripts exercise
// the grammar directly (scripts/run/prove-run-completion.ts).
// ============================================================================

export type BlockerDeclarationParse =
  | { kind: 'none' }
  | { kind: 'declared'; description: string; resumeCondition: string }
  | { kind: 'refused'; reason: string }

/** The exact grammar, quoted wherever the model is taught the escape. */
export const BLOCKER_DECLARATION_GRAMMAR =
  '"BLOCKED ON OPERATOR: <what you need>" then "RESUME WHEN: <what unblocks you>" (two lines, ending the message)'

const MARKER_RE = /^blocked on operator\s*:\s*(.*)$/i
const RESUME_RE = /^resume when\s*:\s*(.*)$/i

/** Substance floor: each field must carry at least this many words. */
export const MIN_FIELD_WORDS = 3

/** Bounded fold: each field is truncated to this many characters. */
export const MAX_FIELD_CHARS = 280

/** Strip leading list/quote/emphasis decoration and trailing emphasis so a
 *  bulleted or bolded declaration still parses; the field text itself is
 *  whatever follows the label. */
function stripLineDecoration(line: string): string {
  return line
    .replace(/^[\s>*_`#-]+/, '')
    .replace(/[\s*_`]+$/, '')
    .trim()
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

function clamp(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS - 1)}…` : s
}

/**
 * Parse a stop attempt's final assistant text for the typed declaration.
 * 'none' = no marker anywhere (the common case — zero cost, zero noise);
 * 'refused' = the marker is present but the declaration is malformed or
 * without substance (the named reason feeds the re-prompt so the model can
 * correct it instead of burning budget); 'declared' = honor it.
 */
export function parseBlockerDeclaration(text: string): BlockerDeclarationParse {
  const lines = text.split('\n')
  let markerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (MARKER_RE.test(stripLineDecoration(lines[i]!))) {
      markerIdx = i
      break
    }
  }
  if (markerIdx === -1) return { kind: 'none' }

  const description = stripLineDecoration(lines[markerIdx]!).match(MARKER_RE)![1]!.trim()

  let resumeIdx = -1
  for (let i = markerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '') continue
    resumeIdx = i
    break
  }
  if (resumeIdx === -1) {
    return { kind: 'refused', reason: 'missing the "RESUME WHEN: <what unblocks you>" line' }
  }
  const resumeMatch = stripLineDecoration(lines[resumeIdx]!).match(RESUME_RE)
  if (!resumeMatch) {
    return {
      kind: 'refused',
      reason: 'the line after BLOCKED ON OPERATOR must be "RESUME WHEN: <what unblocks you>"',
    }
  }
  const resumeCondition = resumeMatch[1]!.trim()

  for (let i = resumeIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      return { kind: 'refused', reason: 'the declaration must be the final lines of the message' }
    }
  }

  if (wordCount(description) < MIN_FIELD_WORDS) {
    return {
      kind: 'refused',
      reason: `the blocker description needs substance (≥${MIN_FIELD_WORDS} words naming exactly what you need)`,
    }
  }
  if (wordCount(resumeCondition) < MIN_FIELD_WORDS) {
    return {
      kind: 'refused',
      reason: `the resume condition needs substance (≥${MIN_FIELD_WORDS} words naming what unblocks you)`,
    }
  }

  return { kind: 'declared', description: clamp(description), resumeCondition: clamp(resumeCondition) }
}
