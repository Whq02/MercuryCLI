// ============================================================================
// the phase-honest spinner byline.
//
//  Pure composition: the authoritative turn phase (usePulsePhase) becomes the
//  spinner's status text — "Preparing context · 0.8s", "Slick · waiting for
//  Fable 5 · high · 3.4s", "Molten · thinking · high · 5.1s", "Running 3
//  tools · 12s", "Settling turn · 0.4s".
//
//  The voice law: on the LONG
//  steady phases — waiting and thinking, where a turn actually lives — the
//  verb chain's voice (task narrator → tool label → the quicksilver whimsy
//  pool) carries the HEAD of the line and the phase truth (phase word ·
//  model · effort · elapsed) rides as meta segments. Nothing honest is lost:
//  every fact stays on the line and sheds right-to-left exactly as
//  before. The brief, genuinely causal phases (preparing reasons, compacting,
//  dispatching, settling, multi-tool counts) keep the whole line — real
//  transition information still outranks decoration there, and dwell already
//  hides the instant ones.
//
//  Laws (proved in scripts/pulse/spinner/):
//  · Model + effort come from the phase detail (the ACTUAL selected model and
//    APPLIED effort of the in-flight call) — never hardcoded here.
//  · Narrow widths shed RIGHT-TO-LEFT (elapsed → effort → model → phase word)
//    so the row stays one line; the floor is the bare head (the verb on
//    waiting/thinking, the phase label elsewhere).
//  · Dwell (~200ms) suppresses instant preparation subphases from the view;
//    transitions stay immediate internally (computeDisplayPhase is the pure
//    view law — this module only owns the consumption wrapper).
// ============================================================================

import { stringWidth } from '../../ink/stringWidth.js'
import {
  computeDisplayPhase,
  type PhaseDetail,
  type TurnPhaseName,
  type TurnPhaseSnapshot,
} from '../../utils/pulse/index.js'

/** View dwell for instant preparation subphases (brief: ~160–250ms). */
export const PHASE_DWELL_MS = 200

/** Head labels (widest-first — a narrower alternative is a shed step) plus
 *  the detail segments that follow, or null when the phase has no byline of
 *  its own (responding / single-tool work → the legacy verb chain). */
function phaseParts(
  phase: TurnPhaseName,
  detail: PhaseDetail,
  activeToolCount: number,
  verb: string | undefined,
): { heads: string[]; extras: string[] } | null {
  switch (phase) {
    case 'accepted':
      return { heads: ['Starting'], extras: [] }
    case 'preparing': {
      const label =
        detail.reason === 'hooks'
          ? 'Checking prompt hooks'
          : detail.reason === 'workspace'
            ? 'Collecting workspace context'
            : detail.reason === 'input'
              ? 'Reading input'
              : detail.reason === 'context'
                ? 'Preparing context'
                : 'Preparing'
      return { heads: [label, 'Preparing'], extras: [] }
    }
    case 'compacting':
      return { heads: ['Compacting context', 'Compacting'], extras: [] }
    case 'dispatching':
      return { heads: ['Sending request', 'Sending'], extras: [] }
    case 'waiting': {
      // The voice law: the verb heads the line; the phase truth follows as
      // meta. No verb (defensive) degrades to the causal-only spelling.
      // The SERVING model outranks the requested one on the line (the
      // opt-in refusal fallback is visible, never a silent substitute).
      const who = detail.servedBy ? `${detail.servedBy} (fallback)` : detail.model
      // THE WAIT'S OWN WORDS head the line while the first byte is
      // outstanding (or a reissue is on its way): what is being waited on
      // and the budget that fires — never a silent "waiting" over a slow
      // uncached ingest. They shed first when the row is narrow.
      const waitHeads = detail.wait ? [verb ? `${verb} · ${detail.wait}` : detail.wait] : []
      if (verb) {
        return {
          heads: who
            ? [...waitHeads, `${verb} · waiting for ${who}`, `${verb} · waiting`, verb]
            : [...waitHeads, `${verb} · waiting`, verb],
          extras: detail.effort ? [detail.effort] : [],
        }
      }
      return {
        heads: who ? [...waitHeads, `Waiting for ${who}`, 'Waiting'] : [...waitHeads, 'Waiting'],
        extras: detail.effort ? [detail.effort] : [],
      }
    }
    case 'thinking': {
      // The serving model rides first among the extras (it sheds last).
      const extras = [
        ...(detail.servedBy ? [`${detail.servedBy} (fallback)`] : []),
        ...(detail.effort ? [detail.effort] : []),
      ]
      if (verb) {
        return { heads: [`${verb} · thinking`, verb], extras }
      }
      return { heads: ['Thinking'], extras }
    }
    case 'tool-work': {
      const n = detail.toolCount ?? activeToolCount
      // Exactly one tool: the specific activeToolLabel verb (already in the
      // legacy message chain) beats a generic count.
      if (n < 2) return null
      return { heads: [`Running ${n} tools`], extras: [] }
    }
    case 'settling':
      return { heads: ['Settling turn', 'Settling'], extras: [] }
    default:
      // responding | idle — the legacy verb chain (task narrator → tool label
      // → whimsy pool) carries the byline.
      return null
  }
}

export type PhaseBylineInput = {
  phase: TurnPhaseName
  detail: PhaseDetail
  /** Leader tool_use blocks in flight (fallback when detail.toolCount absent). */
  activeToolCount: number
  /** Width budget for the whole byline text (the row keeps one line). */
  maxWidth: number
  /** The verb chain's voice (task narrator → tool label → whimsy pool) — heads
   *  the line on the long steady phases (waiting/thinking), the voice law. */
  verb?: string
}

/** The phase byline, shed right-to-left to fit, or null when the legacy verb
 *  chain should drive (responding / single-tool / idle).
 *
 *  W3 (UN-19 — one phrase, ONE clock): the byline carries phase +
 *  identity meta only. The per-phase elapsed tail is ABSENT — the default
 *  strip's single time basis is the whole-turn timer the row already renders
 *  (the HUD order law's `elapsed` slot); a second unlabeled clock inside the
 *  phrase was the D3 defect. Phase DWELL (display timing) still lives here. */
export function composePhaseByline(input: PhaseBylineInput): string | null {
  const parts = phaseParts(input.phase, input.detail, input.activeToolCount, input.verb)
  if (!parts) return null
  for (const head of parts.heads) {
    // Widest composition first, then shed the tail segment by segment:
    // head · extras → head.
    for (let n = parts.extras.length; n >= 0; n--) {
      const candidate = [head, ...parts.extras.slice(0, n)].join(' · ')
      if (stringWidth(candidate) <= input.maxWidth) return candidate
    }
  }
  // Even the narrowest head overflows (absurdly narrow terminal): return it
  // anyway — the row's own wrap governs below the shed floor.
  return parts.heads[parts.heads.length - 1]!
}

// ── W3: thinking postscript truth (UN-19/20) ─────────────────────────
//  "thought for Ns" would otherwise be a SECOND owner — a Spinner-level useState with
//  two chained timeouts beside phase truth, which meant old and new
//  phase labels could overlap and the row carried a private clock. It is now
//  a pure projection of displayed-phase transitions over the ONE pulse clock:
//  the row tracks the last completed thinking span with these laws and no
//  local state machine can drift from the phase owner.

/** How long the completed-thinking postscript lingers (the established 2s). */
export const THINKING_LINGER_MS = 2000

export interface ThinkingSpanTracker {
  phase: TurnPhaseName
  /** When the CURRENT displayed phase was entered (tracker clock). */
  since: number
  /** The last COMPLETED thinking span, newest wins. */
  last: { endedAt: number; durationMs: number } | null
}

export const IDLE_THINKING_TRACKER: ThinkingSpanTracker = {
  phase: 'idle',
  since: 0,
  last: null,
}

/** Advance the tracker on a displayed-phase sample (pure; call per frame). */
export function nextThinkingSpan(
  prev: ThinkingSpanTracker,
  phase: TurnPhaseName,
  now: number,
): ThinkingSpanTracker {
  if (phase === prev.phase) return prev
  if (prev.phase === 'thinking') {
    return {
      phase,
      since: now,
      last: { endedAt: now, durationMs: Math.max(0, now - prev.since) },
    }
  }
  return { phase, since: now, last: prev.last }
}

/** The postscript phrase, or null once the linger elapses. One clock: the
 *  same `now` basis that advanced the tracker. */
export function thinkingPostscript(
  tracker: ThinkingSpanTracker,
  now: number,
): string | null {
  if (tracker.phase === 'thinking') return null
  const last = tracker.last
  if (last === null) return null
  if (now - last.endedAt >= THINKING_LINGER_MS) return null
  return `thought for ${Math.max(1, Math.round(last.durationMs / 1000))}s`
}

/** The view's dwell consumption: generation-aware previous-display tracking
 *  over computeDisplayPhase. Reduced motion shows every phase instantly
 *  (dwell is an animation nicety — state changes stay complete). */
export function nextDisplayedPhase(
  prev: { generation: number; phase: TurnPhaseName },
  snap: TurnPhaseSnapshot,
  now: number,
  reducedMotion: boolean,
): TurnPhaseName {
  if (snap.generation === 0 || snap.phase === 'idle') return 'idle'
  if (reducedMotion) return snap.phase
  const prevPhase = prev.generation === snap.generation ? prev.phase : 'idle'
  return computeDisplayPhase(prevPhase, snap, now, PHASE_DWELL_MS)
}
