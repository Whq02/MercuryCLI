// scripts/ui/visualBaseline.ts — the visual-truth library (S2): types,
// compact semantic grids, digests, the first-divergence reporter, manifest io.
//
// The real built Mercury binary is the visual source of truth: every baseline
// entry is painted by dist/mercury.mjs in a real PTY (vshot.py → pyte) inside a
// capture-owned scratch config home, stored as a SEMANTIC cell grid (exact
// glyphs + fg/bg + bold/reverse as RLE spans), digested, and recorded in
// design-system/live/manifest.json. Hand-authored <pre> mockups can never be a
// live target again — the gate (prove-visual-manifest.ts) holds manifest ↔
// grid-file self-consistency, and generate-visual-baseline.ts --check compares
// a fresh capture against the stored digest and reports the FIRST divergent
// cell (row/col, old/new glyph, old/new style) instead of a loose pass.
//
// This module is PURE (fs + crypto only) so the gate prover can import it
// without touching capture machinery. The PTY capture engine — which must pin
// MERCURY_CONFIG_DIR before renderScenarios' module-load CONFIG_HOME snapshot —
// lives in generate-visual-baseline.ts behind a dynamic import.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ColorMode = 'truecolor' | '256' | 'ansi' | 'none'
export type Motion = 'full' | 'reduced'

export interface VisualBaselineEntry {
  id: string
  sourceSha: string
  buildDigest: string // dist/manifest.json buildTree — the exact artifact that painted this
  scenario: string
  cols: number
  rows: number
  theme: string
  colorMode: ColorMode
  motion: Motion
  mouse: 'on' | 'off'
  stateFixture: string // the scenario name IS the owned fixture id today
  terminalProfile: string
  gridPath: string
  gridDigest: string // sha256 over masked text rows
  styleDigest: string // sha256 over the RLE style planes
  masks: string[] // row-level regexes neutralized before digesting (live clock etc.)
  generatedAt: string
}

export interface VisualManifest {
  schema: 1
  generator: 'scripts/ui/generate-visual-baseline.ts'
  sourceSha: string
  buildDigest: string
  generatedAt: string
  // Honest coverage: dimensions NOT yet captured are named, never implied.
  descoped: string[]
  entries: VisualBaselineEntry[]
}

// Cell grid as stored on disk — compact but lossless for cells pyte models.
export interface StoredGrid {
  schema: 1
  cols: number
  rows: number
  text: string[] // one string per row, cell.data joined (wide chars keep pyte's spacer cells)
  // Per row: [startCol, len, fg, bg, flags] spans; flags bit0=bold bit1=reverse.
  // Default-everything spans are omitted — absence = default.
  styles: Array<Array<[number, number, string, string, number]>>
}

export interface RawGrid {
  cols: number
  rows: number
  grid: Array<Array<{ c: string; fg: string; bg: string; bold: boolean; rev: boolean }>>
}

export const LIVE_DIR = join(import.meta.dir, '..', '..', 'design-system', 'live')
export const GRIDS_DIR = join(LIVE_DIR, 'grids')
export const MANIFEST_PATH = join(LIVE_DIR, 'manifest.json')

// The Helm center header carries a live HH:MM:SS wall clock; session cards
// carry relative ages; the session/status rows read the LIVE repo (git
// uncommitted counts, the preflight health chip) — real product truth, but
// nondeterministic per capture instant/tree. Digests neutralize them; the
// stored grid keeps the real cells; the manifest records the masks. Rows a
// mask touches also drop their STYLE spans from the digest (an amber→teal
// health flip or a changed count length would otherwise leak through
// styleDigest). Staged §2.F follow-up (ledger): move the git/health rows onto
// an OWNED fixture repo via the vshot cwd override so masking shrinks.
export const DEFAULT_MASKS = [
  '\\b\\d{2}:\\d{2}:\\d{2}\\b', // wall clock
  '\\b\\d+[smhd] ago\\b', // relative ages (incl. day-scale)
  '\\b\\d+[smhd] old\\b', // preflight/health chip age
  // Live git tree counts (no trailing \b — ')' then space is not a \b edge).
  // Trailing ' *' on the live-chip masks: when the chip is the LAST content
  // before right-padding, the padding run still encodes the chip's rendered
  // WIDTH ("main*" pads one cell less than "main") — a fixed-token replacement
  // that leaves the run intact diverges on tree state (the 4-card
  // dirty-star gap). Absorbing the run canonicalizes geometry too; mid-row
  // occurrences collapse identically on both sides so nothing new is hidden.
  '\\b\\d+ uncommitted \\(\\+\\d+/-\\d+\\) *',
  // Preflight health chip incl. its bare age tail ("health ▲ caution · 25m",
  // "health ✕ fault") — the full state-glyph vocabulary.
  'health [▲●◌◐✕✓·◓] \\S+( · \\d+[smhd])? *',
  // Statusbar row, WHOLE-ROW canonicalization: the repo dir chip is the
  // checkout's basename (a hosted runner clones as the GitHub repo name),
  // and a span mask cannot absorb the LAYOUT SHIFT a different-length name
  // pushes into everything right of it (the '⤳2' segment + the padding run
  // — gate preflight A simulated the divergence). Row-level is the honest
  // grain until the §2.F owned-fixture-cwd capture lands.
  'row:\\S+ ⌥\\S+',
  // The NARROW statusbar variant (<70 cols sheds the branch chip): the repo
  // dir chip still paints between box glyphs ("│ <checkout-basename> │ ⤳2").
  // Same checkout-name volatility as the wide row above — a sibling
  // worktree with a different basename must grade equal to the main
  // checkout; row-level for the same layout-shift
  // reason.
  'row:│ \\S+ │ ⤳',
  // Statusbar git branch + dirty-star ("⌥main*" — the star flips with the tree).
  '⌥\\S+ *',
  // ROW-level (the 'row:' prefix): the whole row canonicalizes when matched —
  // for live-state chips whose LENGTH shifts move a truncation ellipsis or
  // spacing no span mask can stabilize. The telemetry gate line reads the
  // live verdict.json age.
  'row:gate [✓◓✕·]',
]

// Canonical fixed-token replacement, NOT length-preserving: volatile content
// often changes LENGTH ("health ▲ caution" → "health ✕ fault", "main*" →
// "main"), which shifts every later cell in the row — same-length dots can't
// neutralize that. Replacing with one fixed token canonicalizes the whole row
// string so equal-after-mask means equal-modulo-volatile-content. Column
// numbers in divergence reports are approximate on masked rows (the reporter
// prints both rows in full).
export function maskRow(row: string, masks: string[]): string {
  let out = row
  for (const m of masks) {
    out = out.replace(new RegExp(m, 'g'), '⟪·⟫')
  }
  return out
}

// The digest/compare form: masked text; a row whose text a mask changed also
// has its style spans dropped (volatile content ⇒ volatile span geometry).
// 'row:'-prefixed masks neutralize the ENTIRE row when their regex matches.
export function neutralizeGrid(grid: StoredGrid, masks: string[]): {
  text: string[]
  styles: StoredGrid['styles']
} {
  const spanMasks = masks.filter(m => !m.startsWith('row:'))
  const rowMasks = masks.filter(m => m.startsWith('row:')).map(m => new RegExp(m.slice(4)))
  const text: string[] = []
  const styles: StoredGrid['styles'] = []
  for (let y = 0; y < grid.rows; y++) {
    if (rowMasks.some(re => re.test(grid.text[y]))) {
      text.push('⟪row⟫')
      styles.push([])
      continue
    }
    const masked = maskRow(grid.text[y], spanMasks)
    text.push(masked)
    styles.push(masked === grid.text[y] ? grid.styles[y] : [])
  }
  return { text, styles }
}

export function compactGrid(raw: RawGrid): StoredGrid {
  const text: string[] = []
  const styles: StoredGrid['styles'] = []
  for (const row of raw.grid) {
    text.push(row.map(c => c.c).join(''))
    const spans: Array<[number, number, string, string, number]> = []
    let x = 0
    while (x < row.length) {
      const c = row[x]
      const flags = (c.bold ? 1 : 0) | (c.rev ? 2 : 0)
      let len = 1
      while (
        x + len < row.length &&
        row[x + len].fg === c.fg &&
        row[x + len].bg === c.bg &&
        ((row[x + len].bold ? 1 : 0) | (row[x + len].rev ? 2 : 0)) === flags
      ) {
        len++
      }
      if (c.fg !== 'default' || c.bg !== 'default' || flags !== 0) {
        spans.push([x, len, c.fg, c.bg, flags])
      }
      x += len
    }
    styles.push(spans)
  }
  return { schema: 1, cols: raw.cols, rows: raw.rows, text, styles }
}

export function gridDigest(grid: StoredGrid, masks: string[]): string {
  return createHash('sha256').update(neutralizeGrid(grid, masks).text.join('\n')).digest('hex')
}

export function styleDigest(grid: StoredGrid, masks: string[]): string {
  return createHash('sha256').update(JSON.stringify(neutralizeGrid(grid, masks).styles)).digest('hex')
}

export interface Divergence {
  row: number
  col: number
  kind: 'glyph' | 'style' | 'geometry'
  old: string
  new: string
  oldRow: string
  newRow: string
}

// First divergent cell between two stored grids (masked comparison) — the §3
// reporter: never a loose threshold, always the exact first cell + row context.
export function firstDivergence(a: StoredGrid, b: StoredGrid, masks: string[]): Divergence | null {
  if (a.cols !== b.cols || a.rows !== b.rows) {
    return {
      row: 0, col: 0, kind: 'geometry',
      old: `${a.cols}x${a.rows}`, new: `${b.cols}x${b.rows}`,
      oldRow: '', newRow: '',
    }
  }
  const na = neutralizeGrid(a, masks)
  const nb = neutralizeGrid(b, masks)
  for (let y = 0; y < a.rows; y++) {
    const ra = na.text[y]
    const rb = nb.text[y]
    if (ra !== rb) {
      for (let x = 0; x < Math.max(ra.length, rb.length); x++) {
        if (ra[x] !== rb[x]) {
          return {
            row: y, col: x, kind: 'glyph',
            old: JSON.stringify(ra[x] ?? ''), new: JSON.stringify(rb[x] ?? ''),
            oldRow: ra, newRow: rb,
          }
        }
      }
    }
    const spansA = na.styles[y]
    const spansB = nb.styles[y]
    if (JSON.stringify(spansA) !== JSON.stringify(spansB)) {
      for (let i = 0; i < Math.max(spansA.length, spansB.length); i++) {
        if (JSON.stringify(spansA[i]) !== JSON.stringify(spansB[i])) {
          const col = (spansA[i] ?? spansB[i])[0]
          return {
            row: y, col, kind: 'style',
            old: JSON.stringify(spansA[i] ?? null), new: JSON.stringify(spansB[i] ?? null),
            oldRow: a.text[y], newRow: b.text[y],
          }
        }
      }
    }
  }
  return null
}

export interface CaptureSpec {
  scenario: string
  cols: number
  rows: number
  theme: string
  colorMode: ColorMode
  motion: Motion
  masks?: string[]
}

export function entryId(s: CaptureSpec): string {
  return `${s.scenario}--${s.cols}x${s.rows}--${s.theme}--${s.colorMode}--${s.motion}`
}

export function readManifest(): VisualManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as VisualManifest
  } catch {
    return null
  }
}

export function readStoredGrid(entry: VisualBaselineEntry): StoredGrid {
  return JSON.parse(readFileSync(join(LIVE_DIR, entry.gridPath), 'utf8')) as StoredGrid
}
