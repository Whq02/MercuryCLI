
export interface SplashHintSegment {
  key: string
  label: string
  tone: 'ivory' | 'faint'
}

export interface SplashCardRow {
  icon: string
  label: string
  ctx: string
  dim?: boolean
}

export interface SplashComposeOpts {
  cardRows: SplashCardRow[]
  cardSel: number
  hintSegments: SplashHintSegment[]
  tinyHint: string
  stripLines: (width: number) => string[]
  hintCinematic?: boolean
  glowWord?: GlowPhase | null
  glowRow?: GlowPhase | null
}

export interface GlowPhase {
  peakCell: number
  gainLevel: number
  radiusCells: number
}

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
  dirShown: string
}

export interface BootMenuEntry {
  label: string
  group: string
  groupTitle?: string
  summary: string
  valueLabel: string
  valueIsDefault: boolean
  pinnedVal: string | null
  detail: { controls: string; on: readonly string[]; off: readonly string[] } | null
  detailExtra?: readonly string[]
  inert?: boolean
}

export interface BootMenuSummaryRow {
  key: string
  value: string
  tone?: 'cream' | 'faint' | 'teal' | 'amber' | 'crimson'
}

export interface BootMenuData {
  entries: BootMenuEntry[]
  selIdx: number
  summary?: { profile: string; harness: string; integrity: string; integritySet: boolean }
  environment: { model: string; critter: string; critterHue: string | null; dirBase: string; dirTail: string }
  statusRight: string
  legend: string
  legendClassic?: string
  detailOverride?: string[]
  glowWord?: GlowPhase | null
  title?: string
  summaryTitle?: string
  summaryRows?: readonly BootMenuSummaryRow[]
  noticeLine?: string | null
  moreHint?: string
}

export interface BootMenuComposition {
  lines: string[]
  entryLines: Array<{ entry: number; line: number }>
}

export interface SplashComposition {
  lines: string[]
  wordRow: number
  cardShown: boolean
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
  ACCENT: SplashAccentFamily
  ACCENT_HEX: string
  accentFg(): string
}

export function createSplashCore(caps?: {
  nocolor?: boolean
  truecolor?: boolean
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
  concourse: { ctx: string; dim?: boolean } | null
  kitArmedPreset?: string
  saturnCtx?: string
  loginsCtx?: string
  agentsCtx?: string
  sessionsCtx?: string
}
export function assembleCardRows(facts: CardFacts): Array<SplashCardRow & { key: string }>
export declare const GROUND: number[];
export declare const GROUND_FAMILIES: { dark: number[]; 'true-black': number[] };
export declare function adoptGroundFamily(name: string): void;
