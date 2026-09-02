// ============================================================================
//  mercury-ui/glyphs — the geometric glyph vocabulary + cell-width math.
//
//  One source for the glyph set (terminal-conversion-rules.md + brand-glyphs)
//  so every Mercury surface speaks the same shapes, and NO emoji ever (an emoji
//  is a tonal mismatch and mis-measures in a cell grid). Also the display-width
//  helpers — `.length` is wrong for CJK/wide content (branch names, paths,
//  session titles), so column alignment and truncation go through `displayWidth`
//  / `truncateToWidth` / `padTo`.
// ============================================================================

import type { Task } from '../../utils/tasks.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth as rigorousTruncateToWidth } from '../../utils/truncate.js'
import { AMBER, FAINT, SECOND, TEAL } from '../mercuryPalette.js'

// Geometric glyph set. Pull from here instead of hardcoding a literal so a glyph
// change is one edit. (The crab lockup + sigil live in assets.tsx.)
export const GLYPH = {
  // separators / markers
  sep: '│',
  dot: '·',
  branch: '⌥',
  mission: '◆',
  lease: '⌁', // lease / scope (schema --glyph-lease U+2301)
  leaseHeld: '⊟', // lease actively held (schema --glyph-leaseheld U+229F)
  prompt: '❯',
  caretBlock: '▌', // live compose cursor (U+258C left-half block, width-1) — the Helm console's REPL caret
  turns: '⤳',
  conflict: '⨯', // merge/lease conflict mark (U+2A2F, width-1) — seven monitor/team surfaces read it
  fail: '✕', // killed/blocked/errored tool lead (U+2715, unambiguous width-1)
  ok: '●', // succeeded tool/trace mark (U+25CF, width-1) — the filled done-dot, NOT
  //          a geometric check: ✓/✗ are East-Asian-Ambiguous and desync a column.
  warn: '▲', // attention/warn lead (U+25B2, width-1) — the WarningBanner warn tone.
  read: '◌', // file read — non-mutating "scanned/viewed" ring (U+25CC, width-1);
  //            distinct from the filled ● done-dot used for mutating success.
  handoff: '⇄',
  trace: '⟡',
  // The Mercury SPARK family — Mercury's identity event-mark. The sigil's ✶
  // and the spinner's star-bloom already speak this dialect; these tokens make
  // it vocabulary: spark = the ember-settle a landing mutation blooms
  // (BELLY-toned flash before the honest state dot), sparkBright = the glint
  // form (the standing sigil's twinkle beat), sparkFaint = the outline ghost
  // for dim/pending sparkle uses. All width-1 under the canonical model
  // (U+2736 / U+2726 / U+2727 — prove-glyph-width ratchets it).
  spark: '✶',
  sparkBright: '✦',
  sparkFaint: '✧',
  // remote / cloud lane (orchestration-modes.md) — a width-stable geometric
  // marker (U+229B circled-asterisk), NOT the ☁ emoji-default pictograph: ☁/⚠
  // font-render width-2 on macOS Terminal/iTerm2 while charWidth/Ink count them
  // width-1, so they drift a padTo column. Geometric circled glyph ⇒ 1 cell
  // everywhere, matching the spine.
  cloud: '⊛',
  // in-row selection cursor (the ▸ the specimen lists render to the left of the
  // focused row). One token so every navigable view points the same shape.
  cursor: '▸',
  // token spend (the /workflows surfaces' `◈ 45.2k` cost mark) — U+25C8, the
  // ◆/◇ spine's filled-core sibling, width-1 under the canonical model.
  tokens: '◈',
  // task / health spine
  pending: '○',
  inProgress: '◐',
  done: '●',
  idle: '·',
  busy: '◐',
  drifting: '◓',
  // status shapes that ALSO back the honest-state taxonomy — kept literal-for-
  // literal with theme.ts STATE_STYLE so an inline (non-StateBadge) use never
  // diverges from the spine. circledBullet=blocked · fisheye=gated ·
  // diamond=planned · circledDash=excluded · uptri=warn/escalation.
  check: '✓', // approval / verified inline tick (success spine, width-1)
  // peer WRITING activity (a typing peer, an advisory claim.acquire edit) —
  // U+270E lower-right pencil, text-presentation, width-1 under the canonical
  // model. Promoted from four shipped literals (the chip,
  // the crew rail, JoinScreen ×2) so the mark is vocabulary, not folklore.
  typing: '✎',
  circledBullet: '◉', // blocked / single-target fisheye-filled (= STATE_STYLE.blocked)
  fisheye: '⦿', // gated marker (= STATE_STYLE.gated)
  diamond: '◇', // planned / reserved (= STATE_STYLE.planned)
  squareOpen: '□', // queued / waiting its turn (U+25A1, width-1) — the V2 concourse
  // board's queued-row lead (: the frozen
  // reference manifest pins □; the earlier ◇ substitution was a divergence)
  circledDash: '⊝', // excluded / untrusted (= STATE_STYLE.excluded)
  circledSlash: '⊘', // killed / breaker-trip (width-1)
  uptri: '▲', // warn / escalation triangle (the kit's standard warn lead)
  // gauges
  barFull: '█',
  barEmpty: '░',
  // ownership (orchestration-modes.md). ownHybrid is the SQUARED plus (U+229E,
  // the squared-minus ⊟ leaseHeld glyph's sibling) — width-stable in every locale,
  // unlike the EAW-ambiguous ⊕ (U+2295) it replaces (width-2 in CJK locales).
  ownSubstrate: '◆',
  ownUpstream: '·',
  ownHybrid: '⊞',
  // the assist-model picker affordance on the
  // Concourse header (`GPT-5.6 Sol ⌄`) — a width-1 down chevron. ⌄ is also
  // the product's expand cue (the collapsed thinking row's fold, the
  // concourse "+N more lines").
  chevronDown: '⌄',
  // The ⌄ dialect's closed-state mate: a
  // standing two-state disclosure points › when folded and ⌄ when open —
  // never ▸/▾, which would overload the ▸ selection cursor with a second
  // meaning on the same screen (U+203A, width-1).
  chevronRight: '›',
  // The permission-mode SEAL family: the shift+tab
  // carousel's per-station tokens, Mercury's own — the base transport dialect
  // (⏵ play / ⏵⏵ fast-forward / ‖ pause) is retired. One grammar: each station
  // is a single width-1 geometric seal in the math-operator dialect the
  // honest-state taxonomy already speaks; ink density tracks how much runs
  // without asking, and the bypass family reads as a violated/self-held seal,
  // never as "more speed". One symbol source: utils/permissions/
  // PermissionMode.ts MODE_CONFIG reads these — the footer modeBand,
  // TeamsDialog and PermissionDialog all render through those helpers.
  modeDefault: '◦', // standing consent — the quiet open ring (U+25E6). The
  //                   footer paints NO band in default; this mark serves the
  //                   per-teammate rows (and squares their column).
  modeImplement: '±', // Implement Mode — the diff sign (U+00B1): adds/removes
  //                     pre-approved; everything else still asks.
  modeStrategy: '◇', // Strategy Mode — deliberate first: the UNFILLED mission
  //                    diamond; deliberately the `diamond` literal
  //                    (STATE_STYLE.planned): strategy IS the planned posture —
  //                    one shape per meaning.
  modeFlow: '✦', // Flow — the classifier-gated Mercury-native station wears the
  //                identity glint — deliberately the `sparkBright` literal
  //                (the brand mark on the brand mode).
  modeDontAsk: '¬', // negation (U+00AC) — "no asking": allowed work flows
  //                   silently (the SDK/flag posture; off the carousel).
  modeSovereign: '⊠', // Sovereign Mode — the consent frame STRUCK THROUGH
  //                     (U+22A0, the squared family): no dialog will interpose;
  //                     rides the loud failure role in the band.
  modeAutopilot: '⌖', // the targeting reticle (U+2316) — self-steering: sovereign
  //                     posture + self-tier; the loudest station.
  modeScribe: '✎', // the pen — kept: already Mercury vocabulary (the `typing`
  //                  peer-pen dialect), never a generic token.
  modeApollo: '∵', // Apollo Mode — the pre-flight interview station: ∵
  //                  (U+2235 BECAUSE), the seal that asks you WHY — a dotted
  //                  form keeping the deliberative register open. (Keyed by
  //                  the mode id like the rest of the family; the earlier
  //                  reservation note said "modeInterview", but the station's
  //                  id is 'apollo' and one grammar wins.)
  modeManager: '∷', // Manager mode — the COORDINATOR composer's shift+tab
  //                  station (coordinator-tooling ledger T7+T8), not a
  //                  permission mode: ∷ (U+2237 PROPORTION), the dotted
  //                  deliberative register beside Apollo's ∵ — a goal split
  //                  into proportional, non-overlapping parts (the harmony
  //                  law made a seal). Width-1 math-operator dialect.
} as const

// Sparkline ramp (mcp-tool-risk.md) — low→high cells.
export const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

// Task status → glyph + colour (matches the established Deck/FleetMonitor maps).
export const STATUS_GLYPH: Record<Task['status'], { glyph: string; color: string }> = {
  pending: { glyph: GLYPH.pending, color: FAINT },
  in_progress: { glyph: GLYPH.inProgress, color: TEAL },
  completed: { glyph: GLYPH.done, color: TEAL },
}

// Agent health → glyph + colour (FleetMonitor / agent-swarm-states.md).
export const HEALTH_GLYPH: Record<string, { glyph: string; color: string }> = {
  idle: { glyph: GLYPH.idle, color: FAINT },
  busy: { glyph: GLYPH.busy, color: TEAL },
  drifting: { glyph: GLYPH.drifting, color: AMBER },
}

// Ownership layer → glyph + colour: ◆ substrate (Mercury's own
// extension, TERRA-toned via the caller's accent), · upstream (provider-
// standard, FAINT), ⊞ hybrid (both — AMBER). Mirrors STATUS_GLYPH/HEALTH_GLYPH
// so the run-target/ownership labels in the parity views read from one map. TERRA
// is intentionally NOT imported here (substrate takes the session accent at the
// call site); colour is the honest-but-neutral default.
export const OWNERSHIP_GLYPH: Record<'substrate' | 'upstream' | 'hybrid', { glyph: string; color: string; label: string }> = {
  substrate: { glyph: GLYPH.ownSubstrate, color: SECOND, label: 'substrate' },
  upstream: { glyph: GLYPH.ownUpstream, color: FAINT, label: 'upstream' },
  hybrid: { glyph: GLYPH.ownHybrid, color: AMBER, label: 'hybrid' },
}

// --- Cell-width math (CJK/wide-aware) --------------------------------------
//
// These DELEGATE to the codebase's canonical, rigorous width primitives rather
// than carry a parallel system (the old hand-rolled charWidth/truncate desynced:
// no ANSI strip, no combining/ZWJ/variation-selector zeroing, no grapheme
// clustering, an off-by-one ellipsis budget, and a padTo that under-filled after
// truncation). `stringWidth` (ink/stringWidth) and `truncateToWidth`
// (utils/truncate) are grapheme-safe + ambiguous-as-narrow, matching Ink's own
// cursor model, so a kit grid measures EXACTLY what the renderer lays out.
//
// many vocab glyphs above (● ○ ◐ ◆ ◉ │ ✓
// ▲ …) are East-Asian-Ambiguous, so in a CJK ambiguous=WIDE *terminal locale*
// they paint 2 cells while this model counts 1. We deliberately do NOT widen
// charWidth for those ranges: Ink's renderer/cursor (output.ts) uses this SAME
// stringWidth, so widening would make our padding disagree with the renderer in
// the common (non-CJK) case — a real regression — while the CJK-locale residual
// is an Ink + ambiguous-width limitation that already misaligns Ink's ENTIRE
// output (borders, prose) in that locale, not a kit-glyph bug. The vocab is
// instead held to width-1 under the canonical model by a ratchet:
// scripts/ui/prove-glyph-width.ts goes RED if a genuinely-wide glyph (CJK char,
// emoji, width-2 dingbat) ever drifts into GLYPH/SPARK — the actual desync risk.

export function charWidth(ch: string): number {
  return stringWidth(ch)
}

export function displayWidth(s: string): number {
  return stringWidth(s)
}

// Truncate to a display width, appending an ellipsis if clipped. Delegates to the
// rigorous grapheme-safe truncator (reserves the ellipsis budget by display width).
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return ''
  return rigorousTruncateToWidth(s, max)
}

// Pad (or truncate) to a fixed display width so columns align as a grid. Re-measures
// the (possibly truncated) string with displayWidth before padding so the result is
// never under-filled on wide/emoji content (the old padTo re-used the pre-truncation
// width and drifted columns).
export function padTo(s: string, w: number): string {
  if (displayWidth(s) > w) s = truncateToWidth(s, w)
  const width = displayWidth(s)
  if (width >= w) return s
  return s + ' '.repeat(w - width)
}

/** padTo's right-aligned twin: a value column under a
 *  right-aligned header must fill from the LEFT — trailing fill left the
 *  AGE values floating short of their own header. */
export function padStartTo(s: string, w: number): string {
  if (displayWidth(s) > w) s = truncateToWidth(s, w)
  const width = displayWidth(s)
  if (width >= w) return s
  return ' '.repeat(w - width) + s
}
