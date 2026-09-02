#!/usr/bin/env bun
import {
  blitRegion,
  type Cell,
  CellWidth,
  cellAt,
  CharPool,
  charInCellAt,
  clearRegion,
  createScreen,
  diff,
  diffEach,
  HyperlinkPool,
  migrateScreenPools,
  type Screen,
  StylePool,
  setCellAt,
  setCellStyleId,
  shiftRect,
  shiftRows,
} from '../../src/ink/cell-grid.js'
import { sgrStateOfStyleString } from '../ink-runtime/ansiEmulator.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function makePools() {
  return { style: new StylePool(), char: new CharPool(), link: new HyperlinkPool() }
}

function snapshot(s: Screen): { cells: Int32Array; noSel: Uint8Array; sw: Int32Array } {
  return {
    cells: s.cells.slice(0, (s.width * s.height) << 1),
    noSel: s.noSelect.slice(0, s.width * s.height),
    sw: s.softWrap.slice(0, s.height),
  }
}

function changedCells(before: Int32Array, s: Screen): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const ci = (y * s.width + x) << 1
      if (s.cells[ci] !== before[ci] || s.cells[ci + 1] !== before[ci + 1]) out.push({ x, y })
    }
  }
  return out
}

function inDamage(s: Screen, x: number, y: number): boolean {
  const d = s.damage
  if (!d) return false
  return x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height
}

function narrow(char: string, styleId: number, link?: string): Cell {
  return { char, styleId, width: CellWidth.Narrow, hyperlink: link }
}
function wide(char: string, styleId: number): Cell {
  return { char, styleId, width: CellWidth.Wide, hyperlink: undefined }
}

function checkSpacerConsistency(label: string, s: Screen): void {
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const c = cellAt(s, x, y)!
      if (c.width === CellWidth.Wide) {
        if (x + 1 < s.width) {
          const tail = cellAt(s, x + 1, y)!
          check(
            `${label}: wide at (${x},${y}) has tail`,
            tail.width === CellWidth.SpacerTail,
            `tail width=${tail.width}`,
          )
        }
      } else if (c.width === CellWidth.SpacerTail) {
        const head = x > 0 ? cellAt(s, x - 1, y) : undefined
        check(
          `${label}: tail at (${x},${y}) follows wide`,
          head !== undefined && head.width === CellWidth.Wide,
          `head width=${head?.width}`,
        )
      }
    }
  }
}

console.log('native-core T2 — screen cell-grid + damage contract')

{
  const rnd = lcg(0xc0ffee)
  const pools = makePools()
  const styleIds = [
    pools.style.none,
    pools.style.intern([{ type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }]),
    pools.style.intern([{ type: 'ansi', code: '\x1b[44m', endCode: '\x1b[49m' }]),
    pools.style.intern([
      { type: 'ansi', code: '\x1b[1m', endCode: '\x1b[22m' },
      { type: 'ansi', code: '\x1b[32m', endCode: '\x1b[39m' },
    ]),
  ]
  const chars = ['a', 'z', '·', '│', 'Ω']
  const wides = ['漢', '値', '本']

  const W = 24
  const H = 10
  const prev = createScreen(W, H, pools.style, pools.char, pools.link)
  const next = createScreen(W, H, pools.style, pools.char, pools.link)

  for (let i = 0; i < 60; i++) {
    const x = Math.floor(rnd() * W)
    const y = Math.floor(rnd() * H)
    const st = styleIds[Math.floor(rnd() * styleIds.length)]!
    if (rnd() < 0.25 && x < W - 1) setCellAt(prev, x, y, wide(wides[Math.floor(rnd() * 3)]!, st))
    else setCellAt(prev, x, y, narrow(chars[Math.floor(rnd() * chars.length)]!, st, rnd() < 0.1 ? 'https://m.example/x' : undefined))
  }
  checkSpacerConsistency('seeded prev', prev)

  blitRegion(next, prev, 0, 0, W, H)
  next.damage = undefined

  const before = snapshot(next)
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(rnd() * W)
    const y = Math.floor(rnd() * H)
    const st = styleIds[Math.floor(rnd() * styleIds.length)]!
    const roll = rnd()
    if (roll < 0.2 && x < W - 1) setCellAt(next, x, y, wide(wides[Math.floor(rnd() * 3)]!, st))
    else if (roll < 0.7) setCellAt(next, x, y, narrow(chars[Math.floor(rnd() * chars.length)]!, st))
    else if (roll < 0.85) setCellStyleId(next, x, y, st)
    else clearRegion(next, x, y, 1 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 2))
  }

  checkSpacerConsistency('mutated next', next)

  const changed = changedCells(before.cells, next)
  for (const { x, y } of changed) {
    check(`damage covers (${x},${y})`, inDamage(next, x, y), `damage=${JSON.stringify(next.damage)}`)
  }

  const reported = new Set<string>()
  diffEach(prev, next, (x, y) => {
    reported.add(`${x},${y}`)
  })
  const bruteChanged = new Set<string>()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ci = (y * W + x) << 1
      if (prev.cells[ci] !== next.cells[ci] || prev.cells[ci + 1] !== next.cells[ci + 1]) {
        bruteChanged.add(`${x},${y}`)
      }
    }
  }
  for (const key of bruteChanged) {
    check(`diffEach reports ${key}`, reported.has(key))
  }
  for (const key of reported) {
    check(`diffEach report ${key} is a real change`, bruteChanged.has(key))
  }
  const arr = diff(prev, next)
  check('diff() mirrors diffEach cardinality', arr.length === reported.size, `${arr.length} vs ${reported.size}`)

  let seen = 0
  const earlyExited = diffEach(prev, next, () => {
    seen++
    return true
  })
  check('diffEach early-exit honored', earlyExited === true && seen === 1, `seen=${seen}`)
}

{
  const pools = makePools()
  const s = createScreen(8, 2, pools.style, pools.char, pools.link)

  setCellAt(s, 2, 0, wide('漢', pools.style.none))
  check('wide writes tail', cellAt(s, 3, 0)!.width === CellWidth.SpacerTail)
  setCellAt(s, 2, 0, narrow('a', pools.style.none))
  check('ghost tail cleared', cellAt(s, 3, 0)!.width === CellWidth.Narrow)
  checkSpacerConsistency('ghost-tail case', s)

  setCellAt(s, 4, 1, wide('値', pools.style.none))
  s.damage = undefined
  setCellAt(s, 5, 1, narrow('b', pools.style.none))
  check('orphan head cleared', charInCellAt(s, 4, 1) === ' ')
  check('orphan head in damage', inDamage(s, 4, 1), JSON.stringify(s.damage))
  checkSpacerConsistency('orphan-head case', s)

  const s2 = createScreen(8, 1, pools.style, pools.char, pools.link)
  setCellAt(s2, 1, 0, wide('漢', pools.style.none))
  setCellAt(s2, 0, 0, wide('本', pools.style.none))
  checkSpacerConsistency('wide-over-wide case', s2)

  const s3 = createScreen(4, 1, pools.style, pools.char, pools.link)
  setCellAt(s3, 3, 0, wide('漢', pools.style.none))
  check('right-edge wide kept', cellAt(s3, 3, 0)!.width === CellWidth.Wide)

  const s4 = createScreen(8, 1, pools.style, pools.char, pools.link)
  setCellAt(s4, 2, 0, wide('漢', pools.style.none))
  s4.damage = undefined
  setCellAt(s4, 2, 0, narrow('n', pools.style.none))
  check('ghost-tail repair in damage', inDamage(s4, 3, 0), JSON.stringify(s4.damage))
  const s5 = createScreen(8, 1, pools.style, pools.char, pools.link)
  setCellAt(s5, 1, 0, wide('漢', pools.style.none))
  s5.damage = undefined
  setCellAt(s5, 0, 0, wide('本', pools.style.none))
  check('displaced-wide orphan repair in damage', inDamage(s5, 2, 0), JSON.stringify(s5.damage))
}

{
  const pools = makePools()
  const red = pools.style.intern([{ type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }])
  const src = createScreen(10, 4, pools.style, pools.char, pools.link)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 9; x += 2) setCellAt(src, x, y, narrow(String.fromCharCode(97 + x + y), red))
  }
  setCellAt(src, 8, 1, wide('漢', red))
  src.softWrap[2] = 5
  src.noSelect[10 * 1 + 3] = 1

  const dstA = createScreen(10, 4, pools.style, pools.char, pools.link)
  blitRegion(dstA, src, 0, 0, 10, 4)
  let equal = true
  for (let i = 0; i < 10 * 4 * 2; i++) if (dstA.cells[i] !== src.cells[i]) equal = false
  check('blit full-width copies cells exactly', equal)
  check('blit carries noSelect', dstA.noSelect[13] === 1)
  check('blit carries softWrap', dstA.softWrap[2] === 5)

  const dstB = createScreen(14, 4, pools.style, pools.char, pools.link)
  blitRegion(dstB, src, 0, 0, 9, 4)
  check('blit strided: wide head copied', cellAt(dstB, 8, 1)!.width === CellWidth.Wide)
  check('blit strided: edge tail completed', cellAt(dstB, 9, 1)!.width === CellWidth.SpacerTail)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const a = cellAt(dstB, x, y)!
      const b = cellAt(src, x, y)!
      if (a.char !== b.char || a.styleId !== b.styleId) equal = false
    }
  }
  check('blit strided: region cells equal', equal)
  checkSpacerConsistency('blit strided dst', dstB)
}

{
  const pools = makePools()
  const s = createScreen(10, 3, pools.style, pools.char, pools.link)
  setCellAt(s, 2, 1, wide('漢', pools.style.none))
  setCellAt(s, 6, 1, wide('本', pools.style.none))
  for (let x = 0; x < 10; x++) setCellAt(s, x, 0, narrow('x', pools.style.none))
  s.damage = undefined

  clearRegion(s, 3, 1, 4, 1)
  check('clear empties inside', charInCellAt(s, 4, 1) === ' ' && charInCellAt(s, 6, 1) === ' ')
  check('clear cleans left orphan head', cellAt(s, 2, 1)!.width === CellWidth.Narrow)
  check('clear cleans right orphan tail', cellAt(s, 7, 1)!.width === CellWidth.Narrow)
  check('row 0 untouched', charInCellAt(s, 5, 0) === 'x')
  checkSpacerConsistency('after clear', s)
  const before = { x: 2, y: 1 }
  check('clear damage covers widened edges', inDamage(s, before.x, before.y) && inDamage(s, 7, 1), JSON.stringify(s.damage))
}

{
  const pools = makePools()
  const mk = (): Screen => {
    const s = createScreen(6, 6, pools.style, pools.char, pools.link)
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) setCellAt(s, x, y, narrow(String.fromCharCode(65 + y), pools.style.none))
      s.softWrap[y] = y
    }
    return s
  }

  const a = mk()
  shiftRows(a, 1, 4, 2)
  check('shiftRows up: row 1 ← old row 3', charInCellAt(a, 0, 1) === 'D')
  check('shiftRows up: row 2 ← old row 4', charInCellAt(a, 0, 2) === 'E')
  check('shiftRows up: vacated rows empty', charInCellAt(a, 0, 3) === ' ' && charInCellAt(a, 0, 4) === ' ')
  check('shiftRows up: outside rows kept', charInCellAt(a, 0, 0) === 'A' && charInCellAt(a, 0, 5) === 'F')
  check('shiftRows moves softWrap', a.softWrap[1] === 3 && a.softWrap[2] === 4)
  check('shiftRows clears vacated softWrap', a.softWrap[3] === 0 && a.softWrap[4] === 0)

  const b = mk()
  shiftRows(b, 1, 4, -1)
  check('shiftRows down: row 2 ← old row 1', charInCellAt(b, 0, 2) === 'B')
  check('shiftRows down: row 4 ← old row 3', charInCellAt(b, 0, 4) === 'D')
  check('shiftRows down: vacated top empty', charInCellAt(b, 0, 1) === ' ')

  const c = mk()
  shiftRows(c, 1, 3, 5)
  check('shiftRows over-span clears span', charInCellAt(c, 0, 1) === ' ' && charInCellAt(c, 0, 3) === ' ')
  check('shiftRows over-span keeps outside', charInCellAt(c, 0, 0) === 'A' && charInCellAt(c, 0, 4) === 'E')

  const d = mk()
  const beforeD = snapshot(d)
  shiftRect(d, 1, 4, 2, 4, 1)
  check('shiftRect: inside col shifted', charInCellAt(d, 2, 1) === 'C' && charInCellAt(d, 3, 3) === 'E')
  check('shiftRect: vacated inside cleared', charInCellAt(d, 2, 4) === ' ')
  let outsideIdentical = true
  for (let y = 0; y < 6; y++) {
    for (const x of [0, 1, 4, 5]) {
      const ci = (y * 6 + x) << 1
      if (d.cells[ci] !== beforeD.cells[ci] || d.cells[ci + 1] !== beforeD.cells[ci + 1]) outsideIdentical = false
    }
  }
  check('shiftRect: outside columns byte-identical', outsideIdentical)
  check('shiftRect: softWrap cleared on affected rows', d.softWrap[1] === 0 && d.softWrap[4] === 0)
  check('shiftRect: softWrap kept outside', d.softWrap[5] === 5)
}

{
  const pools = makePools()
  for (const ch of ['a', ' ', '', '漢', '👩‍👩‍👧‍👦', '⚔️']) {
    check(`charPool round-trip ${JSON.stringify(ch)}`, pools.char.get(pools.char.intern(ch)) === ch)
  }
  check('charPool stable ids', pools.char.intern('q') === pools.char.intern('q'))
  check('linkPool none is 0', pools.link.intern(undefined) === 0 && pools.link.get(0) === undefined)
  const lid = pools.link.intern('https://m.example/a')
  check('linkPool round-trip', pools.link.get(lid) === 'https://m.example/a')

  const fg = pools.style.intern([{ type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }])
  const bg = pools.style.intern([{ type: 'ansi', code: '\x1b[44m', endCode: '\x1b[49m' }])
  check('fg-only style has even id', (fg & 1) === 0)
  check('bg style has odd id', (bg & 1) === 1)

  const ids = [pools.style.none, fg, bg, pools.style.withInverse(fg)]
  for (const from of ids) {
    for (const to of ids) {
      const full = sgrStateOfStyleString(pools.style.transition(pools.style.none, to))
      const viaFrom = sgrStateOfStyleString(
        pools.style.transition(pools.style.none, from) + pools.style.transition(from, to),
      )
      check(
        `transition ${from}→${to} composes`,
        JSON.stringify(full) === JSON.stringify(viaFrom),
        `${JSON.stringify(full)} vs ${JSON.stringify(viaFrom)}`,
      )
    }
  }

  const inv = pools.style.withInverse(fg)
  check('withInverse idempotent', pools.style.withInverse(inv) === inv)
}

{
  const pools = makePools()
  const s = createScreen(8, 3, pools.style, pools.char, pools.link)
  const red = pools.style.intern([{ type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' }])
  setCellAt(s, 0, 0, narrow('m', red, 'https://m.example/a'))
  setCellAt(s, 2, 1, wide('漢', red))
  setCellAt(s, 5, 2, narrow('·', pools.style.none))
  const decoded = (scr: Screen): string =>
    JSON.stringify(
      Array.from({ length: scr.height }, (_, y) =>
        Array.from({ length: scr.width }, (_, x) => {
          const c = cellAt(scr, x, y)!
          return [c.char, c.styleId, c.width, c.hyperlink ?? null]
        }),
      ),
    )
  const beforeM = decoded(s)
  migrateScreenPools(s, new CharPool(), new HyperlinkPool())
  check('migration decodes identically', decoded(s) === beforeM)
}

if (failures > 0) {
  console.log(`\nnative-core screen contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core screen contract: green (${checks} checks)`)
