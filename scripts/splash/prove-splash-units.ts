#!/usr/bin/env bun
import { join } from 'node:path'


let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)


section('§1 vis() — display columns, not UTF-16 code units (E1)')
const core = await import('../../assets/splash/splash-core.mjs')
const vis = core.vis as (s: string) => number
const cpWidth = core.cpWidth as (cp: number) => number
check('ASCII fast path', vis('New Session in repo') === 19, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('box drawing counts 1 per cell', vis('╭─│╰╯┤') === 6, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('SGR stripped', vis('\x1b[1;4m\x1b[38;2;1;2;3mhi\x1b[0m') === 2, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('CJK wide counts 2 (魔法 = 4 cols, 2 units each... 2 code points)', vis('魔法') === 4, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('mixed path: repo-魔法-x', vis('repo-魔法-x') === 11, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('astral emoji counts 2, not its 2 UTF-16 units (🚀)', vis('🚀') === 2, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('combining mark counts 0 (e + U+0301)', vis('e\u0301') === 1, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('ZWJ counts 0', vis('a\u200db') === 2, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('fullwidth forms count 2 (Ａ)', vis('Ａ') === 2, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('Hangul syllable counts 2 (한)', vis('한') === 2, 'fix vis() in assets/splash/splash-core.mjs (width counts display columns)')
check('cpWidth: CJK ideograph 2', cpWidth(0x4e00) === 2, 'fix cpWidth() in assets/splash/splash-core.mjs')
check('cpWidth: latin 1', cpWidth(0x61) === 1, 'fix cpWidth() in assets/splash/splash-core.mjs')
check('cpWidth: box drawing 1', cpWidth(0x2500) === 1, 'fix cpWidth() in assets/splash/splash-core.mjs')
check('cpWidth: CJK ext B (astral) 2', cpWidth(0x20000) === 2, 'fix cpWidth() in assets/splash/splash-core.mjs')


section('§8 the card-tier strip bill (field return F3) — real rows, not padding')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const sevenRows = Array.from({ length: 7 }, (_, i) => ({ label: `Row ${i}`, ctx: `ctx ${i}` }))
  const fiveRows = sevenRows.slice(0, 5)
  const chips = { model: 'Opus 5', critter: 'Jellyfish', critterHue: '#88ccdd', dir: 'projA', acct: { state: 'none' as const }, health: null }
  const compose = (cols: number, rows: number, cardRows: unknown[]) =>
    core.composeLockup(cols, rows, {
      cardRows,
      cardSel: 0,
      hintSegments: [{ key: '↵', label: '', tone: 'ivory' }],
      tinyHint: '↵',
      stripLines: (w: number) => core.composeStrip(chips, w),
    } as never) as { lines: string[]; cardShown: boolean }
  const stripOf = (r: { lines: string[] }): boolean => r.lines.some(l => l.includes('Model'))
  const headOf = (r: { lines: string[] }): boolean => r.lines.length > 30
  const p120x40 = compose(120, 40, sevenRows)
  check('a populated seven-row card at 120x40 KEEPS the strip', p120x40.cardShown && stripOf(p120x40) && headOf(p120x40), 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  check('…and the whole block still fits the terminal', p120x40.lines.length <= 40, 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  const p100x30 = compose(100, 30, sevenRows)
  check('the same populated card at 100x30 keeps the strip (headless tier)', p100x30.cardShown && stripOf(p100x30) && !headOf(p100x30), 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  const f120x40 = compose(120, 40, fiveRows)
  check('a five-row card at 120x40 keeps head + card + one-line strip', f120x40.cardShown && stripOf(f120x40) && headOf(f120x40) && f120x40.lines.length === 35, `lines=${f120x40.lines.length} — fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)`)
  const p120x37 = compose(120, 37, sevenRows)
  check('with the one-line strip, a seven-row card keeps head + card + strip down to 120x37', p120x37.cardShown && stripOf(p120x37) && headOf(p120x37) && p120x37.lines.length === 37, `lines=${p120x37.lines.length} — fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)`)
  const p80x24 = compose(80, 24, sevenRows)
  check('with the one-line strip, 80x24 keeps the headless card + strip and 80x23 sheds the strip', p80x24.cardShown && stripOf(p80x24) && !headOf(p80x24) && !stripOf(compose(80, 23, sevenRows)), 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  const eightRows = Array.from({ length: 8 }, (_, i) => ({ label: `Row ${i}`, ctx: `ctx ${i}` }))
  const e120x40 = compose(120, 40, eightRows)
  check('an eight-row card at 120x40 keeps head + card + one-line strip (38 lines)', e120x40.cardShown && stripOf(e120x40) && headOf(e120x40) && e120x40.lines.length === 38, `lines=${e120x40.lines.length} — fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)`)
  const e100x30 = compose(100, 30, eightRows)
  check('an eight-row card at 100x30 keeps the strip (headless tier)', e100x30.cardShown && stripOf(e100x30) && !headOf(e100x30), 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  const e120x38 = compose(120, 38, eightRows)
  check('an eight-row card at 120x38 keeps head + card + one-line strip and fills the terminal exactly', e120x38.cardShown && stripOf(e120x38) && headOf(e120x38) && e120x38.lines.length === 38, `lines=${e120x38.lines.length} — fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)`)
  const e80x24 = compose(80, 24, eightRows)
  check('an eight-row card at 80x24 stays the headless bare arrival (every action row survives)', e80x24.cardShown && !stripOf(e80x24) && !headOf(e80x24) && e80x24.lines.length <= 24, 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  const e120x37 = compose(120, 37, eightRows)
  check('the measured band move: an eight-row card at 120x37 drops the head where seven rows kept it (the ladder, not a new law)', e120x37.cardShown && !headOf(e120x37) && stripOf(e120x37) && headOf(p120x37), 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
  check('the card floor: eight rows need 22 terminal rows (21 keeps seven)', !compose(100, 21, eightRows).cardShown && compose(100, 21, sevenRows).cardShown && compose(100, 22, eightRows).cardShown, 'fix composeLockup() in assets/splash/splash-core.mjs (card, strip and head tiers by terminal size)')
}

section('§9 the tiny tier never composes wider than the terminal')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
  const tinyAt = (cols: number): string => {
    const r = core.composeLockup(cols, 3, {
      cardRows: [],
      cardSel: 0,
      hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' }],
      tinyHint: '↵ start',
      stripLines: () => [],
    } as never) as { lines: string[] }
    check(`every composed line fits ${cols} columns`, r.lines.every(l => strip(l).length <= cols), r.lines.map(l => `${strip(l).length}`).join(',') + ' — fix the tiny tier of composeLockup() in assets/splash/splash-core.mjs')
    return strip(r.lines[0] ?? '')
  }
  check('at 24 columns the full tiny line stands (mark + word + hint)', tinyAt(24).includes('MERCURY') && tinyAt(24).includes('↵ start'), 'fix the tiny tier of composeLockup() in assets/splash/splash-core.mjs')
  check('at 16 columns the hint sheds first — the wordmark survives', tinyAt(16).includes('MERCURY') && !tinyAt(16).includes('↵'), 'fix the tiny tier of composeLockup() in assets/splash/splash-core.mjs')
  check('at 8 columns the mark alone stands — identity degrades last', tinyAt(8).includes('(>_)') && !tinyAt(8).includes('MERCURY'), 'fix the tiny tier of composeLockup() in assets/splash/splash-core.mjs')
}

section('§10 the boot card clips its ctx column in DISPLAY cells')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const compose = (ctx: string): string[] =>
    (core.composeLockup(120, 40, {
      cardRows: [
        { label: 'New Session', ctx: 'fresh chat in this repo' },
        { label: 'Continue Last Session', ctx },
      ],
      cardSel: 0,
      hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' }],
      tinyHint: '↵ start',
      stripLines: () => [],
    } as never) as { lines: string[] }).lines
  const { cpWidth, MARK_RE } = await import('../../assets/splash/splash-core.mjs')
  const displayCols = (s: string): number => {
    let n = 0
    for (const ch of s.replace(/\s+$/, '')) {
      n += MARK_RE.test(ch) ? 0 : cpWidth(ch.codePointAt(0)!)
    }
    return n
  }
  const borderCols = (lines: string[]): Set<number> => {
    const cols = new Set<number>()
    for (const l of lines) {
      if (!/[╭│╰]/.test(l)) continue
      cols.add(displayCols(l))
    }
    return cols
  }
  const cjk = compose('漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字')
  check('a wide-glyph ctx keeps every border glyph in ONE column', borderCols(cjk).size === 1, [...borderCols(cjk)].join(',') + ' — fix the ctx clipping of the card rows in composeLockup() in assets/splash/splash-core.mjs')
  const ascii = compose('an extremely long ascii context sentence that must truncate with the ellipsis and never widen the card box at all')
  check('an over-long ascii ctx keeps the box square too', borderCols(ascii).size === 1, 'fix the ctx clipping of the card rows in composeLockup() in assets/splash/splash-core.mjs')
  check('the truncation is named', ascii.some(l => l.includes('…')), 'fix the ctx clipping of the card rows in composeLockup() in assets/splash/splash-core.mjs')
}

section('§11 the boot-menu floor, as ratified: WARN, NEVER WALL')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const strip = (x: string): string => x.replace(/\x1b\[[0-9;]*m/g, '')
  const entries = Array.from({ length: 12 }, (_, i) => ({
    label: `Setting row ${i + 1}`,
    valueLabel: i % 3 === 0 ? 'default (off)' : 'on',
    valueIsDefault: i % 3 === 0,
    group: i < 6 ? 'trust' : 'memory',
    pinnedVal: null,
    inert: false,
    summary: `summary for row ${i + 1}`,
  }))
  const m = { entries, selIdx: 3, title: 'boot menu', legend: '↑↓ choose · ↵ cycle · s save · esc back' }
  const compose = (c: number, r: number): string[] =>
    ((core.composeBootMenu as (...a: unknown[]) => { lines: string[] })(c, r, m)).lines.map(strip)
  const fits = (lines: string[], c: number, r: number): boolean =>
    lines.length <= r && lines.every(l => l.length <= c)
  const at64x13 = compose(64, 13)
  check('AT the floor: no wants-line (byte-territory: the stills prover)', !at64x13.some(l => l.includes('wants at least')), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  const at60x12 = compose(60, 12)
  check('below the floor the classic OPERATES with the warn line', fits(at60x12, 60, 12) && at60x12.some(l => l.includes('wants at least 64×13 · this window is 60×12')) && at60x12.some(l => l.includes('❯')) && at60x12.some(l => l.includes('esc back')), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  const at110x11 = compose(110, 11)
  check('below the floor WIDE yields to classic+warn (one warn mechanism)', at110x11.some(l => l.includes('wants at least')) && fits(at110x11, 110, 11), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  const micro8 = compose(50, 8)
  check('the MICRO tier at 50×8: fits, warns, navigates, exits', fits(micro8, 50, 8) && micro8.some(l => l.includes('wants at least')) && micro8.some(l => l.includes('❯')) && micro8.some(l => l.includes('esc back')), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  const micro3 = compose(40, 3)
  check('at 3 rows: warn + ONE selected row + the legend — still functional', fits(micro3, 40, 3) && micro3.some(l => l.includes('❯')) && micro3[micro3.length - 1]!.includes('esc back'), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  const micro2 = compose(40, 2)
  check('at 2 rows: warn + the legend — never a lockout', fits(micro2, 40, 2) && micro2[1]!.includes('esc back'), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  check('the one-line tier sheds toward the EXIT (identity · esc · ↵ → identity · esc → esc alone)',
    compose(40, 1)[0] === '(>_) menu · esc back · ↵ cycles' && compose(24, 1)[0] === '(>_) menu · esc back' && compose(12, 1)[0] === 'esc back', 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
  check('no tier ever composes more lines than the window has rows (8→1)', [8, 6, 5, 4, 3, 2, 1].every(r => compose(46, r).length <= r), 'fix composeBootMenu() and its classic, micro and wide tiers in assets/splash/splash-core.mjs')
}

section('§Z the menu rows carry one env spelling each and the splash resolves a row by it alone')
{
  const rows = (core as { MENU?: Array<Record<string, unknown>> }).MENU ?? []
  check('the baked menu has rows', rows.length > 0, String(rows.length) + ' — the baked MENU in assets/splash/splash-core.mjs is empty or no longer exported by name')
  check('no baked row carries a second spelling', rows.every(r => !('legacy' in r)), rows.filter(r => 'legacy' in r).map(r => String(r.env)).join(',') + ' — remove the extra spelling key from the MENU row(s) listed in assets/splash/splash-core.mjs')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SPLASH UNIT PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
