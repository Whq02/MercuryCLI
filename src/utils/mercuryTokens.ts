// ============================================================================
//  MercuryThemeTokens — the ADAPTIVE semantic token layer.
//
//  Mercury's identity is the OASIS dark expression (mercuryPalette brand hues),
//  but the brand palette is a DARK palette — importing IVORY/NIGHT ink
//  directly into a component makes light and reduced-color modes feel like
//  leftovers. This resolver gives every theme family a DELIBERATE Mercury
//  expression through one semantic shape:
//    · dark            → the oasis brand mapping (byte-equal to mercuryPalette)
//    · light/daltonized/ansi → mapped from that family's OWN semantic palette
//      (the accessibility palettes stay authoritative; brand hues survive only
//      where they stay legible — the accent)
//  Reduced-color terminals quantize through chalk downstream; meaning must
//  never ride color alone (glyph/label/border carry state too — the render
//  floor rule). Raw brand hues remain in mercuryPalette for logo/art use; new
//  contrast-sensitive chrome consumes THESE roles instead.
//
//  Pure resolver (memoized per family+accent) + a React hook in
//  components/mercury-ui/useMercuryTokens.ts for live surfaces.
// ============================================================================

import { truecolorActive } from '../ink/colorize.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  AMBER,
  BELLY,
  CRIMSON,
  DIFF_ADD_BG,
  DIFF_ADD_WORD,
  DIFF_DEL_BG,
  DIFF_DEL_WORD,
  DUNE,
  DUNE_FAINT,
  FAINT,
  groundFamilyFor,
  IVORY,
  NIGHT,
  OASIS,
  SECOND,
  TEAL,
  TERRA,
} from '../components/mercuryPalette.js'
import { getTheme, type Theme, type ThemeName } from './theme.js'

/** Parse `#rrggbb` or `rgb(r,g,b)` into channels; null for named/ansi colors. */
function parseColor(c: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim())
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)]
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c.trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/**
 * ACCENT BLOOM: a lighter tone genuinely DERIVED from the
 * live accent toward the family's primary ink — hover/landing/acknowledgement
 * emphasis that follows the critter. Pre- the dark family hardcoded the
 * crab's authored coral (BELLY), so an octopus/jellyfish/clam session wore a
 * crab-pink bloom. The crab keeps BELLY byte-equal (the authored form ≈ this
 * derivation); every other accent blooms from its OWN hue. 16-color inks
 * (ansi:*) can't host a derived tone — the bloom collapses onto the accent.
 */
export function deriveAccentSoft(accent: string, primaryInk: string): string {
  const a = parseColor(accent)
  const ink = parseColor(primaryInk)
  if (!a || !ink) return accent
  const mix = (x: number, y: number): string =>
    Math.round(x + (y - x) * 0.4)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(a[0], ink[0])}${mix(a[1], ink[1])}${mix(a[2], ink[2])}`
}

/**
 * FOCAL RAMP: the identity ramp a focal moment walks from the
 * live accent toward the family's primary ink — accent → the family's
 * accentSoft bloom → a deeper 0.7 walk toward
 * the ink. Reserved for identity moments — the wordmark family + the splash's
 * selected launcher row, and the MAIN HEADERS
 * (the ProductLockup title run; the concourse lockup) + the concourse header
 * critter's bloom glow — never status hues, never body text; the closed set
 * is censused by scripts/visual-contract/prove-focal-ramp.ts. Families that can't
 * host a derived tone (light / daltonized / ansi — and any unparseable
 * accent) resolve to the plain accent so the treatment collapses FLAT, never
 * to a wrong hue; NO_COLOR strips color downstream.
 */
export function deriveFocalRamp(
  accent: string,
  accentSoft: string,
  primaryInk: string,
): string[] {
  const a = parseColor(accent)
  const ink = parseColor(primaryInk)
  if (!a || !ink) return [accent]
  const walk = (x: number, y: number): string =>
    Math.round(x + (y - x) * 0.7)
      .toString(16)
      .padStart(2, '0')
  return [accent, accentSoft, `#${walk(a[0], ink[0])}${walk(a[1], ink[1])}${walk(a[2], ink[2])}`]
}

/** WCAG relative luminance of one sRGB channel byte. */
function chan(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG contrast ratio between two parseable colors; null when either is a
 *  named/ansi color the math can't reach. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return null
  const la = 0.2126 * chan(ca[0]) + 0.7152 * chan(ca[1]) + 0.0722 * chan(ca[2])
  const lb = 0.2126 * chan(cb[0]) + 0.7152 * chan(cb[1]) + 0.0722 * chan(cb[2])
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * THE SELECTION BAND: the ACTIVE-cursor row's
 * full-width background — the accent genuinely claiming the row, derived
 * (never authored) so every critter/theme family keeps its own hue. The band
 * mixes the live accent toward the family's ground and walks FURTHER toward
 * the ground until the CONTRAST FLOORS hold — resolved HERE, centrally, so
 * no consumer ever does local legibility math:
 *   · muted ink   ≥ 3.0 (metadata on the selected row stays readable)
 *   · primary ink ≥ 6.0 (the row's main text stays crisp)
 * Same monotone walk on dark and light grounds (toward-ground is always
 * toward the inks' natural contrast base). Unparseable inputs (16-color
 * ansi families) return null — the caller collapses onto the family's own
 * selectionBg (one compatible strong fill; a derivation can't exist there).
 */
export function deriveSelectionBand(
  accent: string,
  ground: string,
  primaryInk: string,
  mutedInk: string,
): string | null {
  const a = parseColor(accent)
  const g = parseColor(ground)
  if (!a || !g || !parseColor(primaryInk) || !parseColor(mutedInk)) return null
  const mixAt = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(a[0], g[0])}${m(a[1], g[1])}${m(a[2], g[2])}`
  }
  // Walk toward the ground until the floors hold. Near-ink-luminance accents
  // (the clam/jellyfish tones — verify-wave refutation) only
  // satisfy the muted floor deep in the walk, so the range runs to 0.95; and
  // because contrast is monotone toward the ground base, the deepest
  // candidate is the BEST available when no step passes — the fallback is
  // the maximum-contrast point in range, never an unchecked mid-walk value.
  let band = mixAt(0.95)
  for (let t = 0.55; t <= 0.96; t += 0.05) {
    const candidate = mixAt(t)
    const muted = contrastRatio(candidate, mutedInk)
    const primary = contrastRatio(candidate, primaryInk)
    if (muted !== null && primary !== null && muted >= 3.0 && primary >= 6.0) {
      band = candidate
      break
    }
  }
  return band
}

/**
 * TEXT-GRADE FLOOR WALK: walk `ink`
 * toward the family's primary ink until it clears the WCAG 4.5:1 text floor
 * against the family's DEEPEST painted ground — for the dark brand family
 * that is the spectral field's bottom row sample (spectraGround.bottom), the
 * lightest ground any instruction/info run can sit on. Gradient phase 1
 * (depth 0.25) pushed the raw role hues under the floor exactly there
 * (FAINT 3.25:1, OASIS 2.97:1, CRIMSON 3.80:1 at the bottom rows), so the
 * text-grade variants are DERIVED centrally — consumers never do local
 * legibility math, and a ground retune re-floors every derived ink for
 * free. Monotone toward the ink base, so the first passing step is the
 * QUIETEST legible tone; unreachable floors (or unparseable inputs)
 * resolve to the primary ink itself — legible, never a wrong hue.
 */
export function deriveTextFloorInk(
  ink: string,
  primaryInk: string,
  ground: string,
  floor: number = 4.5,
): string {
  const a = parseColor(ink)
  const p = parseColor(primaryInk)
  if (!a || !p || !parseColor(ground)) return primaryInk
  const mixAt = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(a[0], p[0])}${m(a[1], p[1])}${m(a[2], p[2])}`
  }
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const candidate = mixAt(t)
    const ratio = contrastRatio(candidate, ground)
    if (ratio !== null && ratio >= floor) return candidate
  }
  return primaryInk
}

/** Discrete stops in a bounded spectral ramp. Five, deliberately: three IS the
 *  flat-band rule this amends, and
 *  a web gradient's continuum has no meaning on a cell grid. Five stops read as
 *  depth while every stop stays a nameable, receiptable color. */
export const SPECTRAL_STOPS = 5

/** The floor a STATE ramp's quiet end must clear against its own ground — the
 *  WCAG graphical-object ratio. State must be seen. */
export const SPECTRAL_STATE_FLOOR = 3.0

/** The floor a STRUCTURE ramp clears. Chrome is not a graphical object
 *  conveying state — a panel edge that met the 3.0 state floor would shout,
 *  and Dune's whole job is to recede. Honestly: WCAG names no structure
 *  ratio, so this is a DESIGN floor, not a perceptual standard. It sits on
 *  a wide plateau (the shipped ramps survive anywhere in ~1.2–1.5; dune —
 *  which measures 1.844 against its own ground — collapses to a single
 *  stop only past ~2.0), chosen at the plateau's top so structure keeps
 *  the most edge resolution that never forces a collapse. The prover pins
 *  the shipped value; moving it is a deliberate re-decision, not a tune. */
export const SPECTRAL_STRUCTURE_FLOOR = 1.5

/** Quiet → full. Length 1 means the family cannot host depth (a 16-color or
 *  no-color profile): consumers fall back to their flat rendering, and the
 *  meaning they carry structurally — glyph, label, position — is unchanged.
 *  Colour is never the sole carrier of state, so a collapsed ramp loses
 *  decoration, never information. */
export type SpectralRamp = readonly string[]

/**
 * A bounded spectral ramp from a family's ground toward a role hue.
 *
 * The contract every stop honours: **legible against its own ground**. The
 * quiet end is not "ground plus a whisper" — it is the shallowest mix that
 * still clears the 3.0 graphical-object floor, found by a monotone walk, so a
 * ramp can never fade into an unreadable smear on light, dark or daltonized
 * families alike. When no mix clears the floor the ramp collapses to the role
 * hue itself: one flat stop, honestly declared, rather than five illegible
 * ones.
 *
 * Pure and static — a ramp is computed once and painted once. Spectral depth
 * causes no continued terminal writes.
 */
/** Pure channel mix for the spectral-ground endpoints (t toward `to`). */
export function spectraMix(from: string, to: string, t: number): string {
  const a = parseColor(from)
  const b = parseColor(to)
  if (!a || !b) return from
  const m = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${m(a[0], b[0])}${m(a[1], b[1])}${m(a[2], b[2])}`
}

/**
 * THE ESTATE GROUND: every
 * fullscreen composition PAINTS its viewport instead of leaning on the
 * terminal profile — the flat NIGHT canvas (the CONSTANT the splash names
 * VOID — since round 7 the launcher's OSC-11 ground is this same NIGHT, so
 * the kinship is value-exact). Since round 7 this flat canvas
 * is the ONE painted ground: the Concourse's graded field over it is
 * retired (a painted field and the OSC-11 ground are two channels that can
 * drift apart — the retired vignette's band was exactly that drift, our
 * own #070D12 edge under the runtime's NIGHT re-assert). Gates: the
 * dark token family only (light/daltonized/ansi keep the stock terminal
 * ground — the warm-ink accessibility precedent), truecolor only (reduced
 * depth stays honest), and the MERCURY_SPECTRA_GROUND=0 opt-out — one
 * flag, one ground law. Inline (scrollback) rendering never paints this:
 * it is a fullscreen-composition concept.
 */
export function estateGroundBg(t: MercuryThemeTokens): string | undefined {
  return t.spectraGround !== undefined && truecolorActive() && flagEnv('MERCURY_SPECTRA_GROUND') !== '0'
    ? t.canvas
    : undefined
}

export function spectralRamp(
  role: string,
  ground: string,
  stops: number = SPECTRAL_STOPS,
  floor: number = SPECTRAL_STATE_FLOOR,
): SpectralRamp {
  const r = parseColor(role)
  const g = parseColor(ground)
  if (!r || !g || stops < 2) return [role]
  const at = (t: number): string => {
    const m = (x: number, y: number): string =>
      Math.round(x + (y - x) * t)
        .toString(16)
        .padStart(2, '0')
    return `#${m(g[0], r[0])}${m(g[1], r[1])}${m(g[2], r[2])}`
  }
  let tMin = 1
  for (let t = 0.2; t <= 1.0001; t += 0.05) {
    const c = contrastRatio(at(t), ground)
    if (c !== null && c >= floor) {
      tMin = t
      break
    }
  }
  if (tMin >= 1) return [role]
  const out: string[] = []
  for (let i = 0; i < stops; i++) {
    out.push(at(tMin + (1 - tMin) * (i / (stops - 1))))
  }
  return out
}

const rampCache = new Map<string, SpectralRamp>()

/** Memoized ramp for a resolved role color on a family ground — the entry
 *  every surface uses, so a bar redrawn at animation rate never re-walks the
 *  contrast search. */
export function spectralRampFor(
  role: string,
  ground: string,
  floor: number = SPECTRAL_STATE_FLOOR,
): SpectralRamp {
  const key = `${role}|${ground}|${floor}`
  const hit = rampCache.get(key)
  if (hit) return hit
  const ramp = spectralRamp(role, ground, SPECTRAL_STOPS, floor)
  rampCache.set(key, ramp)
  return ramp
}

export type AgentAccent = { name: string; color: string }

export type MercuryThemeTokens = {
  /** Paintable terminal ground (OSC 11). ABSENT ⇒ leave the profile ground —
   *  light families never get a dark canvas forced under them. */
  canvas?: string
  surface0: string
  surface1: string
  surface2: string
  borderSubtle: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  /** INSTRUCTION-class muted text (a11y-p2-01): help legends, editing
   *  hints, chip labels, column headers/values — muted runs the operator
   *  must be able to READ, floored ≥4.5:1 against the family's deepest
   *  painted ground (the spectral-ground bottom-row sample on the dark family).
   *  `textMuted` stays the TRUE-decoration class (separators, ellipses,
   *  spacers — meaning never rides them), documented split. */
  textInstruction: string
  textInverse: string
  accent: string
  accentSoft: string
  /** The identity ramp for focal moments (CN-08): [accent, accentSoft, deep
   *  ink-walk] on the dark brand family; [accent] (flat) everywhere the
   *  family can't host a derived tone. Never status hues, never body text. */
  focalRamp: string[]
  /** The spectral atmospheric ground: the full-viewport vertical
   *  cyan/navy gradient's endpoints — present ONLY on the dark brand family
   *  (light/daltonized/ansi collapse FLAT: undefined, the coherent
   *  reduced-colour fallback). Static by design: painting it costs bytes
   *  only on damage, never at idle. */
  spectraGround?: { top: string; bottom: string }
  focus: string
  selection: string
  /** The ACTIVE-cursor row's full-width band (LUSTRE L2) — decisively the
   *  accent's claim, centrally contrast-guarded. `selection` stays the QUIET
   *  wash (drag-select, saved rows); hover stays surface2. Exactly one row
   *  anywhere should wear this at a time (the focused cursor row). */
  selectionBand: string
  info: string
  /** Info-family INK FOR TEXT (a11y-p2-02): pane titles, status segments —
   *  info-role runs that carry words, floored ≥4.5:1 against the family's
   *  deepest painted ground. `info` itself stays the border/cursor/glyph
   *  hue (the ≥3.0 graphical floor). */
  infoText: string
  success: string
  warning: string
  failure: string
  /** Failure-family INK FOR TEXT (a11y-p2-02): refusal words floored
   *  ≥4.5:1 on the deepest painted ground; `failure` stays the glyph/state
   *  hue. */
  failureText: string
  diffAddRow: string
  diffAddWord: string
  diffRemoveRow: string
  diffRemoveWord: string
  /** SPECTRAL DEPTH. Named ramps, each
   *  bounded and contrast-floored against this family's own ground.
   *
   *  `terra` is the identity/focus ramp AND the session critter's ramp — in
   *  Mercury those are the same hue by construction (the accent IS your
   *  companion's), so shipping them as two names would be a duplicate
   *  pretending to be a choice. The cockpit carrying your critter's colour
   *  through its depth is exactly what that collapse buys. */
  spectral: {
    /** Navigation / information. */
    oasis: SpectralRamp
    /** Identity / focus — the live session critter's accent. */
    terra: SpectralRamp
    /** Structure / depth. */
    dune: SpectralRamp
    /** Waiting / attention. */
    amber: SpectralRamp
    /** Genuine failure. */
    crimson: SpectralRamp
  }
  agentAccents: readonly AgentAccent[]
}

function agentAccentsOf(theme: Theme): AgentAccent[] {
  return [
    { name: 'red', color: theme.red_FOR_SUBAGENTS_ONLY },
    { name: 'blue', color: theme.blue_FOR_SUBAGENTS_ONLY },
    { name: 'green', color: theme.green_FOR_SUBAGENTS_ONLY },
    { name: 'yellow', color: theme.yellow_FOR_SUBAGENTS_ONLY },
    { name: 'purple', color: theme.purple_FOR_SUBAGENTS_ONLY },
    { name: 'orange', color: theme.orange_FOR_SUBAGENTS_ONLY },
    { name: 'pink', color: theme.pink_FOR_SUBAGENTS_ONLY },
    { name: 'cyan', color: theme.cyan_FOR_SUBAGENTS_ONLY },
  ]
}

/** True for the families whose ground is a dark canvas. */
export function isDarkThemeFamily(name: ThemeName): boolean {
  return (
    name === 'dark' ||
    name === 'true-black' ||
    name === 'dark-daltonized' ||
    name === 'dark-ansi'
  )
}

/**
 * Every role path in a resolved token set whose LEAF value is unresolved
 * (an empty string, an empty array, or a non-string leaf). Shape-driven —
 * strings are leaves, arrays/objects are walked — so a structured token
 * added to the type (spectral ramps, agent accents) is validated by its
 * contents instead of tripping a stale "must be a string" exemption list.
 * `canvas` is the one deliberately optional role (absent ⇒ profile ground).
 *
 * The ONE completeness law: doctor rows and the UI provers consume this
 * instead of re-deriving their own role filters.
 */
export function listUnresolvedTokenRoles(tokens: MercuryThemeTokens): string[] {
  const unresolved: string[] = []
  const walk = (path: string, v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length === 0) unresolved.push(path)
      return
    }
    if (Array.isArray(v)) {
      if (v.length === 0) unresolved.push(path)
      else v.forEach((el, i) => walk(`${path}[${i}]`, el))
      return
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v)
      if (entries.length === 0) unresolved.push(path)
      else for (const [k, child] of entries) walk(`${path}.${k}`, child)
      return
    }
    unresolved.push(path)
  }
  for (const [k, v] of Object.entries(tokens)) {
    if (k === 'canvas' && v === undefined) continue
    walk(k, v)
  }
  return unresolved
}

const tokenCache = new Map<string, MercuryThemeTokens>()

/**
 * Resolve the semantic tokens for a concrete theme family and the live
 * identity accent. Pure + memoized; same inputs ⇒ the same frozen object.
 */
export function resolveMercuryTokens(
  themeName: ThemeName,
  accent: string,
): MercuryThemeTokens {
  const key = `${themeName}|${accent}`
  const cached = tokenCache.get(key)
  if (cached) return cached

  const theme = getTheme(themeName)
  let tokens: MercuryThemeTokens
  if (themeName === 'dark' || themeName === 'true-black') {
    // The two authored appearances share ONE expression — the oasis brand
    // mapping — and differ only in the ground family they rest on
    // (groundFamilyFor: oasis for dark, pure-black-anchored for true-black).
    const ground = groundFamilyFor(themeName)
    // The atmospheric wash: the family's ground at the top breathing toward
    // a quiet cyan-lifted navy at the bottom (OASIS-tinted). Depth 0.25
    // (operator ruling, gradient phase 1): the 0.16 field measured
    // 1.18:1 top-to-bottom and read flat — 0.25 grades clearly (≈1.34:1)
    // while staying under the splash's 1.42:1 vignette span. The BOTTOM
    // sample is the family's lightest painted ground — the text-grade
    // floor walks below derive against it (a11y-p2-01/02).
    const spectraBottom = spectraMix(ground.NIGHT, OASIS, 0.25)
    // The oasis brand expression — the identity look, on the family ground.
    tokens = {
      canvas: ground.NIGHT,
      spectraGround: { top: ground.NIGHT, bottom: spectraBottom },
      surface0: ground.NIGHT_SOFT,
      surface1: ground.ASH,
      surface2: ground.ASH_RAISED,
      borderSubtle: DUNE_FAINT,
      borderStrong: DUNE,
      textPrimary: IVORY,
      textSecondary: SECOND,
      textMuted: FAINT,
      textInstruction: deriveTextFloorInk(FAINT, IVORY, spectraBottom),
      textInverse: ground.NIGHT,
      accent,
      // The crab's bloom IS the authored BELLY (byte-equal); other critters derive.
      accentSoft: accent === TERRA ? BELLY : deriveAccentSoft(accent, IVORY),
      // The identity ramp rides the SAME bloom as its mid stop (CN-08) so the
      // family stays coherent — never a second derivation of "soft".
      focalRamp: deriveFocalRamp(
        accent,
        accent === TERRA ? BELLY : deriveAccentSoft(accent, IVORY),
        IVORY,
      ),
      focus: accent,
      selection: DUNE,
      // LUSTRE L2: the band walks the live accent toward the family canvas
      // until the central contrast floors hold; the quiet DUNE wash is the
      // fallback only if derivation is impossible (it never is for hex
      // accents — every critter accent is a hex).
      selectionBand: deriveSelectionBand(accent, ground.NIGHT, IVORY, FAINT) ?? DUNE,
      info: OASIS,
      infoText: deriveTextFloorInk(OASIS, IVORY, spectraBottom),
      success: TEAL,
      warning: AMBER,
      failure: CRIMSON,
      failureText: deriveTextFloorInk(CRIMSON, IVORY, spectraBottom),
      diffAddRow: DIFF_ADD_BG,
      diffAddWord: DIFF_ADD_WORD,
      diffRemoveRow: DIFF_DEL_BG,
      diffRemoveWord: DIFF_DEL_WORD,
      // Ground the ramps on the surface the family's panels actually sit on.
      spectral: {
        oasis: spectralRampFor(OASIS, ground.NIGHT_SOFT),
        terra: spectralRampFor(accent, ground.NIGHT_SOFT),
        dune: spectralRampFor(DUNE, ground.NIGHT_SOFT, SPECTRAL_STRUCTURE_FLOOR),
        amber: spectralRampFor(AMBER, ground.NIGHT_SOFT),
        crimson: spectralRampFor(CRIMSON, ground.NIGHT_SOFT),
      },
      agentAccents: agentAccentsOf(theme),
    }
  } else {
    // Every other family maps from its OWN semantic palette — deliberate,
    // accessibility-authoritative; only the identity accent crosses over
    // (and stays legible: dark ground keeps it as-is, light grounds carry
    // the crab red fine at #DD4444 depth).
    const dark = isDarkThemeFamily(themeName)
    tokens = {
      ...(dark ? { canvas: NIGHT } : {}),
      surface0: theme.userMessageBackground,
      surface1: theme.userMessageBackground,
      surface2: theme.userMessageBackgroundHover,
      borderSubtle: theme.inactive,
      borderStrong: theme.subtle,
      textPrimary: theme.text,
      textSecondary: theme.subtle,
      textMuted: theme.inactive,
      // No graded ground on these families (flat, palette-authoritative):
      // instruction-class runs promote to the family's own readable
      // secondary; a derivation has nothing extra to floor against.
      textInstruction: theme.subtle,
      textInverse: theme.inverseText,
      accent,
      // Derived toward the family's OWN primary ink (darker on light grounds);
      // ansi families collapse onto the accent (16-color reality).
      accentSoft: deriveAccentSoft(accent, theme.text),
      // Light / daltonized / ansi can't host the identity ramp — the plain
      // role, so focal moments render flat (CN-08 reduced-colour law).
      focalRamp: [accent],
      focus: accent,
      selection: theme.selectionBg,
      // LUSTRE L2: derive toward the family's OWN surface, guarded against
      // its OWN inks; 16-color families (named/ansi colors) can't host a
      // derived tone — the band collapses onto their selectionBg (one
      // compatible strong fill).
      selectionBand:
        deriveSelectionBand(accent, theme.userMessageBackground, theme.text, theme.inactive) ??
        theme.selectionBg,
      info: theme.info,
      // Flat grounds: the accessibility palettes' own info/error inks are
      // already their text expression — text-grade collapses onto them.
      infoText: theme.info,
      success: theme.success,
      warning: theme.warning,
      failure: theme.error,
      failureText: theme.error,
      diffAddRow: theme.diffAdded,
      diffAddWord: theme.diffAddedWord,
      diffRemoveRow: theme.diffRemoved,
      diffRemoveWord: theme.diffRemovedWord,
      // Same construction against the family's OWN surface, so a light or
      // daltonized cockpit gets ITS depth rather than a dark one dimmed. On
      // 16-color families every role is a named color: parseColor returns
      // null, each ramp collapses to a single stop, and the surfaces fall
      // back to their flat rendering.
      spectral: {
        oasis: spectralRampFor(theme.info, theme.userMessageBackground),
        terra: spectralRampFor(accent, theme.userMessageBackground),
        dune: spectralRampFor(theme.subtle, theme.userMessageBackground, SPECTRAL_STRUCTURE_FLOOR),
        amber: spectralRampFor(theme.warning, theme.userMessageBackground),
        crimson: spectralRampFor(theme.error, theme.userMessageBackground),
      },
      agentAccents: agentAccentsOf(theme),
    }
  }
  const frozen = Object.freeze(tokens)
  tokenCache.set(key, frozen)
  return frozen
}
