import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ColorMode = 'truecolor' | '256' | 'ansi' | 'none'
export type Motion = 'full' | 'reduced'

export interface VisualBaselineEntry {
  id: string
  sourceSha: string
  buildDigest: string
  scenario: string
  cols: number
  rows: number
  theme: string
  colorMode: ColorMode
  motion: Motion
  mouse: 'on' | 'off'
  stateFixture: string
  terminalProfile: string
  gridPath: string
  gridDigest: string
  styleDigest: string
  masks: string[]
  generatedAt: string
}

export interface VisualManifest {
  schema: 1
  generator: 'scripts/ui/generate-visual-baseline.ts'
  sourceSha: string
  buildDigest: string
  generatedAt: string
  descoped: string[]
  entries: VisualBaselineEntry[]
}

export interface StoredGrid {
  schema: 1
  cols: number
  rows: number
  text: string[]
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

export const DEFAULT_MASKS = [
  '\\b\\d{2}:\\d{2}:\\d{2}\\b',
  '\\b\\d+[smhd] ago\\b',
  '\\b\\d+[smhd] old\\b',
  '\\b\\d+ uncommitted \\(\\+\\d+/-\\d+\\) *',
  'health [▲●◌◐✕✓·◓] \\S+( · \\d+[smhd])? *',
  'row:\\S+ ⌥ ?\\S+',
  'row:│ \\S+ │ ⤳',
  '⌥ ?\\S+ *',
  'row: · \\S+ · \\S+ +⇧← back',
  'row:gate [✓◓✕·]',
]

export function maskRow(row: string, masks: string[]): string {
  let out = row
  for (const m of masks) {
    out = out.replace(new RegExp(m, 'g'), '⟪·⟫')
  }
  return out
}

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

export function canonicalizeCheckoutRows(
  grid: StoredGrid,
  checkout: { basename: string; branch: string },
): StoredGrid {
  const swaps: Array<[string, string]> = [
    [`${checkout.basename} ⌥${checkout.branch}*`, 'mercury ⌥main'],
    [`${checkout.basename} ⌥${checkout.branch}`, 'mercury ⌥main'],
    [`│ ${checkout.basename} │ ⤳`, '│ mercury │ ⤳'],
    [` · ${checkout.basename} · `, ' · mercury · '],
  ]
  const restore = (row: string, delta: number): string => {
    const runs = [...row.matchAll(/ {2,}/g)]
    const last = runs[runs.length - 1]
    if (!last || last.index === undefined) return row + ' '.repeat(delta)
    return row.slice(0, last.index) + ' '.repeat(delta) + row.slice(last.index)
  }
  const text = grid.text.map(row => {
    for (const [from, to] of swaps) {
      if (!row.includes(from)) continue
      if (to.length > from.length) return row
      return restore(row.replace(from, to), from.length - to.length)
    }
    return row
  })
  return { ...grid, text }
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
