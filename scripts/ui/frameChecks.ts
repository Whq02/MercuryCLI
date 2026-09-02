
export type Cell = { c?: string }
export type Grid = Cell[][]

export const rowsOf = (g: Grid | undefined): string[] =>
  Array.isArray(g) ? g.map(row => row.map(cell => (cell.c === undefined || cell.c === '' ? ' ' : cell.c)).join('')) : []

const BOX = new Set(['╭', '╮', '╰', '╯', '│', '─', '├', '┤', '┬', '┴', '┼', '┌', '┐', '└', '┘'])
const CUT = new Set(['─', '╰', '╯', '┴', '┬', '┼', '━', '▔', '▁', '═'])
export const EXIT_HINT = /\besc\b|←|\bq quits\b|⇧←|shift\+←|\bctrl\+[cd]\b/i
const KEY_HINT_ROW = /(^|· )(↑↓|↵|←→|esc|⌫|tab|space|⇧|⌃)/
const isRule = (line: string): boolean => line.length > 0 && /^(.)\1*$/.test(line) && CUT.has(line[0]!)

export type Finding = { kind: 'broken-border' | 'bleed' | 'clip' | 'no-exit' | 'footer-wrapped'; detail: string }

export function inspect(rows: string[], cols: number, root?: RegExp): Finding[] {
  const out: Finding[] = []
  const cell = (y: number, x: number): string => rows[y]?.[x] ?? ' '
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y]!
    if (isRule(line)) continue
    for (let x0 = line.indexOf('╭'); x0 >= 0; x0 = line.indexOf('╭', x0 + 1)) {
      const x1 = line.indexOf('╮', x0 + 1)
      if (x1 < 0) {
        out.push({ kind: 'broken-border', detail: `row ${y}: ╭ at ${x0} has no ╮ (the top edge is cut or overwritten)` })
        continue
      }
      let closed = false
      let cut = false
      let lastInner = y
      for (let yy = y + 1; yy < rows.length; yy++) {
        const l = cell(yy, x0)
        const r = cell(yy, x1)
        if (l === '╰') {
          closed = true
          if (r !== '╯') out.push({ kind: 'broken-border', detail: `row ${yy}: bottom edge ╰ at ${x0} but ${JSON.stringify(r)} at ${x1}` })
          break
        }
        if (isRule(rows[yy]!) || (CUT.has(l) && l !== '│') || (CUT.has(r) && r !== '│')) {
          cut = true
          break
        }
        lastInner = yy
        const marginRow = rows[yy]!.replace(/^\s*│/, '').replace(/│\s*$/, '').trim() === ''
        if (l === ' ' && r === ' ' && marginRow) {
          cut = true
          break
        }
        if (!(l === '│' || l === '├')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: left edge at ${x0} reads ${JSON.stringify(l)}` })
          break
        }
        if (!(r === '│' || r === '┤')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: right edge at ${x1} reads ${JSON.stringify(r)} — "${rows[yy]!.slice(Math.max(0, x1 - 30), x1 + 2).trim()}"` })
          break
        }
        const after = cell(yy, x1 + 1)
        if (x1 + 1 < cols && after !== ' ' && !BOX.has(after)) {
          out.push({ kind: 'bleed', detail: `row ${yy}: ${JSON.stringify(after)} painted right of the border at ${x1 + 1}` })
        }
      }
      if (cut) continue
      if (!closed) {
        if (lastInner >= rows.length - 1 && y < rows.length - 4) {
          out.push({ kind: 'clip', detail: `shell opened at row ${y} (x ${x0}..${x1}) never closes — its footer is off screen` })
        }
        continue
      }
      if (x1 - x0 > cols / 2 && lastInner - y >= 3) {
        const inner = (yy: number): string => rows[yy]!.slice(x0 + 1, x1).trim()
        const footer = inner(lastInner)
        const above = inner(lastInner - 1)
        if (EXIT_HINT.test(footer) && above !== '' && KEY_HINT_ROW.test(above) && !above.includes('…')) {
          out.push({ kind: 'footer-wrapped', detail: `rows ${lastInner - 1}-${lastInner}: "${above}" / "${footer}"` })
        }
      }
    }
  }
  const whole = rows.join('\n')
  if (root !== undefined) {
    if (!root.test(whole) && !EXIT_HINT.test(whole)) out.push({ kind: 'no-exit', detail: `a root screen with no key-map row (${root}) and no exit hint` })
  } else if (!EXIT_HINT.test(whole)) {
    out.push({ kind: 'no-exit', detail: 'no esc / ← / q / ⇧← / ctrl+c hint anywhere on the frame' })
  }
  return out
}


export function composerCaret(rows: string[]): { y: number; x: number } | null {
  let found: { y: number; x: number } | null = null
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y]!
    const x = line.indexOf('❯')
    if (x < 0) continue
    const before = line.slice(0, x)
    if (/^\s*│[\s!#]*$/.test(before)) found = { y, x: x + 2 }
  }
  return found
}

export function needleRows(rows: string[], needle: string): number[] {
  const hits: number[] = []
  rows.forEach((r, i) => {
    if (r.includes(needle)) hits.push(i)
  })
  return hits
}

export function paintedRows(rows: string[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.trim() !== '') out.push(i)
  })
  return out
}
