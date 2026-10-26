#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { pinScratchHome, settle } from '../lib/settingsPopupHarness.js'
import { AnsiEmulator } from './ansiEmulator.js'

const home = pinScratchHome('resize-border-capture')
delete process.env.NODE_ENV
delete process.env.WT_SESSION
delete process.env.TERM_PROGRAM
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { Box, Text } = await import('../../src/ink.js')
const { useTerminalSize } = await import('../../src/hooks/useTerminalSize.js')

const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s
const REPLACEMENT = '\uFFFD'

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}

class Output extends EventEmitter {
  isTTY = true
  writes: string[] = []
  constructor(public columns: number, public rows: number) { super() }
  write(s: string): boolean { this.writes.push(s); return true }
}
class Input extends EventEmitter {
  isTTY = false
  readableLength = 0
  read(): null { return null }
  setEncoding(): this { return this }
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const h = React.createElement
const RAIL = ['  lanes', 'RECENT', '  ○ read ledger.py and …', '', 'WORKBENCH', '  write a small', '', 'NEXT', '  · /workflows — crewma…', '', 'FILES · Café Ledger', '  ↵ or click · browse', '', 'VITALS', '  · ctx 8% · 1000k']

function Cockpit(): React.ReactElement {
  const { columns, rows } = useTerminalSize()
  const wide = columns >= 100
  return h(Box, { width: columns, height: rows, flexDirection: 'column' },
    h(Box, { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' },
      wide ? h(Box, { width: 24, flexShrink: 0, flexDirection: 'column', overflow: 'hidden' }, ...RAIL.map((text, i) => h(Text, { key: i, wrap: 'truncate-end' }, text === '' ? ' ' : text))) : null,
      h(Box, { flexDirection: 'column', flexGrow: 1, minWidth: 0, overflow: 'hidden', ...(wide ? { borderStyle: 'round' as const } : {}) },
        h(Text, null, "I haven't committed anything. weekly.ps1 and this-week.txt are untracked in git."),
        h(Text, null, '∙ 1 file edit +30 · 8 reads · 7 shell commands · ctx +81.1k'))),
    h(Box, { flexDirection: 'column', flexShrink: 0 },
      h(Text, null, ' ⊠ sovereign mode on — all tool calls auto-approved'),
      h(Text, null, ' ready · Sonnet 5.5 · max'),
      h(Box, { width: '100%', flexShrink: 0, borderStyle: 'round' }, h(Text, null, '❯ Type a prompt, start a slash command, or Tab to focus the rails')),
      h(Text, null, '? for shortcuts · ctrl+x p for commands + files'),
      h(Text, null, 'shift + ↵ for a new line · shift + ← concourse')))
}

function feed(terminal: AnsiEmulator, writes: readonly string[]): void {
  for (const bytes of writes) {
    if (WIDTH_PROBE_WRITE.test(bytes)) continue
    terminal.feed(bytes.replace(PROBE_CSI, ''))
  }
}
function cropped(from: AnsiEmulator, columns: number, rows: number, altScreen = true, autowrap = false): AnsiEmulator {
  const to = new AnsiEmulator(columns, rows, altScreen, { autowrap })
  for (let y = 0; y < Math.min(rows, from.height); y++) {
    for (let x = 0; x < Math.min(columns, from.width); x++) {
      to.grid[y]![x] = from.grid[y]![x]!
      to.cellStyles[y]![x] = from.cellStyles[y]![x]!
      to.cellLinks[y]![x] = from.cellLinks[y]![x]!
    }
  }
  to.cursorX = Math.min(from.cursorX, columns - 1)
  to.cursorY = Math.min(from.cursorY, rows - 1)
  return to
}
function composed(ink: InstanceType<typeof Ink>, rows: number): string[] {
  const lines = stripAnsi(ink.lastFrameText()).split('\n').map(line => line.trimEnd())
  while (lines.length < rows) lines.push('')
  return lines.slice(0, rows)
}
function differing(got: string[], want: string[]): string {
  return got.flatMap((line, y) => (line === want[y] ? [] : [`row ${y}: ${JSON.stringify(line)} != ${JSON.stringify(want[y])}`])).slice(0, 3).join(' | ')
}
function perRead(bytes: Buffer, cut: number): string {
  return new TextDecoder().decode(bytes.subarray(0, cut)) + new TextDecoder().decode(bytes.subarray(cut))
}
function streamed(bytes: Buffer, cut: number): string {
  const decoder = new TextDecoder()
  return decoder.decode(bytes.subarray(0, cut), { stream: true }) + decoder.decode(bytes.subarray(cut))
}
function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}
function cutInsideFirstRuleAfter(text: string, marker: string): number {
  const at = text.indexOf('─', text.indexOf(marker))
  return Buffer.byteLength(text.slice(0, at), 'utf8')
}

console.log('resize 110x32 → 80x24 → 140x40 → 110x32 with a full-width composer border — what the renderer writes, and what a per-read decoder makes of it')

const stdout = new Output(110, 32)
const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(110, 32) as never, exitOnCtrlC: false, patchConsole: false })
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, false)
ink.render(h(Cockpit))
await settle(150)
let terminal = new AnsiEmulator(110, 32, true)
feed(terminal, stdout.writes)
let mark = stdout.writes.length
let wide140: AnsiEmulator | null = null
let finalWrites: string[] = []
for (const [columns, rows] of [[80, 24], [140, 40], [110, 32]] as const) {
  if (columns === 110) wide140 = terminal
  terminal = cropped(terminal, columns, rows)
  stdout.columns = columns
  stdout.rows = rows
  stdout.emit('resize')
  await settle(300)
  const writes = stdout.writes.slice(mark)
  feed(terminal, writes)
  mark = stdout.writes.length
  if (columns === 110) finalWrites = writes
}
const want = composed(ink, 32)
const frame = finalWrites.find(bytes => bytes.includes('\x1b[28;1H╭') && bytes.includes('Type')) ?? ''

console.log('\n§1 the renderer: the settled 110x32 frame after the round trip')
check('the composed composer top border runs to the last column (column 110 is written)', want[27] === `╭${'─'.repeat(108)}╮`, JSON.stringify(want[27]))
check('the settled repaint is one write that erases the screen before its first border glyph', frame !== '' && frame.indexOf('\x1b[2J') !== -1 && frame.indexOf('\x1b[2J') < frame.indexOf('╭'), JSON.stringify(frame.slice(0, 60)))
check('no write of the session carries CR or LF (every row is entered by an absolute cursor position; the alternate screen never scrolls)', stdout.writes.every(bytes => !/[\r\n]/.test(bytes)), JSON.stringify(stdout.writes.find(bytes => /[\r\n]/.test(bytes))?.slice(0, 80)))
check('no write of the session carries U+FFFD', stdout.writes.every(bytes => !bytes.includes(REPLACEMENT)))
check('a strict replay (any print past the last column fails) of the whole session equals the composed 110x32 frame', JSON.stringify(terminal.lines()) === JSON.stringify(want), differing(terminal.lines(), want))
check('the composer top border is one row on the glass and no row begins with a border fragment', terminal.lines()[27] === want[27] && terminal.lines().every(line => !/^[─╮╯]/.test(line)), JSON.stringify(terminal.lines().slice(26, 29)))
check('below the centre box nothing sits at column 25 (the 140-column layout left no divider)', terminal.lines().slice(25).every(line => line[24] !== '│'), JSON.stringify(terminal.lines().slice(25).map(line => line[24])))

console.log('\n§2 the capture: the same frame bytes read in two pieces, cut inside one ─ of the composer top border')
const bytes = Buffer.from(frame, 'utf8')
const cut = cutInsideFirstRuleAfter(frame, '\x1b[28;1H')
const afterFirstByte = perRead(bytes, cut + 1)
const afterSecondByte = perRead(bytes, cut + 2)
check('decoding each read on its own turns the split ─ into 3 U+FFFD when the cut follows its first byte', count(afterFirstByte, REPLACEMENT) === 3, String(count(afterFirstByte, REPLACEMENT)))
check('and into 2 U+FFFD when the cut follows its second byte', count(afterSecondByte, REPLACEMENT) === 2, String(count(afterSecondByte, REPLACEMENT)))
check('a streaming decoder (the partial sequence carried into the next read) gives back the frame untouched', streamed(bytes, cut + 1) === frame && streamed(bytes, cut + 2) === frame)
{
  const glass = new AnsiEmulator(110, 32, true, { autowrap: true })
  for (const bytesOut of finalWrites) {
    if (WIDTH_PROBE_WRITE.test(bytesOut)) continue
    glass.feed((bytesOut === frame ? afterFirstByte : bytesOut).replace(PROBE_CSI, ''))
  }
  const rows = glass.lines()
  check('fed straight from the renderer, the overflowing row loses its corner (3 cells for 1) but the next row is re-addressed and rewritten, so no fragment survives below it', !rows[27]!.endsWith('╮') && count(rows[27]!, REPLACEMENT) === 3 && rows[28]!.startsWith('│❯'), JSON.stringify(rows.slice(27, 29)))
}

console.log('\n§3 the capture of a pseudo-console repaint: the same composed rows sent one after another with CR LF between rows (relative moves, as the U-82 geometry shows), read in two pieces')
const repaint = '\x1b[H' + want.map(row => (row.length < 110 ? `${row}\x1b[K` : row)).join('\r\n')
const repaintBytes = Buffer.from(repaint, 'utf8')
const repaintCut = cutInsideFirstRuleAfter(repaint, want[26]!)
{
  const glass = cropped(wide140 ?? new AnsiEmulator(140, 40, true), 110, 32, false, true)
  glass.feed(perRead(repaintBytes, repaintCut + 1))
  const rows = glass.lines()
  check('the composer top border keeps 110 cells and loses its corner', rows[26]!.startsWith('╭') && !rows[26]!.endsWith('╮') && count(rows[26]!, REPLACEMENT) === 3, JSON.stringify(rows[26]))
  check('its last two cells land at columns 1-2 of the next row, beside the 140-column frame’s │ at column 25 that nothing rewrote', rows[27]!.startsWith('─╮') && rows[27]![24] === '│', JSON.stringify(rows[27]))
  check('the input row, the bottom border and both footers stand where the frame put them', rows[28] === want[28] && rows[29] === want[29] && rows[30] === want[30] && rows[31] === want[31], differing(rows.slice(28), want.slice(28)))
  check('every row above sits one row higher than the frame put it', JSON.stringify(rows.slice(0, 26)) === JSON.stringify(want.slice(1, 27)), differing(rows.slice(0, 26), want.slice(1, 27)))
  check('and the frame’s top row went into the scrollback', glass.scrollback.length === 1 && glass.scrollback[0] === want[0], JSON.stringify(glass.scrollback))
  console.log(`    row 26 ${JSON.stringify(rows[26]!.slice(0, 12))}…${JSON.stringify(rows[26]!.slice(-6))} · row 27 ${JSON.stringify(rows[27]!.slice(0, 26))} · scrollback ${JSON.stringify(glass.scrollback[0]?.slice(0, 26))}`)
}
{
  const glass = cropped(wide140 ?? new AnsiEmulator(140, 40, true), 110, 32, false, true)
  glass.feed(streamed(repaintBytes, repaintCut + 1))
  check('the same repaint through a streaming decoder lands every row in place, nothing in the scrollback', JSON.stringify(glass.lines()) === JSON.stringify(want) && glass.scrollback.length === 0, differing(glass.lines(), want))
}

ink.unmount()
await ink.waitUntilExit()
rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} resize border and capture split: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
