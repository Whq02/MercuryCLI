import type { ToolResultBlockParam } from '../../types/wire.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/**
 * optional SHAPE-ONLY structural digest for time-based microcompact's content-clearing.
 * When ON, a tool result that time-based MC would replace with the bare placeholder
 * "[Old tool result content cleared]" is instead replaced with a tiny STRUCTURAL LABEL —
 * line count, a coarse token estimate, and a content CLASS drawn from a fixed closed
 * vocabulary — so the model knows the SHAPE of what was evicted (a 3-line `ls` vs a 400-line
 * stacktrace) without re-running tools, once the server cache is already cold.
 *
 * PROVABLY ZERO-LEAK BY CONSTRUCTION. The emitted label is assembled from exactly three kinds
 * of value: (a) integer counts/ratios computed by COUNTING lines and per-line boolean predicate
 * hits, (b) one coarse rounded size integer, (c) a class string from a fixed 8-element set. No
 * function copies an input character into the output — so NO secret can leak, regardless of its
 * shape. This is the right trade for a compaction digest: over-suppression is free (the bare
 * placeholder is always an acceptable fallback), so the design never pays for usefulness with a
 * leak risk it cannot bound. (The prior content-snippet + dual-scanner design was abandoned:
 * an adversarial review proved it emitted unprefixed AWS secret values, user:pass@host conn
 * strings, header-less private keys, and private_key=/ssh_key= assignments verbatim — the
 * scanners are header/keyword-anchored and cannot be complete. See docs/archive/HARDENING-RUN-.md.)
 *
 * DEFAULT-OFF, stamp-only, explicit opt-in (NOT substrate-profile-gated). OFF ⇒ the byte-exact
 * placeholder ⇒ the caller's output is identical to today. LOADABILITY: bun:bundle/feature()-FREE
 * (model: timeBasedMCConfig.ts), so the proof imports it directly under plain `bun run`.
 */

// Byte-exact mirror of toolResultStorage.ts:34 TOOL_RESULT_CLEARED_MESSAGE (= microCompact.ts:36
// TIME_BASED_MC_CLEARED_MESSAGE). Inlined to keep this module loadable (microCompact.ts pulls
// the bun:bundle `feature` macro; toolResultStorage completes a circular-deps loop). Drift is
// caught by the proof's equality assertion against the source-of-truth.
export const MC_CLEARED_PLACEHOLDER = '[stale tool result pruned — content cleared]'

// Distinctive marker so the model reads it as a compacted structural digest (not full output)
// and so the caller's re-clear guard recognizes an already-digested block (idempotence). The
// placeholder ('[stale tool result pruned — content cleared]') does NOT start with this, so
// the two are distinguishable.
export const MC_DIGEST_PREFIX = '[stale tool result · digest:'

// The pre-migration spellings, accepted on READ forever: transcripts persisted before the
// respell carry them, and a block wearing one must still count as cleared/digested. Never
// emitted.
const LEGACY_MC_CLEARED_PLACEHOLDER = '[Old tool result content cleared]'
const LEGACY_MC_DIGEST_PREFIX = '[Old tool result · digest:'

// The closed content-class vocabulary. The emitted class is always one of these literals —
// never derived from input bytes — which is what makes the digest provably leak-free.
type ContentClass =
  | 'text'
  | 'file-listing'
  | 'json/structured'
  | 'diff'
  | 'log/stacktrace'
  | 'error'
  | 'log'
  | 'tabular'

type DigestableContent = ToolResultBlockParam['content'] | undefined

/** Default-ON since (graduated under the ladder: tier
 *  `additive` — the digest only replaces the bare placeholder with a SHAPE-ONLY
 *  label (counts + an 8-class content kind), zero-content-leak by construction;
 *  worst case = a mislabeled shape hint on an already-cleared block).
 *  `MERCURY_MC_DIGEST=0` opts out ⇒ the byte-exact placeholder. */
export function isMicroCompactDigestEnabled(): boolean {
  if (flagEnv('MERCURY_MC_DIGEST') === '0') return false
  return true
}

/** A block already replaced by the placeholder or a prior digest label — do not re-digest. */
export function isClearedOrDigested(content: DigestableContent): boolean {
  return (
    typeof content === 'string' &&
    (content === MC_CLEARED_PLACEHOLDER ||
      content === LEGACY_MC_CLEARED_PLACEHOLDER ||
      content.startsWith(MC_DIGEST_PREFIX) ||
      content.startsWith(LEGACY_MC_DIGEST_PREFIX))
  )
}

/** Concatenate only the TEXT items of a tool result; drop image/document items. */
function extractText(content: DigestableContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(item =>
      item && typeof item === 'object' && (item as { type?: string }).type === 'text'
        ? ((item as { text?: string }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

// Per-line structural predicates. Each only TESTS a line (returns a boolean) — it never returns
// or stores any slice of the line, so no content can flow into the digest through them.
const PRED = {
  pathLike: (l: string) => /^[./~]?[\w.@-]+(?:\/[\w.@-]*)+$/.test(l),
  jsonStruct: (l: string) => /^[[{]|[\]}],?$/.test(l) || /"[\w-]+"\s*:/.test(l),
  diffLike: (l: string) => /^(?:[+\-@]|diff --git\b)/.test(l),
  errLike: (l: string) => /\b(?:Error|Exception|Traceback|FAILED?|panic|fatal)\b/i.test(l),
  stackLike: (l: string) =>
    /\bat\s+\S.*\(.*:\d+\)/.test(l) || /File ".*", line \d+/.test(l) || /:\d+:\d+/.test(l),
  tabular: (l: string) => /\t/.test(l) || /\S {2,}\S.* {2,}\S/.test(l),
  logLike: (l: string) =>
    /^\d{4}-\d\d-\d\d[T ]/.test(l) || /^\[\w+\]/.test(l) || /^\d\d:\d\d:\d\d/.test(l),
}

function classify(text: string): ContentClass {
  const nonEmpty = text.split('\n').filter(l => l.trim().length > 0)
  const n = nonEmpty.length
  if (n === 0) return 'text'
  const c = { pathLike: 0, jsonStruct: 0, diffLike: 0, errLike: 0, stackLike: 0, tabular: 0, logLike: 0 }
  let brackets = 0
  for (const raw of nonEmpty) {
    const l = raw.trim()
    if (PRED.pathLike(l)) c.pathLike++
    if (PRED.jsonStruct(l)) c.jsonStruct++
    if (PRED.diffLike(l)) c.diffLike++
    if (PRED.errLike(l)) c.errLike++
    if (PRED.stackLike(l)) c.stackLike++
    if (PRED.tabular(raw)) c.tabular++
    if (PRED.logLike(l)) c.logLike++
  }
  for (const ch of text) if (ch === '{' || ch === '}' || ch === '[' || ch === ']') brackets++
  const r = (x: number) => x / n
  const bracketDensity = text.length > 0 ? brackets / text.length : 0
  // Most specific first.
  if ((r(c.errLike) > 0 && r(c.stackLike) > 0) || r(c.stackLike) >= 0.3) return 'log/stacktrace'
  if (r(c.diffLike) >= 0.4) return 'diff'
  if (r(c.jsonStruct) >= 0.3 || bracketDensity >= 0.08) return 'json/structured'
  if (r(c.pathLike) >= 0.6) return 'file-listing'
  if (r(c.errLike) >= 0.25) return 'error'
  if (r(c.logLike) >= 0.4) return 'log'
  if (r(c.tabular) >= 0.5) return 'tabular'
  return 'text'
}

/**
 * Replacement content for a time-based-MC-cleared tool result. OFF (or empty/no text) ⇒ the
 * byte-exact placeholder; otherwise a structural label like
 * "[Old tool result · digest: 124 lines, ~380 tok, file-listing]" — counts + a class only,
 * never any input bytes.
 */
export function digestClearedToolResult(content: DigestableContent): string {
  if (!isMicroCompactDigestEnabled()) return MC_CLEARED_PLACEHOLDER
  if (isClearedOrDigested(content)) {
    return typeof content === 'string' ? content : MC_CLEARED_PLACEHOLDER
  }
  const text = extractText(content)
  if (!text.trim()) return MC_CLEARED_PLACEHOLDER

  const lineCount = text.split('\n').length
  // Coarse token estimate, rounded to the nearest 10 — a shape hint, not a content fingerprint.
  const approxTokens = Math.round(text.length / 4 / 10) * 10
  const cls = classify(text)
  return `${MC_DIGEST_PREFIX} ${lineCount} lines, ~${approxTokens} tok, ${cls}]`
}
