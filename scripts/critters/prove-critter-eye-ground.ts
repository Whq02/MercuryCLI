#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-eye-ground-'))
mkdirSync(join(SCRATCH, 'config'), { recursive: true })
writeFileSync(join(SCRATCH, 'config', '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true }))
process.env.HOME = SCRATCH
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_TERMINAL_TITLE = '0'
process.env.MERCURY_WARM_BG = '0'
process.env.TERM = 'xterm-256color'
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_OASIS_BG
delete process.env.NODE_ENV

const React = await import('react')
const chalk = (await import('chalk')).default
const { enableConfigs } = await import(`${ROOT}/src/utils/config.js`)
enableConfigs()
const { render, Box, Text } = (await import(`${ROOT}/src/ink.js`)) as {
  render: (node: unknown, opts: Record<string, unknown>) => Promise<{ unmount: () => void }>
  Box: unknown
  Text: unknown
}
const { AlternateScreen } = await import(`${ROOT}/src/ink/components/AlternateScreen.js`)
const { default: useInput } = await import(`${ROOT}/src/ink/hooks/use-input.js`)
const { AnimatedCritterArt } = await import(`${ROOT}/src/components/mercury-ui/AnimatedCritterArt.js`)
const { cellColor, CRITTERS, SQUARE_DOCK_ART_LINES, SLEEP_CELL } = await import(`${ROOT}/src/utils/cockpit/critterData.js`)
type CritterDef = (typeof CRITTERS)[number]
const { composeCritterFrame } = await import(`${ROOT}/src/components/mercury-ui/CritterArt.js`)
const owner = (await import(`${ROOT}/src/utils/cockpit/oasisBg.js`)) as Record<string, unknown>
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

section('§0 the ground owner carries ONE typed reader of the ground now and ONE subscription')
const terminalGround = owner.terminalGround as (() => { state: string; color?: string }) | undefined
const subscribeTerminalGround = owner.subscribeTerminalGround as ((l: () => void) => () => void) | undefined
const resetGround = owner._resetGroundForTest as () => void
const markQuerySent = owner.markOriginalGroundQuerySent as () => void
const noteReply = owner.noteOriginalGroundReply as (spec: string, write: (s: string) => void) => void
const syncToTheme = owner.syncOasisBgToTheme as (theme: string, write: (s: string) => void) => void
const exitGround = owner.exitOasisBg as (write: (s: string) => void) => void
check('oasisBg exports terminalGround()', typeof terminalGround === 'function')
check('oasisBg exports subscribeTerminalGround()', typeof subscribeTerminalGround === 'function')
if (typeof terminalGround !== 'function' || typeof subscribeTerminalGround !== 'function') {
  console.log(`\n❌ EYE-GROUND RED — ${checks - failures}/${checks} checks (no ground reader on the owner: the painter cannot know the ground)`)
  process.exit(1)
}
const wire: string[] = []
const sink = (s: string): void => {
  wire.push(s)
}
resetGround()
check('fresh owner: the ground is unknown', terminalGround().state === 'unknown', JSON.stringify(terminalGround()))
let notified = 0
const unsubscribe = subscribeTerminalGround(() => {
  notified++
})
markQuerySent()
noteReply('rgb:1111/2222/3333', sink)
check('the warm road (an OSC 11 reply while unpainted) paints the canvas: state painted, the NIGHT hex', terminalGround().state === 'painted' && terminalGround().color === '#0d181b', JSON.stringify(terminalGround()))
check('…and the subscription fired', notified >= 1, `notified ${notified}`)
exitGround(sink)
check('after the exit restore the ground is the terminal\'s ORIGINAL, normalised from the rgb:/16-bit reply to a hex', terminalGround().state === 'original' && terminalGround().color === '#112233', JSON.stringify(terminalGround()))
resetGround()
markQuerySent()
noteReply('not-a-colour', sink)
check('a reply the XParseColor grammar cannot read never becomes a colour: the canvas is painted (NIGHT) and the original stays unknown after release', terminalGround().state === 'painted' && (exitGround(sink), terminalGround().state === 'unknown'), JSON.stringify(terminalGround()))
unsubscribe()
resetGround()
const notifiedBefore = notified
markQuerySent()
noteReply('rgb:0000/0000/0000', sink)
check('an unsubscribed listener is not called', notified === notifiedBefore, `notified ${notified} vs ${notifiedBefore}`)
resetGround()

const DOCKS = CRITTERS.map(def => ({ def, cols: Math.max(...def.squareDock.map(r => r.length)) }))
const GAP = 1
const ART_TOP = 1
const ART_LEFT = 2
const lefts: number[] = []
{
  let x = ART_LEFT
  for (const dock of DOCKS) {
    lefts.push(x)
    x += dock.cols + GAP
  }
}
const COLS = lefts[lefts.length - 1]! + DOCKS[DOCKS.length - 1]!.cols + 2
const ROWS = 8

class FakeStdout extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  chunks: string[] = []
  write(chunk: string | Buffer, enc?: unknown, cb?: () => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    if (typeof enc === 'function') (enc as () => void)()
    else cb?.()
    return true
  }
}
const stdout = new FakeStdout()
const stderr = new FakeStdout()
const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream

function forGlass(bytes: string): string {
  return bytes
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[<>=][0-9;:]*[A-Za-z]/g, '')
    .replace(/\x1b\[\?[0-9;]*\$p/g, '')
    .replace(/\x1b\[\?[0-9;]*[nu]/g, '')
    .replace(/\x1b\[[0-9;]*[cn]/g, '')
    .replace(/\x1b\[[0-9;]* q/g, '')
    .replace(/\x1b\[!p/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\x1b\([0-9A-B]/g, '')
    .replace(/\x1b\][0-9;]*[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}
const glass = new AnsiEmulator(COLS, ROWS, true)
let fed = 0
let glassFault = ''
function flushGlass(): void {
  if (fed >= stdout.chunks.length) return
  const bytes = stdout.chunks.slice(fed).join('')
  fed = stdout.chunks.length
  try {
    glass.feed(forGlass(bytes))
  } catch (e) {
    glassFault ||= e instanceof Error ? e.message : String(e)
  }
}

const rgb = (hex: string): string => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)!
  return `${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}`
}

const h = React.createElement as (...a: unknown[]) => unknown
function RawModeHolder(): null {
  useInput(() => {})
  return null
}
const tree = h(
  AlternateScreen as never,
  { mouseTracking: false },
  h(
    Box as never,
    { flexDirection: 'column', width: COLS, height: ROWS },
    h(Text as never, {}, 'above the critters'),
    h(
      Box as never,
      { flexDirection: 'row' },
      h(Text as never, {}, ' '.repeat(ART_LEFT)),
      ...DOCKS.flatMap((dock, i) => [
        h(
          Box as never,
          { key: dock.def.name, width: dock.cols, height: SQUARE_DOCK_ART_LINES, flexDirection: 'column', overflow: 'hidden', flexShrink: 0 },
          h(AnimatedCritterArt as never, { def: dock.def, square: true }),
        ),
        ...(i < DOCKS.length - 1 ? [h(Text as never, { key: `gap${i}` }, ' '.repeat(GAP))] : []),
      ]),
    ),
    h(Text as never, {}, 'below the critters'),
    h(RawModeHolder as never, {}),
  ),
)

const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function awaitGlass(pred: () => boolean, budgetTicks = 150): Promise<boolean> {
  for (let i = 0; i < budgetTicks; i++) {
    flushGlass()
    if (pred()) return true
    await settle(20)
  }
  flushGlass()
  return pred()
}

type CellRead = { x: number; y: number; c: number; line: number; kind: 'pair' | 'top' | 'bottom' | 'empty'; top: string | undefined; bot: string | undefined; above: boolean; below: boolean; eye: boolean; underEye: boolean; underline: boolean; ch: string; fg: string; bg: string }
const inkedAt = (def: CritterDef, art: string[], r: number, c: number): boolean => {
  const ch = art[r]?.[c]
  return ch !== undefined && ch !== SLEEP_CELL && Boolean(cellColor(def, ch))
}
function readSprite(index: number): CellRead[] {
  const { def, cols } = DOCKS[index]!
  const art = composeCritterFrame(def, { square: true }).art
  const out: CellRead[] = []
  for (let r = 0; r + 1 < art.length; r += 2) {
    const y = ART_TOP + (r >> 1)
    for (let c = 0; c < cols; c++) {
      const top = cellColor(def, art[r]![c])
      const bot = cellColor(def, art[r + 1]![c])
      const x = lefts[index]! + c
      const st = glass.styleAt(x, y)
      const kind = top && bot ? 'pair' : top ? 'top' : bot ? 'bottom' : 'empty'
      out.push({ x, y, c, line: r >> 1, kind, top, bot, above: r > 0 && inkedAt(def, art, r - 1, c), below: inkedAt(def, art, r + 2, c), eye: /[EKP]/.test((art[r]?.[c] ?? '.') + (art[r + 1]?.[c] ?? '.')), underEye: /[EKP]/.test(def.squareDock[r - 1]?.[c] ?? '.'), underline: st?.underline ?? false, ch: glass.grid[y]![x]!, fg: st?.fg ?? 'default', bg: st?.bg ?? 'default' })
    }
  }
  return out
}
const show = (cells: CellRead[]): string => cells.map(k => `${DOCKS.findIndex(d => lefts[DOCKS.indexOf(d)] === k.x - k.c)}:${k.c},${k.line}${k.above ? '^' : ''}${k.below ? '' : '_'}:${k.ch}[fg ${k.fg} bg ${k.bg}]`).join(' ')
const pairShape = (k: CellRead): boolean =>
  k.below || k.underEye
    ? k.ch === '▄' && k.fg === `38;2;${rgb(k.bot!)}` && k.bg === `48;2;${rgb(k.top!)}` && k.underline === k.underEye
    : k.ch === '▀' && k.fg === `38;2;${rgb(k.top!)}` && k.bg === `48;2;${rgb(k.bot!)}` && !k.underline
const baseShape = (k: CellRead): boolean =>
  k.kind === 'pair' ? pairShape(k)
  : k.kind === 'top' ? k.ch === '▀' && k.fg === `38;2;${rgb(k.top!)}` && k.bg === 'default'
  : k.kind === 'bottom' ? k.ch === '▄' && k.fg === `38;2;${rgb(k.bot!)}` && k.bg === 'default'
  : k.ch === ' '
const groundShape = (ground: string) => (k: CellRead): boolean =>
  k.kind === 'pair' ? pairShape(k)
  : k.kind === 'top'
    ? k.underEye || (k.above && k.below)
      ? k.ch === '▄' && k.fg === `38;2;${rgb(ground)}` && k.bg === `48;2;${rgb(k.top!)}` && k.underline === k.underEye
      : k.ch === '▀' && k.fg === `38;2;${rgb(k.top!)}` && k.bg === `48;2;${rgb(ground)}`
  : k.kind === 'bottom' ? k.ch === '▄' && k.fg === `38;2;${rgb(k.bot!)}` && k.bg === `48;2;${rgb(ground)}`
  : k.ch === ' '
const bottomEdge = (k: CellRead): boolean => k.kind !== 'empty' && !k.below
const wearsTopAsBackground = (k: CellRead): boolean => k.top !== undefined && k.top !== k.bot && k.bg === `48;2;${rgb(k.top)}`
const eyeLine = (cells: CellRead[]): CellRead[] => cells.filter(k => k.eye)
const snapshot = (cells: CellRead[]): string => cells.map(k => `${k.ch}|${k.fg}|${k.bg}|${k.underline}`).join('\n')

const instance = await render(tree, { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false })
await awaitGlass(() => glass.rowText(0).includes('above the critters') && DOCKS.every((_, i) => readSprite(i).some(k => k.kind === 'pair' && k.ch === '▄')))

section('§1 the ground UNKNOWN: a painted-top cell is ▀ on the default background, a painted-bottom cell ▄ on it (never a guessed colour); a pair with a painted pixel below it is ▄ with the top colour as its background, a pair on the bottom edge ▀ with the bottom colour as its background')
{
  check('the four docks reached the glass', DOCKS.every((_, i) => readSprite(i).some(k => k.ch === '▄')), `fault=${glassFault}`)
  for (let i = 0; i < DOCKS.length; i++) {
    const cells = readSprite(i)
    const bad = cells.filter(k => !baseShape(k))
    const singles = cells.filter(k => k.kind === 'top' || k.kind === 'bottom')
    check(`${DOCKS[i]!.def.name}: ${cells.length} cells read the base shape (${singles.length} single-colour halves on the default ground, ${cells.filter(bottomEdge).length} cells on the bottom edge)`, bad.length === 0, show(bad.slice(0, 6)))
  }
  const crab = readSprite(0)
  const underEyes = crab.filter(k => k.line === 2 && k.kind === 'top')
  check('the crab\'s line under the eyes carries four painted-top cells at grid cols 2/4/6/8 on the sprite\'s bottom edge — ▀, the ▀ glyph starting 8 px below the cell\'s top on Apple Terminal, so the ground shows under each eye-white there (the .27/.28 look)', underEyes.map(k => k.c).join(',') === '2,4,6,8' && underEyes.every(k => k.ch === '▀' && !k.below), show(underEyes))
}
const eyeBefore = DOCKS.map((_, i) => snapshot(eyeLine(readSprite(i))))

section('§2 the ground becomes KNOWN while the critters stand (the product\'s own road: the OSC 11 reply paints the canvas): every single-colour half repaints with the ground named in its empty half — no default background on a painted cell; a cell with a painted pixel below it is never ▀')
{
  const paintMark = stdout.chunks.length
  markQuerySent()
  noteReply('rgb:0000/0000/0000', sink)
  const GROUND = terminalGround().color!
  check('the owner reports the painted canvas', terminalGround().state === 'painted' && GROUND === '#0d181b', JSON.stringify(terminalGround()))
  const repainted = await awaitGlass(() => DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'top' || k.kind === 'bottom').every(k => k.bg !== 'default')))
  check('the mounted sprites repainted on the owner\'s notice without any prop changing', repainted && stdout.chunks.length > paintMark, `chunks +${stdout.chunks.length - paintMark}`)
  for (let i = 0; i < DOCKS.length; i++) {
    const cells = readSprite(i)
    const bad = cells.filter(k => !groundShape(GROUND)(k))
    check(`${DOCKS[i]!.def.name}: the cells beneath the eyes use lower blocks with their bottom row sealed; every other cell keeps the known-ground shape`, bad.length === 0, show(bad.slice(0, 6)))
    const painted = cells.filter(k => k.kind !== 'empty')
    check(`${DOCKS[i]!.def.name}: no painted cell carries the default background, no cell with a painted pixel below it is ▀, and no cell on the bottom edge carries the top colour as its background`, painted.every(k => k.bg !== 'default' && !(k.below && k.ch === '▀') && !(bottomEdge(k) && wearsTopAsBackground(k) && !k.underline)), show(painted.filter(k => k.bg === 'default' || (k.below && k.ch === '▀') || (bottomEdge(k) && wearsTopAsBackground(k) && !k.underline)).slice(0, 6)))
    check(`${DOCKS[i]!.def.name}: the eye line is byte-identical to the unknown-ground frame (the four-eyes law stands: every eye cell a pair)`, snapshot(eyeLine(cells)) === eyeBefore[i], snapshot(eyeLine(cells)))
  }
  const crab = readSprite(0)
  const underEyes = crab.filter(k => k.line === 2 && k.c % 2 === 0 && k.c >= 2 && k.c <= 8)
  check('the crab\'s four cells under the eye-whites join the body without a notch and seal their lower edge in the ground colour', underEyes.every(k => k.underEye && k.underline && groundShape(GROUND)(k)), show(underEyes))
  const clam = readSprite(3)
  check('the clam (no single-colour half in its dock) is byte-identical in both states', clam.every(k => baseShape(k) && groundShape(GROUND)(k)), show(clam.filter(k => !baseShape(k)).slice(0, 4)))
}

section('§2b the exact eye cells AND their lower neighbours: no top notch and no bottom fringe; other bottom-edge cells keep their shape')
{
  const GROUND = terminalGround().color!
  const crab = readSprite(0)
  const last = crab.filter(k => k.line === 2 && k.kind !== 'empty')
  const legs = last.filter(k => k.kind === 'pair')
  const gaps = last.filter(k => k.kind === 'top')
  check('the crab\'s last line is its bottom edge: five leg pairs at the odd columns and four gaps between them, nothing painted below any of them', legs.map(k => k.c).join(',') === '1,3,5,7,9' && gaps.map(k => k.c).join(',') === '2,4,6,8' && last.every(k => !k.below), show(last))
  check('the three leg cells outside the eyes stay upper blocks with body foreground and leg background', legs.filter(k => !k.underEye).map(k => k.c).join(',') === '1,5,9' && legs.filter(k => !k.underEye).every(pairShape), show(legs))
  check('the four gaps beneath the crab eye-whites are lower blocks with body background, ground foreground and a ground underline sealing the bottom row', gaps.every(k => k.underEye && k.underline && groundShape(GROUND)(k)), show(gaps))
  for (let i = 0; i < DOCKS.length; i++) {
    const cells = readSprite(i)
    const edge = cells.filter(k => bottomEdge(k) && !k.underEye)
    check(`${DOCKS[i]!.def.name}: ${edge.length} other bottom-edge cells keep the top colour out of their background`, edge.length > 0 && edge.every(k => !wearsTopAsBackground(k) && !k.underline), show(edge))
    const eyes = eyeLine(cells)
    check(`${DOCKS[i]!.def.name}: all six authored eye cells keep their glyph and both colours, with no underline`, eyes.map(k => `${k.c},${k.line}`).join(' ') === '2,1 3,1 4,1 6,1 7,1 8,1' && eyes.every(k => k.ch === '▄' && pairShape(k) && !k.underline), show(eyes))
    const under = cells.filter(k => k.underEye)
    check(`${DOCKS[i]!.def.name}: line 2 beneath the eyes at columns 2,3,4,6,7,8 is lower-block, top-colour background, lower-colour foreground and underline`, under.map(k => `${k.c},${k.line}`).join(' ') === '2,2 3,2 4,2 6,2 7,2 8,2' && under.every(k => k.ch === '▄' && k.bg === `48;2;${rgb(k.top!)}` && k.fg === `38;2;${rgb(k.bot ?? GROUND)}` && k.underline), show(under))
  }
}

section('§3 the ground CHANGES: a dark ⇄ true-black switch repaints the half cells with the new canvas; the exit restore hands the painter the terminal\'s original')
{
  const stdoutProto = process.stdout as unknown as { isTTY: boolean | undefined }
  const wasTTY = stdoutProto.isTTY
  resetGround()
  stdoutProto.isTTY = true
  try {
    syncToTheme('true-black', sink)
  } finally {
    stdoutProto.isTTY = wasTTY
  }
  check('the theme sync painted the true-black canvas', terminalGround().state === 'painted' && terminalGround().color === '#000000', JSON.stringify(terminalGround()))
  const black = await awaitGlass(() => DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'top' || k.kind === 'bottom').every(groundShape('#000000'))))
  check('every single-colour half of every critter now names #000000 as its ground half', black, show(readSprite(0).filter(k => (k.kind === 'top' || k.kind === 'bottom') && !groundShape('#000000')(k)).slice(0, 6)))
  stdoutProto.isTTY = true
  try {
    syncToTheme('dark', sink)
  } finally {
    stdoutProto.isTTY = wasTTY
  }
  const night = await awaitGlass(() => DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'top' || k.kind === 'bottom').every(groundShape('#0d181b'))))
  check('…and back to the oasis NIGHT on the dark sync', night, show(readSprite(0).filter(k => (k.kind === 'top' || k.kind === 'bottom') && !groundShape('#0d181b')(k)).slice(0, 6)))
  resetGround()
  markQuerySent()
  noteReply('rgb:1111/2222/3333', sink)
  exitGround(sink)
  check('the owner reports the original after the exit restore', terminalGround().state === 'original' && terminalGround().color === '#112233', JSON.stringify(terminalGround()))
  const original = await awaitGlass(() => DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'top' || k.kind === 'bottom').every(groundShape('#112233'))))
  check('the original reaches the painter: every single-colour half names #112233', original, show(readSprite(1).filter(k => (k.kind === 'top' || k.kind === 'bottom') && !groundShape('#112233')(k)).slice(0, 6)))
  resetGround()
  const back = await awaitGlass(() => DOCKS.every((_, i) => readSprite(i).every(baseShape)))
  check('the ground forgotten: the base shape again, cell for cell', back, show(readSprite(0).filter(k => !baseShape(k)).slice(0, 6)))
}

section('§4 colour OFF: the glyph is the only shape left, so a known ground changes nothing — the painted-top cell stays ▀')
{
  const level = chalk.level
  chalk.level = 0
  try {
    markQuerySent()
    noteReply('rgb:0000/0000/0000', sink)
    check('the canvas is painted while colour is off', terminalGround().state === 'painted', JSON.stringify(terminalGround()))
    await settle(400)
    flushGlass()
    check('with chalk at level 0 and the canvas painted, every painted-top cell is still ▀ and every painted-bottom cell still ▄', DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'top').every(k => k.ch === '▀') && readSprite(i).filter(k => k.kind === 'bottom').every(k => k.ch === '▄')), show(readSprite(0).filter(k => (k.kind === 'top' && k.ch !== '▀') || (k.kind === 'bottom' && k.ch !== '▄'))))
    check('…and a pair keeps its glyph by what sits below it: ▄ with a painted pixel below, ▀ on the bottom edge', DOCKS.every((_, i) => readSprite(i).filter(k => k.kind === 'pair').every(k => k.ch === (k.below || k.underEye ? '▄' : '▀'))), show(readSprite(0).filter(k => k.kind === 'pair' && k.ch !== (k.below || k.underEye ? '▄' : '▀'))))
  } finally {
    chalk.level = level
    resetGround()
  }
}
check('the glass replay raised no vocabulary fault', glassFault === '', glassFault)

instance.unmount()
await settle(50)
console.log(`\n${failures === 0 ? '✅' : '❌'} EYE-GROUND ${failures === 0 ? 'GREEN' : 'RED'} — ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
