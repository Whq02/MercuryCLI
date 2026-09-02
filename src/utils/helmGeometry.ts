// Helm cockpit geometry — ONE home for the dimensions so the frame width gate, the
// rail widths, the center-column override, the modal sizing, and MercuryFrame's
// vital-shed all read the SAME numbers and cannot drift. (The A2.2 audit flagged
// divergence between FullscreenLayout's modal width and HelmHome's centerCols.)

/** Below this terminal width the cockpit collapses to the deck-strip home. */
export const HELM_HOME_MIN_COLS = 100

/** Width of each side rail (lanes left, telemetry right) in the cockpit. */
export const HELM_RAIL_W = 24

/** CENTER-FIRST invariant: the transcript
 *  center column never drops below this — a cockpit that renders the chat
 *  narrower than a bare 80-col terminal is worse than no cockpit. Rails shed
 *  in tiers to honor it (see railPlan). */
export const HELM_CENTER_FLOOR = 78

/** The slim single-rail width used at the tightest cockpit tier (100–103
 *  cols), where even one 24-col rail would break the center floor. */
export const HELM_RAIL_SLIM = 20

/** The rail ceiling in the WIDE both-rails zone (cockpit-panel
 *  pass): past 150 cols the rails grow 24→30 so the bordered section panels
 *  get breathing room (the mockup's ~30-col rails), while the center stays
 *  pinned at its both-rails entry width (100) until both rails cap. */
export const HELM_RAIL_WIDE = 30

export type RailPlan = {
  lanes: boolean
  telemetry: boolean
  /** The WIDER of the two rails (kept for callers that need one number). */
  railW: number
  /** Per-side widths — the wide-tier growth hands the odd column to the
   *  LANES side so the center never wobbles (see railPlan). Equal to railW
   *  outside the wide zone. */
  lanesW: number
  telemetryW: number
  centerCols: number
}

/**
 * The rail-shedding plan for a cockpit terminal width — ONE decision (pure
 * geometry behind one hysteresis latch) that both FullscreenLayout (what
 * mounts) and the focus cycle (what Tab reaches) read, so they can never
 * disagree:
 *   · both rails   ENGAGE at ≥ HELM_BOTH_RAILS_MIN (150 — operator-ratified)
 *                  and HOLD down to HELM_BOTH_RAILS_RELEASE (144) so a
 *                  1-col wobble across 149↔150 can't thrash the telemetry
 *                  rail
 *   · lanes only   when one 24-col rail keeps the floor (104–149 disengaged);
 *                  the rail absorbs the key telemetry rows (merged glance)
 *   · slim lanes   at 100–103 (20-col rail keeps center ≥ 78)
 *  (<100 cols never reaches here — computeChromeMode gates cockpit off.)
 */
/** Both rails return at this width (operator-ratified preview: "VERY WIDE
 *  (150+): both sidebars return") — at 150 the both-rails center is 100, so
 *  the tier flip never lands the transcript anywhere near the floor. */
export const HELM_BOTH_RAILS_MIN = 150

/** HYSTERESIS release: once the second rail has
 *  engaged (≥150), it stays until the width drops BELOW this. A window dragged
 *  across the 149↔150 boundary would otherwise flip the telemetry rail (and a 23-col
 *  center rewrap) on every 1-col wobble; with the latch the engaged band
 *  144–149 keeps both rails (center 94–99, still ≥ the 78 floor and
 *  continuous into the ≥150 pin at 100). One engage, one release. */
export const HELM_BOTH_RAILS_RELEASE = 144

/** The ONE stateful latch (module store — the same pattern as helmFocus).
 *  railPlan() is the live entry every layout/focus consumer reads, so a
 *  single owner updates the latch and everyone sees the same tier. */
let bothRailsEngaged = false

/** Test/proof seam: put the tier latch back to its boot state. */
export function resetRailTier(): void {
  bothRailsEngaged = false
}

/** The LIVE rail plan: pure geometry (railPlanAt) behind the one hysteresis
 *  latch. Deterministic within a frame — every caller passes the same live
 *  columns, and re-evaluating the latch with the same width is idempotent. */
export function railPlan(columns: number): RailPlan {
  bothRailsEngaged = bothRailsEngaged
    ? columns >= HELM_BOTH_RAILS_RELEASE
    : columns >= HELM_BOTH_RAILS_MIN
  return railPlanAt(columns, bothRailsEngaged)
}

/** PURE rail-shedding geometry at an explicit tier state (proofs sweep this
 *  in both states; the latched railPlan above is the live entry). */
export function railPlanAt(columns: number, bothEngaged: boolean): RailPlan {
  const both = columns - 2 * HELM_RAIL_W - 2
  if (bothEngaged && both >= HELM_CENTER_FLOOR) {
    // WIDE zone: the rails absorb width past 150 first — growing
    // 24→30 each while the center holds its both-rails entry width (100) —
    // then the center rises once both cap at HELM_RAIL_WIDE. The rail total
    // is split lanes-first (lanes gets the odd column) so the CENTER width is
    // an exact monotone function of columns: no 1-col resize ever shrinks the
    // transcript (the ratified invariant, now proven across the wide zone too).
    const centerPin = HELM_BOTH_RAILS_MIN - 2 - 2 * HELM_RAIL_W // 100
    const railTotal = Math.max(
      2 * HELM_RAIL_W,
      Math.min(2 * HELM_RAIL_WIDE, columns - 2 - centerPin),
    )
    const lanesW = Math.ceil(railTotal / 2)
    const telemetryW = railTotal - lanesW
    return {
      lanes: true,
      telemetry: true,
      railW: lanesW,
      lanesW,
      telemetryW,
      centerCols: columns - 2 - railTotal,
    }
  }
  // Single-rail zone: the rail GROWS continuously from slim (20) to full (24)
  // while the center stays pinned at the floor, then the center rises — no
  // 1-col tier flip can ever shrink the transcript (within-tier monotonicity,
  // proved). railW = width − gutter − center, clamped to [slim, full].
  const railW = Math.max(
    HELM_RAIL_SLIM,
    Math.min(HELM_RAIL_W, columns - 2 - HELM_CENTER_FLOOR),
  )
  return {
    lanes: true,
    telemetry: false,
    railW,
    lanesW: railW,
    telemetryW: railW,
    centerCols: Math.max(20, columns - 2 - railW),
  }
}

/**
 * The usable width of the cockpit's center column at a given terminal width —
 * now the railPlan's centerCols (center-first invariant), still floored so a
 * pathological width never yields a negative/zero column. The transcript (via
 * a TerminalSizeContext override) and the modal slot both size to this.
 */
export function helmCenterCols(columns: number): number {
  return railPlan(columns).centerCols
}
