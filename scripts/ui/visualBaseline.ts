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

export const IDLE_MEASURE_MASK = '│ {2,3}(?:idle|—) +(?=│)'

export const DEFAULT_MASKS = [
  '\\b\\d{2}:\\d{2}:\\d{2}\\b',
  '\\b\\d+[smhd] ago\\b',
  '\\b\\d+[smhd] old\\b',
  '\\b\\d+ uncommitted \\(\\+\\d+/-\\d+\\) *',
  'health [▲●◌◐✕✓·◓] \\S+( · \\d+[smhd])? *',
  'row:\\S+ ⌥ ?[^…\\s]\\S*',
  'row:│ \\S+ │ ⤳',
  'FILES · [^│]*',
  '(?:⌥|alt\\+)←→ flip · /sessions *',
  '⌥ ?\\S+ *',
  'row: · \\S+ · \\S+ +(?:⇧|shift\\+)← back',
  'row:^ ?\\S+ · \\S+ +(?:⇧|shift\\+)← back',
  'row:^ ready · .+ {2,}(?:⇧|shift\\+)← back',
  ' *(?:⇧|shift\\+)← concourse *',
  'row:^(?:\\d+ sessions? on · \\d+ monitors? here · \\d+ agents? here {1,5}|S:\\d+ · M:\\d+ · A:\\d+(?: …)? *)(?:⇧|shift\\+)← concourse *$',
  '(?<= · effort [^·]+ · ctx \\S+ · )\\S.*',
  'row:gate [✓◓✕·]',
  IDLE_MEASURE_MASK,
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
    [`${checkout.basename} ⌥ ${checkout.branch}*`, 'mercury ⌥ main'],
    [`${checkout.basename} ⌥ ${checkout.branch}`, 'mercury ⌥ main'],
    [`${checkout.basename} ⌥${checkout.branch}*`, 'mercury ⌥main'],
    [`${checkout.basename} ⌥${checkout.branch}`, 'mercury ⌥main'],
    [`│ ${checkout.basename} │ ⤳`, '│ mercury │ ⤳'],
    [` · ${checkout.basename} · `, ' · mercury · '],
    [` ${checkout.basename} · `, ' mercury · '],
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

export function liveDirs(root: string = LIVE_DIR): { liveDir: string; gridsDir: string; manifestPath: string } {
  return { liveDir: root, gridsDir: join(root, 'grids'), manifestPath: join(root, 'manifest.json') }
}

export function readManifest(root: string = LIVE_DIR): VisualManifest | null {
  try {
    return JSON.parse(readFileSync(liveDirs(root).manifestPath, 'utf8')) as VisualManifest
  } catch {
    return null
  }
}

export function readStoredGrid(entry: VisualBaselineEntry, root: string = LIVE_DIR): StoredGrid {
  return JSON.parse(readFileSync(join(root, entry.gridPath), 'utf8')) as StoredGrid
}

export const SETTLE_LAW = { tickMs: 200, stillTicks: 8, ceilingTicks: 300 } as const

export const COMPOSER_NEEDLE = 'Type a prompt'
export const RAIL_SCAN_NEEDLES = ['RECENT', '○ '] as const
export const NARROW_COUNT_NEEDLE = 'concourse'
export const WORKFLOW_IDLE_NEEDLE = 'idle'

export function cockpitReadyText(cols: number, wideMinCols: number, bothRailsMinCols = Number.POSITIVE_INFINITY): string[] {
  if (cols < wideMinCols) return [COMPOSER_NEEDLE, NARROW_COUNT_NEEDLE]
  return cols >= bothRailsMinCols ? [COMPOSER_NEEDLE, ...RAIL_SCAN_NEEDLES, WORKFLOW_IDLE_NEEDLE] : [COMPOSER_NEEDLE, ...RAIL_SCAN_NEEDLES]
}

export type SettleSend = Record<string, unknown> & {
  atTick?: number
  data?: string
  awaitText?: string
  awaitRaw?: string
  afterPrevTicks?: number
  awaitRedraws?: number
  awaitStableTicks?: number
  requireAwait?: boolean
}

export interface SettleCaptureInput {
  sends?: SettleSend[]
  readyText?: string | string[]
  stableTicks?: number
  total?: number
  requireStable?: boolean
  [key: string]: unknown
}

export function gateSends(sends: readonly SettleSend[], stillTicks: number, bootNeedles: readonly string[] = [COMPOSER_NEEDLE]): SettleSend[] {
  const boot = bootNeedles.length > 0 ? bootNeedles : [COMPOSER_NEEDLE]
  let prevAt: number | null = null
  return sends.flatMap(send => {
    const bare =
      send.awaitText === undefined && send.awaitRaw === undefined && send.afterPrevTicks === undefined && send.awaitRedraws === undefined
    if (!bare) {
      prevAt = null
      return [send]
    }
    const { atTick, ...rest } = send
    const at = Number(atTick ?? 1)
    if (prevAt === null) {
      prevAt = at
      return [...readyChain(boot.slice(0, -1)), { ...rest, awaitText: boot[boot.length - 1], awaitStableTicks: stillTicks, requireAwait: true }]
    }
    const gap = Math.max(1, at - prevAt)
    prevAt = at
    return [{ ...rest, afterPrevTicks: gap }]
  })
}

export function readyChain(needles: readonly string[]): SettleSend[] {
  return needles.map(needle => ({ awaitText: needle, requireAwait: true, data: '' }))
}

export function settleNeedles(cfg: SettleCaptureInput, cockpit: readonly string[], extra: readonly string[] = []): string[] {
  const own = cfg.readyText === undefined ? [] : typeof cfg.readyText === 'string' ? [cfg.readyText] : cfg.readyText
  const needles = own.length > 0 ? [...own, ...extra] : [...cockpit, ...extra]
  return [...new Set(needles)]
}

export function settleCaptureConfig<T extends SettleCaptureInput>(
  cfg: T,
  needles: readonly string[],
  bootNeedles: readonly string[] = [COMPOSER_NEEDLE],
  law = SETTLE_LAW,
): T {
  const { readyText: _own, ...rest } = cfg
  void _own
  return {
    ...rest,
    sends: [...gateSends(cfg.sends ?? [], law.stillTicks, bootNeedles), ...readyChain(needles)],
    stableTicks: law.stillTicks,
    requireStable: true,
    total: law.ceilingTicks,
  } as T
}

export function settleWallMs(law = SETTLE_LAW, scale = 1): number {
  return Math.round(law.ceilingTicks * law.tickMs * scale) + 30_000
}

export type CaptureAttemptResult = { status: number | null; stderr: string; stdout: string; grid?: RawGrid }

export type CaptureRefusalKind = 'never-ready' | 'never-still' | 'wall' | 'refused'

export function captureRefusalKind(status: number | null, stderr: string): CaptureRefusalKind {
  if (status === 3 || status === 4 || /NEVER-READY|UNDELIVERED-SENDS/.test(stderr)) return 'never-ready'
  if (status === 5 || /NEVER-STABLE/.test(stderr)) return 'never-still'
  if (status === null) return 'wall'
  return 'refused'
}

export function isSettleRefusal(kind: CaptureRefusalKind): boolean {
  return kind === 'never-ready' || kind === 'never-still' || kind === 'wall'
}

function firstLineOf(text: string): string {
  return text.trim().split('\n')[0] ?? text
}

export function captureRetryLine(id: string, attempt: number, reason: string): string {
  return `↻ ${id} — attempt ${attempt} rejected by the oracle (${firstLineOf(reason)}); one more capture at the same ceiling`
}

export class CaptureRefusal extends Error {
  constructor(
    readonly id: string,
    readonly kind: CaptureRefusalKind,
    readonly result: CaptureAttemptResult,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureRefusal'
  }
}

export function runCaptureAttempts(
  id: string,
  run: (attempt: number) => CaptureAttemptResult,
  judge: (grid: RawGrid) => { ok: boolean; reason: string },
  opts: { attempts?: number; log?: (line: string) => void; refused?: (res: CaptureAttemptResult, kind: CaptureRefusalKind) => string },
): { grid: RawGrid; stdout: string; attempts: number } {
  const attempts = opts.attempts ?? 2
  const reasons: string[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = run(attempt)
    if (res.status !== 0 || res.grid === undefined) {
      const reason = res.stderr.trim() !== '' ? res.stderr : `vshot failed (status ${res.status ?? 'wall'})`
      const kind = captureRefusalKind(res.status, res.stderr)
      const kept = opts.refused?.(res, kind) ?? ''
      throw new CaptureRefusal(id, kind, res, `[${id}] ${kind === 'refused' ? 'capture failed' : 'never settled within the ceiling'} — ${firstLineOf(reason)}${kept ? ` · what it saw: ${kept}` : ''}`)
    }
    const verdict = judge(res.grid)
    if (verdict.ok) return { grid: res.grid, stdout: res.stdout, attempts: attempt }
    reasons.push(`attempt ${attempt}: ${firstLineOf(verdict.reason)}`)
    if (attempt < attempts) opts.log?.(captureRetryLine(id, attempt, verdict.reason))
  }
  throw new Error(`[${id}] capture rejected by the oracle after ${attempts} attempts — ${reasons.join(' · then ')}`)
}

export function storedGridStands(stored: StoredGrid | null, fresh: StoredGrid, masks: string[]): boolean {
  return stored !== null && firstDivergence(stored, fresh, masks) === null
}
