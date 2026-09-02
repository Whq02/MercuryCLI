// Type surface of splash-core.mjs for the in-process host (CB-06). The
// runtime truth is the .mjs beside this file — keep the two in step.

export interface SplashHintSegment {
  /** Rendered accent-red, verbatim (own its trailing space: '↵ '). */
  key: string
  /** Rendered after the key in the declared tone (own its leading space). */
  label: string
  tone: 'ivory' | 'faint'
}

export interface SplashCardRow {
  icon: string
  label: string
  ctx: string
  /** In-process registered-honesty paint: a dim row's label renders faint
   *  (the standalone never sets it — its bytes stay the pre-split contract). */
  dim?: boolean
}

export interface SplashComposeOpts {
  cardRows: SplashCardRow[]
  cardSel: number
  hintSegments: SplashHintSegment[]
  /** The tiny-tier trailing hint (standalone: '↵ start'). */
  tinyHint: string
  /** The status strip for the card tiers (both hosts: composeStrip bound to
   *  the host's chip facts). */
  stripLines: (width: number) => string[]
  /** The one-placement seam: compose the full block for geometry but suppress the
   *  '↑↓ choose' hint appendix (the cinematic frame paints no card). */
  hintCinematic?: boolean
  /** GLOW: the pixel word's greeting phase (null/absent = settled). */
  glowWord?: GlowPhase | null
  /** GLOW: the selected card row's greeting phase (null/absent = settled). */
  glowRow?: GlowPhase | null
}

/** The greeting-shimmer phase (the kit's ShimmerPhase shape — the hosts pass
 *  useGreetingShimmer's value, or glowPhaseAt's, straight through). */
export interface GlowPhase {
  peakCell: number
  gainLevel: number
  radiusCells: number
}

/** A resolved accent family (the baked ACCENT_FAMILIES rows carry exactly
 *  this shape; an app host may pass a live tokens-derived equivalent). */
export interface SplashAccentFamily {
  main: number[]
  deep: number[]
  soft: number[]
  ramp: number[][]
  t256: number
  t256deep: number
  key?: string
}

export interface SplashStripChips {
  model: string
  critter: string
  critterHue: string | null
  dir: string
  acct: { state: 'email' | 'none' | 'unreadable'; text?: string }
  health: { verdict: string; age: string | null } | null
}

export interface SplashProjectRow {
  base: string
  ageMs: number
  /** Host-abbreviated display dir (~-abbreviation needs homedir). */
  dirShown: string
}

export interface BootMenuEntry {
  label: string
  group: string
  /** The section title verbatim (the wide tier otherwise upper-cases `group`). */
  groupTitle?: string
  summary: string
  valueLabel: string
  valueIsDefault: boolean
  pinnedVal: string | null
  detail: { controls: string; on: readonly string[]; off: readonly string[] } | null
  detailExtra?: readonly string[]
  /** A section's honest empty line: faint, never focused (the host keeps
   *  the cursor off it and composes selIdx -1 while it is the only row). */
  inert?: boolean
}

/** A host-supplied row of the right-mid panel (replaces LAUNCH SUMMARY's
 *  four rows wholesale when `summaryRows` is given). The amber/crimson
 *  status registers serve verdict-shaped hosts (the face's health screen). */
export interface BootMenuSummaryRow {
  key: string
  value: string
  tone?: 'cream' | 'faint' | 'teal' | 'amber' | 'crimson'
}

export interface BootMenuData {
  entries: BootMenuEntry[]
  /** -1 composes no focused row (an empty catalogue / the cursor parked
   *  off an inert line) — the detail body is then `detailOverride` or empty. */
  selIdx: number
  /** The boot menu's four LAUNCH SUMMARY facts — required unless the host
   *  hands its own `summaryRows`. */
  summary?: { profile: string; harness: string; integrity: string; integritySet: boolean }
  environment: { model: string; critter: string; critterHue: string | null; dirBase: string; dirTail: string }
  statusRight: string
  legend: string
  legendClassic?: string
  detailOverride?: string[]
  /** GLOW: the wide tier's pixel-word greeting phase (null/absent = settled). */
  glowWord?: GlowPhase | null
  // GENERIC over its host (the MCPs & Skills manager rides the same
  // composer): every field below is optional and absent ⇒ the boot menu's
  // exact bytes.
  /** The caption word ('boot menu' — wide '⌁ <title>', classic ' · <title>'). */
  title?: string
  /** The right-mid panel's title + rows (default: LAUNCH SUMMARY's four). */
  summaryTitle?: string
  summaryRows?: readonly BootMenuSummaryRow[]
  /** A LOUD one-sentence disclosure surfaced at EVERY size: the wide tier
   *  carries it as its summaryRows Notice row; the classic tier paints THIS
   *  field as a wrapped teal block above the entries. The host derives both
   *  from the ONE upstream notice. Absent/null ⇒ byte-identical frames. */
  noticeLine?: string | null
  /** The clamped-detail ellipsis line (the default names the flag registry). */
  moreHint?: string
}

export interface BootMenuComposition {
  lines: string[]
  entryLines: Array<{ entry: number; line: number }>
}

export interface SplashComposition {
  /** SGR-styled lines, centered to the requested cols. */
  lines: string[]
  /** Wordmark centre index within lines (the ONE placed brand row). */
  wordRow: number
  /** Whether the action card is on screen. */
  cardShown: boolean
  /** Line index (into lines) of each card action row, in row order. */
  actionLines: number[]
}

export interface SplashCore {
  R: string
  BOLD: string
  BOLD_UL: string
  DIM: string
  rgbFg(px: number[]): string
  rgbBg(px: number[]): string
  hexFg(hex: string, fb: number): string
  fg256ish(px: number[]): string
  paint(px: number[]): string
  paintBg(px: number[]): string
  rasterHard(
    grid: string[],
    toneAt?: (ch: string, x: number, W: number) => number[],
  ): { lines: string[]; width: number }
  dividerLine(width: number): string
  wordTone(ch: string, x: number, W: number, phase?: GlowPhase | null): number[]
  wordToneGlow(phase: GlowPhase | null): (ch: string, x: number, W: number) => number[]
  rampLabel(text: string, phase?: GlowPhase | null): string
  rampSample(u: number): number[]
  sampleFace(u: number): number[]
  boxTop(w: number, bc: string): string
  boxBot(w: number, bc: string): string
  boxSep(w: number, bc: string): string
  boxRow(content: string, w: number, bc: string): string
  clipVis(s: string, w: number): string
  composeHint(segments: SplashHintSegment[], withCard: boolean): string
  composeCard(
    rows: SplashCardRow[],
    selIdx: number,
    w: number,
    seps?: boolean,
    glowRow?: GlowPhase | null,
  ): { lines: string[]; rowLines: number[] }
  composeStrip(chips: SplashStripChips, w: number): string[]
  composeProjects(
    projects: SplashProjectRow[],
    selIdx: number,
    w: number,
  ): { lines: string[]; rowLines: number[] }
  composeBootMenu(cols: number, rowsAvail: number, m: BootMenuData): BootMenuComposition
  composeBootMenuWide(cols: number, rowsAvail: number, m: BootMenuData, withHead?: boolean): BootMenuComposition | null
  composeBootMenuClassic(cols: number, rowsAvail: number, m: BootMenuData): BootMenuComposition
  panelLines(title: string, contentLines: string[], w: number): string[]
  composeLockup(cols: number, rows: number, opts: SplashComposeOpts): SplashComposition
  placeBlock(block: string[], rows: number): { placed: string[]; top: number }
  vis(s: string): number
  cpWidth(cp: number): number
  MARK_RE: RegExp
  padVis(s: string, w: number): string
  wrapWords(txt: string, w: number): string[]
  zipCols(a: string[], b: string[], aW: number, gap: number): string[]
  mixc(a: number[], b: number[], t: number): number[]
  T256: { cream: number; red: number; faint: number; dim: number; dimred: number }
  CREAM: number[]
  RED: number[]
  VOID: number[]
  FAINT: string
  IVORY: string
  MIDCREAM: number[]
  DEEPRED: number[]
  MIDRED: number[]
  DUNE: number[]
  PX: Record<string, number[]>
  TEALC: number[]
  AMBERC: number[]
  CRIMSONC: number[]
  /** GLOW: the resolved accent family + its hex + the chrome emitter. */
  ACCENT: SplashAccentFamily
  ACCENT_HEX: string
  accentFg(): string
}

export function createSplashCore(caps?: {
  nocolor?: boolean
  truecolor?: boolean
  /** The critter family key (or a resolved family object). Absent = crab,
   *  byte-identical to the pre-GLOW composition. */
  accent?: string | SplashAccentFamily
}): SplashCore

export const HEADSTD: string[]
export const WORD: string[]
export const MENU: unknown[]
export const MODEL_NAMES: Record<string, string>
export const RAMP: number[][]
export const RAMP_FIXTURE: number[][]
export const CAPABILITY_TRUTH: Array<Array<string | null>>
export const ACCENT_FAMILIES: Record<string, SplashAccentFamily>
export const DEFAULT_CRITTER: string
export function accentFamilyKeyOf(raw: unknown): string
export function glowPhaseAt(elapsedMs: number, spanCells: number): GlowPhase | null
export function glowBoostAt(cellCenter: number, phase: GlowPhase | null): number
export function glowSettled(elapsedMs: number): boolean
export const GLOW_TICK_MS: number
export const WORD_W: number
export const CARD_LABEL_W: number
export function vis(s: string): number
export function cpWidth(cp: number): number
export const MARK_RE: RegExp
export function padVis(s: string, w: number): string
export function wrapWords(txt: string, w: number): string[]
export function zipCols(a: string[], b: string[], aW: number, gap: number): string[]
export function placeBlock(block: string[], rows: number): { placed: string[]; top: number }
export function mixc(a: number[], b: number[], t: number): number[]
export function rampSample(u: number): number[]
export function fmtAge(ms: number): string
export interface CardFacts {
  cwdBase: string
  continueTarget: { base: string; ageMs: number; cross: boolean; dim?: boolean } | null
  menuAvailable: boolean
  /** null composes NO concourse row — the `--chat` card (L15): New Session is the door. */
  concourse: { ctx: string; dim?: boolean } | null
  /** The armed ONE-SHOT preset's name (lane KIT-PRESETS): the kit row's ctx
   *  says "next: preset '<name>'" while armed — a wear is never a surprise.
   *  Runtime-only; absent (the launcher, an unarmed boot) composes the
   *  standing ctx byte-identically. */
  kitArmedPreset?: string
  /** The Saturn row's wake-glance words (host truth; runtime-only — the
   *  declaration lagged the S5 widening and heals here). */
  saturnCtx?: string
  /** The Logins row's sign-in glance (host truth; runtime-only). */
  loginsCtx?: string
  /** The Agents row's roster glance (host truth; runtime-only). */
  agentsCtx?: string
  /** The merged Sessions · Projects row's glance (host truth; runtime-only). */
  sessionsCtx?: string
}
export function assembleCardRows(facts: CardFacts): Array<SplashCardRow & { key: string }>
/** The shared flat ground: the SELECTED appearance's deep ground
 *  as an [r,g,b] triple — the launcher's OSC-11 value and the runtime's
 *  family ground are the ONE pair. (There is no vignette sampler —
 *  the flat-ground law.) */
export declare const GROUND: number[];
/** The two appearances' deep grounds ([r,g,b]), pinned byte-equal to
 *  mercuryPalette's OASIS_GROUND/TRUE_BLACK_GROUND by prove-ramp-parity. */
export declare const GROUND_FAMILIES: { dark: number[]; 'true-black': number[] };
/** Re-anchor the estate's ONE ground reference (VOID === GROUND ===
 *  PLATE_TONE) in place — before any core is constructed / composes.
 *  Unknown names keep the dark identity; un-adopted modules are
 *  byte-identical dark. */
export declare function adoptGroundFamily(name: string): void;
