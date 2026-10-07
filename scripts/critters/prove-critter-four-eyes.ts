#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-four-eyes-'))
mkdirSync(join(SCRATCH, 'config'), { recursive: true })
writeFileSync(join(SCRATCH, 'config', '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true }))
process.env.HOME = SCRATCH
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_CRITTER_IDLE = '1'
process.env.MERCURY_CRITTER_GAZE = '1'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_TERMINAL_TITLE = '0'
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
delete process.env.MERCURY_CRITTER
delete process.env.NODE_ENV

const React = await import('react')
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
const { cellColor, critterDefForKey, EYE_BG, SQUARE_DOCK_ART_LINES } = await import(`${ROOT}/src/utils/cockpit/critterData.js`)
const { composeCritterFrame } = await import(`${ROOT}/src/components/mercury-ui/CritterArt.js`)
const { BLINK_CYCLE, LID_MS, SECOND_LID_AT } = await import(`${ROOT}/src/utils/cockpit/critterIdle.js`)
const { heroEyeClusters } = await import(`${ROOT}/src/utils/cockpit/critterGaze.js`)
const { setMotionPosture } = await import(`${ROOT}/src/utils/cockpit/motionGovernor.js`)
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const COLS = 40
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
const push = (s: string): void => {
  ;(stdin as unknown as Readable).push(s)
}

let frames = 0
const onFrame = (): void => {
  frames++
}

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
const bytesSince = (mark: number): string => stdout.chunks.slice(mark).join('')
function touchedBy(bytes: string): Set<string> {
  const emu = new AnsiEmulator(COLS, ROWS, true)
  emu.feed(forGlass(bytes))
  const touched = new Set<string>()
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (emu.styleAt(x, y) !== null || emu.grid[y]![x] !== ' ') touched.add(`${x},${y}`)
  return touched
}

const rgb = (hex: string): string => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)!
  return `${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}`
}
const def = critterDefForKey('crab')
const CREAM = rgb(EYE_BG)
const PUPIL = rgb(cellColor(def, 'K')!)
const LID = rgb(cellColor(def, 'm')!)
const clusters = heroEyeClusters(def.squareDock)
const restCols = clusters.map(cl => cl.rest.c)
const restRow = clusters[0]!.rest.r
const ART_TOP = 1
const ART_LEFT = 2
const eyeLine = ART_TOP + (restRow >> 1)
const fx = clusters.reduce((s, cl) => s + cl.cx, 0) / clusters.length

const h = React.createElement as (...a: unknown[]) => unknown
function RawModeHolder(): null {
  useInput(() => {})
  return null
}
const tree = h(
  AlternateScreen as never,
  { mouseTracking: true },
  h(
    Box as never,
    { flexDirection: 'column', width: COLS, height: ROWS },
    h(Text as never, {}, 'above the critter'),
    h(
      Box as never,
      { flexDirection: 'row' },
      h(Text as never, {}, '  '),
      h(
        Box as never,
        { width: Math.max(...def.squareDock.map(r => r.length)), height: SQUARE_DOCK_ART_LINES, flexDirection: 'column', overflow: 'hidden', flexShrink: 0 },
        h(AnimatedCritterArt as never, { def, square: true }),
      ),
    ),
    h(Text as never, {}, 'below the critter'),
    h(RawModeHolder as never, {}),
  ),
)

const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function halves(x: number): { ch: string; top: string; bottom: string } {
  const ch = glass.grid[eyeLine]![x]!
  const st = glass.styleAt(x, eyeLine)
  const fg = st?.fg ?? 'default'
  const bg = st?.bg ?? 'default'
  const name = (v: string, prefix: string): string => {
    if (v === `${prefix};2;${CREAM}`) return 'cream'
    if (v === `${prefix};2;${PUPIL}`) return 'pupil'
    if (v === `${prefix};2;${LID}`) return 'lid'
    return v
  }
  if (ch === '▀') return { ch, top: name(fg, '38'), bottom: name(bg, '48') }
  if (ch === '▄') return { ch, top: name(bg, '48'), bottom: name(fg, '38') }
  return { ch, top: name(fg, '38'), bottom: name(bg, '48') }
}
const eyeRow = (): string =>
  clusters
    .map(cl => cl.cells.filter(c => c.r === restRow).map(c => c.c).sort((a, b) => a - b).map(c => {
      const hv = halves(ART_LEFT + c)
      return `${c}:${hv.ch}[${hv.top}/${hv.bottom}]`
    }).join(' '))
    .join(' | ')
const pupilsAt = (where: 'top' | 'bottom'): boolean =>
  restCols.every(c => {
    const hv = halves(ART_LEFT + c)
    return where === 'top' ? hv.top === 'pupil' && hv.bottom === 'cream' : hv.bottom === 'pupil' && hv.top === 'cream'
  })
const anyLid = (): boolean => restCols.some(c => {
  const hv = halves(ART_LEFT + c)
  return hv.top === 'lid' || hv.bottom === 'lid'
})

async function awayFromLid(): Promise<void> {
  for (;;) {
    const phase = Date.now() % BLINK_CYCLE
    if (phase > SECOND_LID_AT + LID_MS + 400 && phase < BLINK_CYCLE - 900) return
    await settle(50)
  }
}

async function awaitGlass(pred: () => boolean, budgetTicks = 150): Promise<boolean> {
  for (let i = 0; i < budgetTicks; i++) {
    flushGlass()
    if (pred()) return true
    await settle(20)
  }
  flushGlass()
  return pred()
}

setMotionPosture('full')
const instance = await render(tree, { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false, onFrame })
await awaitGlass(() => glass.rowText(0).includes('above the critter') && glass.rowText(eyeLine).includes('▀'))

section('§1 the authored rest frame reaches the glass: every pupil in the lower half of its eye cell')
await awayFromLid()
const restOk = await awaitGlass(() => pupilsAt('bottom'))
check('the critter is on the glass with its pupils at rest (lower half)', restOk, `${eyeRow()} fault=${glassFault}`)
if (!restOk) {
  console.log(stderr.chunks.join('').slice(0, 1500))
}

section('§1b THE FOUR EYES AT REST — a cell\'s background is its UPPER half\'s colour, so the gap Apple Terminal leaves above a half-block glyph never shows the pupil')
{
  const restStyle = restCols.map(c => {
    const st = glass.styleAt(ART_LEFT + c, eyeLine)
    return { ch: glass.grid[eyeLine]![ART_LEFT + c]!, fg: st?.fg ?? 'default', bg: st?.bg ?? 'default' }
  })
  check('each pupil cell at rest carries the CREAM (upper half) as its background and the pupil as its foreground glyph ▄', restStyle.every(s => s.ch === '▄' && s.bg === `48;2;${CREAM}` && s.fg === `38;2;${PUPIL}`), restStyle.map(s => `${s.ch} fg=${s.fg} bg=${s.bg}`).join(' | '))
  check('no pupil cell at rest has the pupil colour as its background (the sliver above the glyph would be a second pupil)', restStyle.every(s => s.bg !== `48;2;${PUPIL}`), restStyle.map(s => s.bg).join(' '))
  const composed = composeCritterFrame(def, { square: true }).art
  const asRgb = (hex: string | undefined): string | undefined => (hex === undefined ? undefined : rgb(hex))
  const faults: string[] = []
  const edgeFaults: string[] = []
  let twoColour = 0
  let edge = 0
  for (let r = 0; r + 1 < composed.length; r += 2) {
    const y = ART_TOP + (r >> 1)
    for (let c = 0; c < composed[r]!.length; c++) {
      const top = asRgb(cellColor(def, composed[r]![c]))
      const bot = asRgb(cellColor(def, composed[r + 1]![c]))
      if (top === undefined || bot === undefined) continue
      const x = ART_LEFT + c
      const st = glass.styleAt(x, y)
      const ch = glass.grid[y]![x]!
      if (cellColor(def, composed[r + 2]?.[c]) === undefined) {
        edge++
        if (ch !== '▀' || st?.fg !== `38;2;${top}` || st?.bg !== `48;2;${bot}`) edgeFaults.push(`${x},${y}: bottom-edge pair reads ${ch} fg=${st?.fg} bg=${st?.bg}, wanted ▀ fg=${top} bg=${bot}`)
        continue
      }
      if (st?.bg !== `48;2;${top}`) faults.push(`${x},${y}: bg ${st?.bg} is not the upper half ${top}`)
      if (ch !== '▄' || st?.fg !== `38;2;${bot}`) faults.push(`${x},${y}: painted pair reads ${ch} fg=${st?.fg}, wanted ▄ fg=${bot} (E5: every pair with a painted pixel below it is ▄ with the colours swapped)`)
      if (top !== bot) twoColour++
    }
  }
  check(`every painted pair with a painted pixel below it goes out as ▄ with fg = the lower half and bg = the upper half — E5's bytes exactly (${twoColour} two-colour cells among them)`, faults.length === 0 && twoColour > 0, faults.slice(0, 6).join('; '))
  check(`every painted pair on the sprite's bottom edge goes out as ▀ with fg = the upper half and bg = the lower half — its own colour below it, never the upper half's (${edge} cells)`, edgeFaults.length === 0 && edge > 0, edgeFaults.slice(0, 6).join('; '))
}
const belowCells = restCols.map(c => `${ART_LEFT + c},${eyeLine + 1}`)
const eyeCells = restCols.map(c => `${ART_LEFT + c},${eyeLine}`)

const sgrMotion = (col0: number, row0: number): string => `\x1b[<35;${col0 + 1};${row0 + 1}M`
const faceCol = ART_LEFT + Math.floor(fx)

section('§2 the pointer above the critter: the pupils walk UP into the upper half of the eye cell')
await awayFromLid()
const upMark = stdout.chunks.length
push(sgrMotion(faceCol, 0))
const upOk = await awaitGlass(() => pupilsAt('top'))
check('pointer above ⇒ every pupil in the UPPER half, the lower half cream', upOk, eyeRow())
const upTouched = touchedBy(bytesSince(upMark))
check('the up frame rewrote each pupil cell (a standing half-block cell whose two colours swapped)', eyeCells.every(k => upTouched.has(k)), [...upTouched].sort().join(' '))
check('…and repainted the cell BELOW each pupil, where a ▄ bleeds on Apple Terminal, so the old lower-half colour cannot survive there', belowCells.every(k => upTouched.has(k)), [...upTouched].sort().join(' '))

section('§3 THE FOUR EYES IN MOTION — the pointer below the critter: the pupils come back DOWN; the standing ▄ recolours, so the cell it bleeds into (below) must be repainted too')
await awayFromLid()
const framesBefore = frames
const downMark = stdout.chunks.length
const belowBefore = belowCells.map(k => { const [x, y] = k.split(',').map(Number) as [number, number]; return glass.grid[y]![x] })
push(sgrMotion(faceCol, ROWS - 1))
const downPainted = await awaitGlass(() => frames > framesBefore && restCols.every(c => halves(ART_LEFT + c).bottom === 'pupil'))
check('pointer below ⇒ a frame painted the pupils back into the lower half', downPainted, `frames ${frames - framesBefore} ${eyeRow()}`)
const upperCleared = restCols.every(c => halves(ART_LEFT + c).top === 'cream')
check('the bytes of the down frame carry cream in the upper half of every eye cell (the frame itself is right)', upperCleared, eyeRow())
const downTouched = touchedBy(bytesSince(downMark))
check('the down frame REPAINTS the cell below each pupil — the cell a recoloured ▄ bleeds into — so no sliver of the old colour survives beside the eye', belowCells.every(k => downTouched.has(k)), `touched ${[...downTouched].sort().join(' ')}; wanted ${belowCells.join(' ')}`)
check('the repainted cell below keeps its own value (the glyph it had, not a blank)', belowCells.every((k, i) => {
  const [x, y] = k.split(',').map(Number) as [number, number]
  return glass.grid[y]![x] === belowBefore[i] && glass.grid[y]![x] !== ' '
}), belowCells.map((k, i) => { const [x, y] = k.split(',').map(Number) as [number, number]; return `${k}:${JSON.stringify(belowBefore[i])}→${JSON.stringify(glass.grid[y]![x])}` }).join(' '))
check('the eye cells carry a half-block glyph on every frame', restCols.every(c => ['▀', '▄'].includes(glass.grid[eyeLine]![ART_LEFT + c]!)), eyeRow())
check('the glass replay raised no vocabulary fault', glassFault === '', glassFault)

section('§4 the whole eye line equals a cold render of the same state: every cream cell cream, every pupil cell one pupil')
{
  const row = glass.grid[eyeLine]!
  const styles = restCols.map(c => halves(ART_LEFT + c))
  const summary = styles.map(s => `${s.top}/${s.bottom}`).join(' ')
  check('each eye cell reads cream over pupil (the authored rest frame, cell for cell)', styles.every(s => s.top === 'cream' && s.bottom === 'pupil'), summary)
  const creamCells = clusters.flatMap(cl => cl.cells.filter(c => c.r === restRow && c.c !== cl.rest.c).map(c => ART_LEFT + c.c))
  check('the eye cells beside the pupils are cream in both halves', creamCells.every(x => {
    const hv = halves(x)
    return row[x] === '▄' && hv.top === 'cream' && hv.bottom === 'cream'
  }), creamCells.map(x => `${x}:${row[x]}${halves(x).top}/${halves(x).bottom}`).join(' '))
}

instance.unmount()
await settle(50)
console.log(`\n${failures === 0 ? '✅' : '❌'} FOUR-EYES ${failures === 0 ? 'GREEN' : 'RED'} — ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
