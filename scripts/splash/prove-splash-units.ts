#!/usr/bin/env bun
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

const SPLASH = join(import.meta.dir, '..', '..', 'assets', 'splash', 'mercury-splash.mjs')
const CORE = join(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs')
const src = readFileSync(SPLASH, 'utf8')
const pairSrc = src + '\n' + readFileSync(CORE, 'utf8')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const block = (name: string): string => {
  const m = pairSrc.match(new RegExp(`// SPLASH-${name}-START[\\s\\S]*?// SPLASH-${name}-END`))
  if (!m) throw new Error(`SPLASH-${name} markers missing from the splash pair`)
  return m[0]
}

section('§1 vis() — display columns, not UTF-16 code units (E1)')
const visExports = new Function(`${block('VIS')}\n return { vis, cpWidth };`)() as {
  vis: (s: string) => number
  cpWidth: (cp: number) => number
}
const { vis, cpWidth } = visExports
check('ASCII fast path', vis('New Session in repo') === 19)
check('box drawing counts 1 per cell', vis('╭─│╰╯┤') === 6)
check('SGR stripped', vis('\x1b[1;4m\x1b[38;2;1;2;3mhi\x1b[0m') === 2)
check('CJK wide counts 2 (魔法 = 4 cols, 2 units each... 2 code points)', vis('魔法') === 4)
check('mixed path: repo-魔法-x', vis('repo-魔法-x') === 11)
check('astral emoji counts 2, not its 2 UTF-16 units (🚀)', vis('🚀') === 2)
check('combining mark counts 0 (e + U+0301)', vis('e\u0301') === 1)
check('ZWJ counts 0', vis('a\u200db') === 2)
check('fullwidth forms count 2 (Ａ)', vis('Ａ') === 2)
check('Hangul syllable counts 2 (한)', vis('한') === 2)
check('cpWidth: CJK ideograph 2', cpWidth(0x4e00) === 2)
check('cpWidth: latin 1', cpWidth(0x61) === 1)
check('cpWidth: box drawing 1', cpWidth(0x2500) === 1)
check('cpWidth: CJK ext B (astral) 2', cpWidth(0x20000) === 2)

section('§2 clipVis — column-accurate clip (E1)')
const clipVis = new Function(
  `${block('VIS')}\n const R = '\\x1b[0m';\n ${block('CLIP')}\n return clipVis;`,
)() as (s: string, w: number) => string
check('short strings pass through', clipVis('abc', 10) === 'abc')
{
  const clipped = clipVis('abcdefghij', 5)
  check('ASCII clip: 4 cols + ellipsis', vis(clipped) === 5 && clipped.startsWith('abcd'))
}
{
  const clipped = clipVis('魔法使いの夜', 7)
  check('CJK clip never exceeds the budget', vis(clipped) <= 7, `vis=${vis(clipped)}`)
  check('CJK clip keeps whole characters + ellipsis', clipped === '魔法使…\x1b[0m', JSON.stringify(clipped))
}
{
  const clipped = clipVis('\x1b[31mab\x1b[0mcdef', 4)
  check('SGR sequences survive the clip intact', clipped.includes('\x1b[31m') && vis(clipped) <= 4)
}
{
  const clipped = clipVis('🚀🚀🚀🚀', 5)
  check('astral clip: surrogate pairs never split (well-formed result)', vis(clipped) <= 5 && clipped.replace(/\x1b\[[0-9;]*m/g, '').isWellFormed())
}

section('§3 the ESC coalescer (C1) — the state machine, deterministically')
const co = new Function(`${block('COALESCE')}\n return { isPartialEscape, coalesceStep };`)() as {
  isPartialEscape: (s: string) => boolean
  coalesceStep: (pending: string, chunk: string) => { dispatch: string | null; pending: string }
}
const { isPartialEscape, coalesceStep } = co
check('bare ESC is partial (waits)', isPartialEscape('\x1b'))
check('CSI prefix is partial', isPartialEscape('\x1b['))
check('SS3 prefix is partial', isPartialEscape('\x1bO'))
check('CSI with params still partial (\\x1b[1;5)', isPartialEscape('\x1b[1;5'))
check('complete arrow is NOT partial', !isPartialEscape('\x1b[A'))
check('complete SS3 key is NOT partial', !isPartialEscape('\x1bOP'))
check('kitty CSI-u is NOT partial (= breaks the param set)', !isPartialEscape('\x1b[=5;1u'))
check('mouse SGR is NOT partial', !isPartialEscape('\x1b[<0;10;5M'))
check('plain keys are NOT partial', !isPartialEscape('\r') && !isPartialEscape('m'))
{
  const s1 = coalesceStep('', '\x1b')
  check('split arrow, chunk 1: held (no ESC misfire)', s1.dispatch === null && s1.pending === '\x1b')
  const s2 = coalesceStep(s1.pending, '[A')
  check('split arrow, chunk 2: ONE arrow dispatched', s2.dispatch === '\x1b[A' && s2.pending === '')
}
{
  const s1 = coalesceStep('', '\x1b')
  const s2 = coalesceStep(s1.pending, '[1;5')
  check('three-way split: partial CSI still held', s2.dispatch === null && s2.pending === '\x1b[1;5')
  const s3 = coalesceStep(s2.pending, 'C')
  check('three-way split: final byte completes ctrl-arrow', s3.dispatch === '\x1b[1;5C')
}
check('whole arrow in one chunk dispatches immediately', coalesceStep('', '\x1b[B').dispatch === '\x1b[B')
check('enter dispatches immediately', coalesceStep('', '\r').dispatch === '\r')
check('ctrl-C dispatches immediately (cancel must never wait 15ms)', coalesceStep('', '\x03').dispatch === '\x03')
check('paste chunk dispatches whole (inertness preserved downstream)', coalesceStep('', 'line one\rline two\r').dispatch === 'line one\rline two\r')
check('bracketed-paste opener is not partial (dispatches whole)', coalesceStep('', '\x1b[200~hello\x1b[201~').dispatch !== null)
check('double-tap ESC in one window merges (documented C1 trade)', coalesceStep('\x1b', '\x1b').dispatch === '\x1b\x1b')
check('the 15ms timeout constant is the report value', src.includes('const ESC_TIMEOUT_MS = 15'))
check('C4: the handler decodes utf8, never latin1', src.includes("buf.toString('utf8')") && !src.includes("toString('latin1')"))

section('§4 readHead — the bounded head read (D1)')
const readHeadSrc = block('READHEAD')
const scratch = mkdtempSync(join(tmpdir(), 'splash-units-'))
try {
  const big = join(scratch, 'big.jsonl')
  const head = `${JSON.stringify({ cwd: '/Users/alice/projects/demo', sessionId: 'x'.repeat(64) })}\n`
  writeFileSync(big, head + 'z'.repeat(5_000_000))
  let bytesRequested = 0
  const countingReadSync = (fd: number, buf: Buffer, off: number, len: number, pos: number): number => {
    bytesRequested += len
    return readSync(fd, buf, off, len, pos)
  }
  const readHead = new Function(
    'openSync',
    'readSync',
    'closeSync',
    'Buffer',
    `${readHeadSrc}\n return readHead;`,
  )(openSync, countingReadSync, closeSync, Buffer) as (file: string, n?: number) => string
  const got = readHead(big)
  check('returns exactly the first 4096 bytes decoded', got.length === 4096 && got.startsWith(head.slice(0, 60)))
  check('the read is BOUNDED: ≤ 4096 bytes requested from a 5MB file (was: the whole file)', bytesRequested <= 4096, `requested=${bytesRequested}`)
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(got)
  check('the cwd regex still lands inside the head', m !== null && JSON.parse(`"${m[1]}"`) === '/Users/alice/projects/demo')
  const torn = join(scratch, 'torn.jsonl')
  writeFileSync(torn, 'a'.repeat(4095) + '魔魔魔')
  const gotTorn = readHead(torn)
  check('a torn multibyte tail decodes fail-soft (no throw)', gotTorn.length > 4090)
  check('the scan site consumes readHead, never a whole-file read', src.includes('const head = readHead(e.file)') && !src.includes("readFileSync(e.file, 'utf8').slice(0, 4096)"))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

section('§5 the basename mapping (B1) — node:path at all four sites')
{
  const seamSites = (src.match(/projectDisplayName\(process\.cwd\(\)\)/g) ?? []).length
  const bareSites = (src.match(/basename\(process\.cwd\(\)\) \|\| process\.cwd\(\)/g) ?? []).length
  check('the three process.cwd() sites route through the ruled naming seam', seamSites === 3 && bareSites === 0, `seam ${seamSites} · bare ${bareSites}`)
  check('the recent-project scan reads the project card (the catalog row)', src.includes("names.includes('project.json')") && src.includes('card = { dir: raw.dir, firstChatAt: raw.firstChatAt }'))
  check('the recent-project scan routes through the ruled naming seam', src.includes('base: projectDisplayName(cwd)'))
  check('the naming seam routes through node:path basename', src.includes('const projectDisplayName = dir =>') && src.includes('const base = basename(dir)'))
  check("no '/'-only basename split survives", !src.includes(".split('/').pop()"))
  check('the New Session clamp is 24-with-ellipsis (the Dir chip grammar)', pairSrc.includes("cwdBase.length > 24 ? cwdBase.slice(0, 23) + '…' : cwdBase"))
  check('win32 basename handles backslash paths', win32.basename('C:\\Users\\alice\\Desktop\\Warcraft III 1.26') === 'Warcraft III 1.26')
  check('win32 basename handles forward slashes too', win32.basename('C:/Users/alice/repo') === 'repo')
  check('win32 drive root yields empty ⇒ the || fallback shows the path', win32.basename('C:\\') === '')
  check('posix basename never splits a legal backslash filename', posix.basename('/home/x/weird\\name') === 'weird\\name')
  check('posix root yields empty ⇒ the || fallback shows the path', posix.basename('/') === '')
}

section('§6 cancel/idle wiring (C2/C5) — structural pins (behaviour: prove-splash.py)')
check('Ctrl-C routes through cancelExit (BM-30: every cancel leaves as exit 130)', src.includes("if (s === '\\x03') { cancelExit(); return }"))
check('SIGINT + SIGTERM cancel the boot', src.includes("process.on('SIGINT', cancelExit)") && src.includes("process.on('SIGTERM', cancelExit)"))
check('the idle timer cancels, never launches', src.includes('setTimeout(cancelExit, IDLE_MS)') && !src.includes('setTimeout(() => collapse(0), 30 * 60 * 1000)'))
check('cancelExit records the cancel receipt AND leaves through collapse(130)', src.includes("writeSplashAction('cancel')") && /function cancelExit\(\) \{[\s\S]*?collapse\(130\)\s*\n\}/.test(src))
check('collapse derives the exit-code contract (cancel→130, restored→20)', src.includes('if (cancelled) exitCode = 130') && src.includes("else if (code === 0 && screenAtExit === 'restored') exitCode = 20"))
check('both restoreAndBrand branches settle the screen fact for the funnel', src.includes("screenAtExit = 'held'") && src.includes("screenAtExit = 'restored'"))
check('the plain-text twin is never WRITTEN (BM-30, at the writer; the startup sweep may still delete leftovers)', !src.includes("writeFileSync(join(CONFIG_HOME, 'splash-action.txt')"))
check('every exit funnels through the draining collapse (D3)', src.includes("out.write('', bye)") && !/restoreAndBrand\(\)\n\s*process\.exit\(0\)/.test(src))

section('§7 resolveConfigFile ↔ runtime parity (K1 — the frozen-stale class)')
{
  const resolver = src.match(/function resolveConfigFile\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  check('resolveConfigFile exists in the splash', resolver.length > 0)
  const iDot = resolver.indexOf("'.config.json'")
  const iNative = resolver.indexOf("'.mercury.json'")
  check(
    'splash chain: .config.json → .mercury.json',
    iDot >= 0 && iNative > iDot,
    `${iDot}/${iNative}`,
  )
  check(
    'every monolith-reading chip routes through the resolver (theme + account)',
    (src.match(/readFileSync\(resolveConfigFile\(\), 'utf8'\)/g) ?? []).length >= 2,
  )
  check(
    "the health chip iterates the Mercury home ['.mercury']",
    src.includes("for (const projDir of ['.mercury'])"),
  )
  const envSrc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'env.ts'),
    'utf8',
  )
  const eDot = envSrc.indexOf("'.config.json'")
  const eNative = envSrc.indexOf('`.mercury${fileSuffixForOauthConfig()}.json`')
  check(
    'runtime owner expresses the same two-rung chain (env.ts getGlobalMercuryFile)',
    eDot >= 0 && eNative > eDot,
    `${eDot}/${eNative}`,
  )
}

section('§8 the card-tier strip bill (field return F3) — real rows, not padding')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const sevenRows = Array.from({ length: 7 }, (_, i) => ({ icon: 'x', label: `Row ${i}`, ctx: `ctx ${i}` }))
  const fiveRows = sevenRows.slice(0, 5)
  const chips = { model: 'Opus 5', critter: 'Jellyfish', critterHue: '#88ccdd', dir: 'projA', acct: { state: 'none' as const }, health: null }
  const compose = (cols: number, rows: number, cardRows: unknown[]) =>
    core.composeLockup(cols, rows, {
      cardRows,
      cardSel: 0,
      hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' }],
      tinyHint: '↵ start',
      stripLines: (w: number) => core.composeStrip(chips, w),
    } as never) as { lines: string[]; cardShown: boolean }
  const stripOf = (r: { lines: string[] }): boolean => r.lines.some(l => l.includes('Model'))
  const headOf = (r: { lines: string[] }): boolean => r.lines.length > 30
  const p120x40 = compose(120, 40, sevenRows)
  check('a populated seven-row card at 120x40 KEEPS the strip', p120x40.cardShown && stripOf(p120x40) && headOf(p120x40))
  check('…and the whole block still fits the terminal', p120x40.lines.length <= 40)
  const p100x30 = compose(100, 30, sevenRows)
  check('the same populated card at 100x30 keeps the strip (headless tier)', p100x30.cardShown && stripOf(p100x30) && !headOf(p100x30))
  const f120x40 = compose(120, 40, fiveRows)
  check('a fresh five-row card at 120x40 keeps the strip', f120x40.cardShown && stripOf(f120x40))
  const p120x38 = compose(120, 38, sevenRows)
  check('the ratified head-bare band stands: 120x38 keeps the art, sheds the strip', p120x38.cardShown && !stripOf(p120x38) && headOf(p120x38))
  const p80x24 = compose(80, 24, sevenRows)
  check('the 80x24 arrival is untouched (headless, strip shed)', p80x24.cardShown && !stripOf(p80x24) && !headOf(p80x24))
  const eightRows = Array.from({ length: 8 }, (_, i) => ({ icon: 'x', label: `Row ${i}`, ctx: `ctx ${i}` }))
  const e120x40 = compose(120, 40, eightRows)
  check('an eight-row card at 120x40 keeps head + card + strip and fills the terminal exactly', e120x40.cardShown && stripOf(e120x40) && headOf(e120x40) && e120x40.lines.length === 40, `lines=${e120x40.lines.length}`)
  const e100x30 = compose(100, 30, eightRows)
  check('an eight-row card at 100x30 keeps the strip (headless tier)', e100x30.cardShown && stripOf(e100x30) && !headOf(e100x30))
  const e120x38 = compose(120, 38, eightRows)
  check('an eight-row card at 120x38 stays head-bare (art kept, strip shed)', e120x38.cardShown && !stripOf(e120x38) && headOf(e120x38))
  const e80x24 = compose(80, 24, eightRows)
  check('an eight-row card at 80x24 stays the headless bare arrival (every action row survives)', e80x24.cardShown && !stripOf(e80x24) && !headOf(e80x24) && e80x24.lines.length <= 24)
  const e120x39 = compose(120, 39, eightRows)
  check('the measured band move: an eight-row card at 120x39 sheds the strip where seven rows kept it (the ladder, not a new law)', e120x39.cardShown && !stripOf(e120x39) && stripOf(compose(120, 39, sevenRows)))
  check('the card floor: eight rows need 22 terminal rows (21 keeps seven)', !compose(100, 21, eightRows).cardShown && compose(100, 21, sevenRows).cardShown && compose(100, 22, eightRows).cardShown)
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
    check(`every composed line fits ${cols} columns`, r.lines.every(l => strip(l).length <= cols), r.lines.map(l => `${strip(l).length}`).join(','))
    return strip(r.lines[0] ?? '')
  }
  check('at 24 columns the full tiny line stands (mark + word + hint)', tinyAt(24).includes('MERCURY') && tinyAt(24).includes('↵ start'))
  check('at 16 columns the hint sheds first — the wordmark survives', tinyAt(16).includes('MERCURY') && !tinyAt(16).includes('↵'))
  check('at 8 columns the mark alone stands — identity degrades last', tinyAt(8).includes('(>_)') && !tinyAt(8).includes('MERCURY'))
}

section('§10 the boot card clips its ctx column in DISPLAY cells')
{
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
  const compose = (ctx: string): string[] =>
    (core.composeLockup(120, 40, {
      cardRows: [
        { icon: '▸', label: 'New Session', ctx: 'fresh chat in this repo' },
        { icon: '↻', label: 'Continue Last Session', ctx },
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
  check('a wide-glyph ctx keeps every border glyph in ONE column', borderCols(cjk).size === 1, [...borderCols(cjk)].join(','))
  const ascii = compose('an extremely long ascii context sentence that must truncate with the ellipsis and never widen the card box at all')
  check('an over-long ascii ctx keeps the box square too', borderCols(ascii).size === 1)
  check('the truncation is named', ascii.some(l => l.includes('…')))
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
  check('AT the floor: no wants-line (byte-territory: the stills prover)', !at64x13.some(l => l.includes('wants at least')))
  const at60x12 = compose(60, 12)
  check('below the floor the classic OPERATES with the warn line', fits(at60x12, 60, 12) && at60x12.some(l => l.includes('wants at least 64×13 · this window is 60×12')) && at60x12.some(l => l.includes('❯')) && at60x12.some(l => l.includes('esc back')))
  const at110x11 = compose(110, 11)
  check('below the floor WIDE yields to classic+warn (one warn mechanism)', at110x11.some(l => l.includes('wants at least')) && fits(at110x11, 110, 11))
  const micro8 = compose(50, 8)
  check('the MICRO tier at 50×8: fits, warns, navigates, exits', fits(micro8, 50, 8) && micro8.some(l => l.includes('wants at least')) && micro8.some(l => l.includes('❯')) && micro8.some(l => l.includes('esc back')))
  const micro3 = compose(40, 3)
  check('at 3 rows: warn + ONE selected row + the legend — still functional', fits(micro3, 40, 3) && micro3.some(l => l.includes('❯')) && micro3[micro3.length - 1]!.includes('esc back'))
  const micro2 = compose(40, 2)
  check('at 2 rows: warn + the legend — never a lockout', fits(micro2, 40, 2) && micro2[1]!.includes('esc back'))
  check('the one-line tier sheds toward the EXIT (identity · esc · ↵ → identity · esc → esc alone)',
    compose(40, 1)[0] === '(>_) menu · esc back · ↵ cycles' && compose(24, 1)[0] === '(>_) menu · esc back' && compose(12, 1)[0] === 'esc back')
  check('no tier ever composes more lines than the window has rows (8→1)', [8, 6, 5, 4, 3, 2, 1].every(r => compose(46, r).length <= r))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SPLASH UNIT PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
