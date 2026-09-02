// ============================================================================
//  mercuryPalette — the Mercury brand palette (the OASIS identity).
//  Single source of truth for Mercury's chrome: the crab-red accent (TERRA)
//  + warm-ivory ink on the deep teal-navy OASIS ground (the
//  retint moved the whole neutral/surface family from warm sand to the cool
//  oasis ramp; token NAMES kept — values cascade through imports, the TERRA
//  retint precedent). The original "warm-ink"
//  pass lives on here;
//  the mascot's live home is mercury-ui/CritterArt.tsx. Both the
//  persistent statusbar (MercuryFrame) and the /deck snapshot (Deck) import
//  these tokens instead of redeclaring the hex — promote-to-shared, no
//  duplicated literals. This is a named brand palette layered over the
//  semantic getTheme() system (which keys on UI roles, not brand hues), not a
//  replacement for it.
// ============================================================================

/** Brand accent / crab shell — CUTE-CRAB RED, the Mercury identity hue
 *  (the design schema's `--terra`; distinct from CRIMSON). The crab critter's
 *  identity hue and the per-session accent base.
 *  #DD4444 (not a terracotta) keeps the crab theme distinct
 *  from the familiar harness orange (the token NAME stays `TERRA` — every consumer
 *  imports the token, so a retint cascades with no call-site changes). */
export const TERRA = '#DD4444'
/** Primary ink — warm ivory. */
export const IVORY = '#EDE8DD'
/** Secondary meta text — cool sage (OASIS retint: the operator's
 *  mockups moved the whole neutral family from warm sand to the oasis
 *  cool-sage/teal-navy ramp; token names stay, values cascade — the TERRA
 *  retint precedent). */
export const SECOND = '#A9B4AC'
/** Tertiary text / separators — cool (oasis). */
export const FAINT = '#71807B'
/** Gauge ok / clean / in-progress — teal. */
export const TEAL = '#3FBFA0'
/** Gauge warn (>=80%) / dirty-tree — amber. */
export const AMBER = '#DBA13D'
/** Gauge block (>=95%) — crimson. */
export const CRIMSON = '#E8556A'
/** Crab claws / legs — deep claw (the crab red in shadow; retinted with TERRA). */
export const CLAW = '#7B3232'
/** Oasis blue — the crab's pupil / the one rare cool accent (sigil center). */
export const OASIS = '#3F7E96'
/** Belly-band highlight on the crab / sigil sparkle (the crab red toward ivory). */
export const BELLY = '#E58484'
/** Panel border / selection wash — oasis slate (was warm dune brown). */
export const DUNE = '#2F4B52'
/** Alias for SECOND — the design system's "sand" name for muted text. */
export const SAND = SECOND

// --- depth / surface tokens (the night-canvas → ash-panel → ash-raised ladder).
// Borders + ink already exist
// above; these add the *surface* layer (panel/well/zebra fills).
// OASIS RETINT: the whole ladder moved from warm near-black to the
// deep teal-navy "oasis" ground (operator mockups); same hue family (~192°),
// stepping lightness — keep any new step inside it.
/** Deep terminal background — the oasis ground (colors.css --night). */
export const NIGHT = '#0D181B'
/** A half-step up from night, vignette / inset (colors.css --night-soft). */
export const NIGHT_SOFT = '#101D21'
/** Muted secondary surface — panels, wells (colors.css --ash). */
export const ASH = '#142327'
/** A raised ash cell — table zebra, hover (colors.css --ash-raised). */
export const ASH_RAISED = '#1A2C31'
/** Hairline divider, faint inset border (colors.css --dune-faint). */
export const DUNE_FAINT = '#233A40'

/** Semantic alias — the default panel/well surface fill (colors.css --surface-panel = ash). */
export const SURFACE_PANEL = ASH

// --- diff row/word background tints (the brand spine for added/removed code).
// These mirror EXACTLY the native color-diff (RawAnsi) stamp branch in
// native-ts/color-diff/index.ts (addLine/addWord/deleteLine/deleteWord) so the
// StructuredDiff word-level FALLBACK renders the same warm teal/crimson spine as
// the primary path instead of leaking stock Ink green/red. TEAL-derived
// for adds, CRIMSON-derived for removes; dark enough to sit on the NIGHT canvas
// under IVORY text. Keep in sync with color-diff/index.ts if either is retuned.
/** Added-line row background — dark teal (≙ color-diff addLine rgb(8,38,32)). */
export const DIFF_ADD_BG = '#082620'
/** Added-word highlight background — deeper teal (≙ color-diff addWord rgb(14,64,54)). */
export const DIFF_ADD_WORD = '#0E4036'
/** Removed-line row background — dark crimson (≙ color-diff deleteLine rgb(48,16,20)). */
export const DIFF_DEL_BG = '#301014'
/** Removed-word highlight background — deeper crimson (≙ color-diff deleteWord rgb(80,26,32)). */
export const DIFF_DEL_WORD = '#501A20'
/** Semantic alias — a raised cell surface fill (colors.css --surface-raised = ash-raised). */
export const SURFACE_RAISED = ASH_RAISED

// --- the GROUND FAMILIES (the two appearances' resting grounds).
// The appearance system carries exactly two grounds: the oasis ladder above
// (the `dark` identity) and the TRUE BLACK ladder — the same hue family and
// step order re-anchored on the pure-black terminal ground (#000000), each
// step sitting below its oasis counterpart. Text, accents and the status
// spine belong to the palette above and never swap with the ground; every
// ground-following surface resolves through groundFamilyFor(themeName) —
// one owner, never a per-site ladder.
export type GroundFamily = {
  /** Deep terminal background (the OSC 11 ground). */
  NIGHT: string
  /** A half-step up — vignette / inset / bash well. */
  NIGHT_SOFT: string
  /** Muted secondary surface — panels, wells. */
  ASH: string
  /** A raised cell — table zebra, message plates. */
  ASH_RAISED: string
  /** Hover / hairline-adjacent fill step. */
  DUNE_FAINT: string
  /** The ladder's top fill — action plates. */
  DUNE: string
}

/** The oasis ground family — the `dark` appearance's resting grounds. */
export const OASIS_GROUND: GroundFamily = {
  NIGHT,
  NIGHT_SOFT,
  ASH,
  ASH_RAISED,
  DUNE_FAINT,
  DUNE,
}

/** The true-black ground family — the `true-black` appearance: the oasis
 *  steps at ~0.55 of their channel values on the exact #000000 anchor. */
export const TRUE_BLACK_GROUND: GroundFamily = {
  NIGHT: '#000000',
  NIGHT_SOFT: '#080F11',
  ASH: '#0B1315',
  ASH_RAISED: '#0E181B',
  DUNE_FAINT: '#132023',
  DUNE: '#1A292D',
}

/** The ground family a concrete theme name rests on. Every non-true-black
 *  name (the dark identity, the dormant families, unknown names) keeps the
 *  oasis ladder — true-black is the ONE black-anchored appearance. */
export function groundFamilyFor(themeName: string): GroundFamily {
  return themeName === 'true-black' ? TRUE_BLACK_GROUND : OASIS_GROUND
}

/** The full palette as one object, for callers that prefer a namespace. */
export const mercuryPalette = {
  TERRA,
  IVORY,
  SECOND,
  FAINT,
  TEAL,
  AMBER,
  CRIMSON,
  CLAW,
  OASIS,
  BELLY,
  DUNE,
  SAND,
  NIGHT,
  NIGHT_SOFT,
  ASH,
  ASH_RAISED,
  DUNE_FAINT,
  SURFACE_PANEL,
  SURFACE_RAISED,
} as const

export type MercuryPalette = typeof mercuryPalette
