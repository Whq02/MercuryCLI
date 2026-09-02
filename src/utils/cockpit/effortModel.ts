// ============================================================================
//  utils/cockpit/effortModel — the honest effort/supercode taxonomy + the
//  bridged-runtime support matrix.
//
//  This is the single PURE source of truth (no React, no Ink, no I/O — numbers
//  and strings in, strings out; never throws) for the THREE effort facts,
//  reconciled with what THIS runtime actually supports:
//
//    1. `xhigh` is a REAL effort LEVEL (the effort axis: low/medium/high/xhigh/max),
//       model-dependent — NOT an alias of `max`. (The spawn axis
//       SPAWN_EFFORT_LEVELS in effortSpawnPayload.ts.)
//
//    2. `supercode` is a MODE, NOT an effort level: it is max + automatic
//       dynamic-workflow orchestration, session-only, and MUTUALLY EXCLUSIVE
//       with a co-set effort level (the mode owns the pin at MAX —
//       "deepest available"). The ONLY programmatic
//       supercode paths are `Options.settings:{supercode:true}` at spawn /
//       `applyFlagSettings({supercode:true})` live — NEVER `--effort
//       supercode`, `effortLevel:'supercode'`, or a persisted settings key.
//
//    3. What THIS fork's runtime actually exposes (verified against the source —
//       utils/effort.ts, settings/types.ts, state/AppStateStore.ts):
//         · runtime EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max' — xhigh IS
//           a live level (effort.ts EFFORT_LEVELS), model-gated
//           (modelSupportsXHighEffort); a model whose vocabulary lacks a level
//           runs the NEAREST SUPPORTED tier at dispatch (resolveEffortTruth —
// and the controls offer only selectable stops.
//         · `max` is model-gated (modelSupportsMaxEffort); elsewhere it stands
//           as INTENT and the model runs its deepest supported tier;
//           session-only for non-ants.
//         · `supercode` is a LIVE session MODE (AppState.supercode): `/effort
//           supercode` flips it (pins max) and drives the standing ultra_effort
//           system-reminder. Mercury-only; requires a max-capable model.
//       So xhigh and supercode are BOTH live-applicable in Mercury (model-gated),
//       not runtime-gated.
//
//  The honesty contract: this module presents xhigh as a live level and supercode
//  as a live mode (model-gated), and never fabricates a capability the model lacks
//  — the per-model clamp / refuse is stated in each note.
// ============================================================================

// The effort CONTROL axis — the full set, in escalation order. `xhigh` is a
// first-class peer BETWEEN high and max (low/medium/high/xhigh/max).
// `supercode` is deliberately NOT here — it is a mode, not a level.
export const EFFORT_AXIS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortAxisLevel = (typeof EFFORT_AXIS)[number]

// Where a control can actually take effect.
//   · 'live'   — the in-process REPL can apply it this session (AppState.effortValue).
//   · 'spawn'  — applicable only at spawn of a Mercury-spawned bridge session
//                (Options.effort / Options.settings) — not the live REPL.
//   · 'gated'  — the bridged runtime exposes no path for it in this surface.
export type EffortReach = 'live' | 'spawn' | 'gated'

export type EffortLevelInfo = {
  level: EffortAxisLevel
  /** How far the level reaches on THIS runtime. */
  reach: EffortReach
  /** One honest line: what it does and/or why it is limited. Never fabricates. */
  note: string
}

/**
 * Describe an effort LEVEL against the live runtime + the chosen model.
 *
 *   - low/medium/high  → live (the runtime EffortLevel; the live /effort path).
 *   - xhigh            → live, model-gated (modelSupportsXHighEffort); a model
 *                        whose vocabulary lacks it runs the nearest supported
 *                        tier at dispatch — the controls state it.
 *   - max              → live ONLY when the model supports it; otherwise it is
 *                        accepted as standing INTENT (persists across model
 *                        switches) and the model runs its deepest supported
 *                        tier — never a silent relabel.
 *
 * `modelSupportsMax` is injected (not read here) so this stays pure — pass
 * `modelSupportsMaxEffort(model)` from utils/effort.ts at the call site.
 */
export function describeEffortLevel(
  level: EffortAxisLevel,
  modelSupportsMax: boolean,
): EffortLevelInfo {
  switch (level) {
    case 'low':
      return { level, reach: 'live', note: 'quick, minimal-overhead reasoning' }
    case 'medium':
      return { level, reach: 'live', note: 'balanced reasoning — the common default' }
    case 'high':
      return { level, reach: 'live', note: 'comprehensive reasoning (the API default when none is sent)' }
    case 'xhigh':
      return {
        level,
        reach: 'live',
        note: 'extra-high reasoning — model-gated; a model whose vocabulary lacks it runs the nearest supported tier at dispatch',
      }
    case 'max':
      return modelSupportsMax
        ? { level, reach: 'live', note: 'maximum reasoning — supported on this model; session-only' }
        : {
            level,
            reach: 'live',
            note: 'accepted as standing intent — this model runs its deepest supported tier (the control states the applied value)',
          }
  }
}

// ── Supercode (the MODE) ──────────────────────────────────────────────────

/**
 * The honest, runtime-checked description of the SUPERCODE MODE for a surface.
 *
 *   pinsEffort  — always 'max' (Mercury's deliberate divergence, operator
 * the bridged runtime pairs the mode with xhigh; Mercury's
 *                 mode means "deepest available" and pins max).
 *   excludes    — the controls supercode is mutually exclusive with (any
 *                 co-set effort level — the mode owns the pin).
 *   reach       — currently 'gated' (the bridged runtime exposes no supercode Options/
 *                 Settings field; the live REPL cannot toggle it). It is real on
 *                 a Mercury-spawned bridge session (Options.settings.supercode).
 *   workflows   — 'auto': under the Agent SDK supercode workflows auto-launch (no
 *                 interactive gate) — surfaced honestly, never as "operator-approved".
 */
export type SupercodeModeInfo = {
  pinsEffort: 'max'
  excludes: readonly string[]
  reach: EffortReach
  workflows: 'auto'
  /** The exact, non-misleading one-liner for the mode header. */
  summary: string
  /** Why it is gated on this runtime (empty when not gated). */
  gatedReason: string
}

export function describeSupercodeMode(): SupercodeModeInfo {
  // Mercury wires supercode as a LIVE session mode: `/effort supercode` flips
  // AppState.supercode (pins max — the operator's divergence from
  // the default's xhigh pair) and drives the standing ultra_effort system-reminder.
  // It is live whenever the model supports max (Opus 4.5+, Sonnet 4.6, Fable);
  // on a non-max model the command refuses with a switch hint. So the honest
  // reach is 'live' (gated by model capability, not by the runtime).
  return {
    pinsEffort: 'max',
    excludes: ['a co-set effort level'],
    reach: 'live',
    workflows: 'auto',
    summary: 'max reasoning + standing dynamic-orchestration · session-only · the mode owns the effort pin',
    gatedReason: '',
  }
}
