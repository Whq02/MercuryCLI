#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { pinScratchHome, waitFor } from '../lib/settingsPopupHarness.js'
import { AnsiEmulator } from './ansiEmulator.js'

const home = pinScratchHome('rail-headers-slipped')
delete process.env.NODE_ENV
delete process.env.WT_SESSION
delete process.env.TERM_PROGRAM
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { Box, Text } = await import('../../src/ink.js')

const COLS = 110
const ROWS = 32
const HEADERS = ['RECENT', 'WORKBENCH', 'NEXT', 'FILES · Café Ledger', 'VITALS']
const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}

class Output extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  writes: string[] = []
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
type Turn = { asked: boolean; spinner: string | null }

function Cockpit({ asked, spinner }: Turn): React.ReactElement {
  const workbench = asked ? ['  read ledger.py and', '  tell me in three…'] : ['  no prompts sent yet']
  const rail = ['  lanes', 'RECENT', '  ○ Hi! I want to build…', '', 'WORKBENCH', ...workbench, '', 'NEXT', '  · /workflows — crewma…', '', 'FILES · Café Ledger', '  ↵ or click · browse', '', 'VITALS', '  · 5h 19% · 3h 35m · ↻…', '  · ctx 3% · 1000k', '  · health — run /health']
  const art = ['▄▄▄▄▄▄▄▄▄', '▄▄▄▄▄▄▄▄▄', '▀▀▄▀▀▀▄▀▀']
  return h(Box, { width: COLS, height: ROWS, flexDirection: 'column' },
    h(Box, { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' },
      h(Box, { width: 24, flexShrink: 0, flexDirection: 'column', overflow: 'hidden' }, ...rail.map((text, i) => h(Text, { key: i, wrap: 'truncate-end' }, text === '' ? ' ' : text))),
      h(Box, { flexDirection: 'column', flexGrow: 1, minWidth: 0, overflow: 'hidden', borderStyle: 'round' },
        h(Box, { flexDirection: 'row', flexShrink: 0, borderStyle: 'round', paddingX: 1, gap: 1 },
          h(Box, { flexDirection: 'column', flexShrink: 0, width: 11, justifyContent: 'center' }, ...art.map((line, i) => h(Text, { key: i }, line))),
          h(Box, { flexDirection: 'column', flexGrow: 1, minWidth: 0, justifyContent: 'center' },
            spinner === null ? h(Text, null, ' ') : h(Box, { borderStyle: 'round', paddingX: 1 }, h(Text, null, spinner)))),
        h(Text, null, ' '),
        asked ? h(Text, null, ' 17:24:02 [WHQ] ❯ read ledger.py and tell me in three sentences what it does') : h(Text, null, '  ✶ Mercury'),
        asked ? h(Text, null, ' │ 17:24:09 [Mercury] ▤ Read 1 file ⌄') : h(Text, null, '  ● ready · type a prompt, or / for commands'))),
    h(Box, { flexDirection: 'column', flexShrink: 0 },
      h(Text, null, ' ⊠ sovereign mode on — all tool calls auto-approved'),
      h(Text, null, spinner === null ? ' ready · Sonnet 5.5 · max' : ' Sonnet 5.5 · max   esc interrupts · shift+← back'),
      h(Box, { width: '100%', flexShrink: 0, borderStyle: 'round' }, h(Text, null, '❯ Type a prompt, start a slash command, or Tab to focus the rails')),
      h(Text, null, '? for shortcuts · ctrl+x p for commands + files'),
      h(Text, null, 'shift + ↵ for a new line · shift + ← concourse')))
}

function composed(ink: InstanceType<typeof Ink>): string[] {
  const lines = stripAnsi(ink.lastFrameText()).split('\n').map(line => line.trimEnd())
  while (lines.length < ROWS) lines.push('')
  return lines.slice(0, ROWS)
}
function railColumn(rows: readonly string[]): string[] {
  return rows.slice(0, ROWS - 7).map(row => row.slice(0, 24).trimEnd())
}
function headersWhole(rows: readonly string[]): boolean {
  const rail = railColumn(rows)
  return HEADERS.every(header => rail.includes(header)) && rail.every(cell => HEADERS.includes(cell) || cell === '' || cell.startsWith('  ') || cell.startsWith('    '))
}
function feedTo(glass: AnsiEmulator, bytes: string): void {
  if (WIDTH_PROBE_WRITE.test(bytes)) return
  glass.feed(bytes.replace(PROBE_CSI, ''))
}

console.log('110x32: a 24-column rail beside a spinner card through a turn — the renderer keeps every section header whole; a glass that slipped one row does not')

const stdout = new Output()
const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, false)

const turn: Turn[] = [{ asked: false, spinner: null }]
for (let s = 0; s < 24; s++) turn.push({ asked: true, spinner: `${'✶✸✹✺✷'[s % 5]} Zero drag… (1m ${String(8 + s).padStart(2, '0')}s)` })
turn.push({ asked: true, spinner: null })

const strict = new AnsiEmulator(COLS, ROWS, true)
const slipped = new AnsiEmulator(COLS, ROWS, false)
let mark = 0
let strictAlwaysEqual = true
let strictHeadersAlwaysWhole = true
let firstMismatch = ''
let slippedBrokeDuringTurn = false
let slippedRows: string[] = []
let wantRows: string[] = []
for (const [index, step] of turn.entries()) {
  ink.render(h(Cockpit, step))
  const painted = await waitFor(() => {
    const frame = composed(ink).join('\n')
    return frame.includes(step.asked ? 'read ledger.py and' : 'no prompts sent yet') &&
      (step.spinner === null ? !frame.includes('Zero drag…') : frame.includes(step.spinner))
  }, 10_000)
  if (!painted) throw new Error(`frame ${index} did not paint`)
  const writes = stdout.writes.slice(mark)
  mark = stdout.writes.length
  if (index === 1) slipped.feed(`\x1b[${ROWS};1H\n`)
  for (const bytes of writes) {
    feedTo(strict, bytes)
    feedTo(slipped, bytes)
  }
  wantRows = composed(ink)
  const glass = strict.lines()
  if (JSON.stringify(glass) !== JSON.stringify(wantRows)) {
    strictAlwaysEqual = false
    if (firstMismatch === '') firstMismatch = `frame ${index}: ${glass.find((line, y) => line !== wantRows[y]) ?? ''}`
  }
  if (!headersWhole(glass)) strictHeadersAlwaysWhole = false
  slippedRows = slipped.lines()
  if (step.spinner !== null && !headersWhole(slippedRows)) slippedBrokeDuringTurn = true
}

console.log('\n§1 the renderer, replayed exactly as written (any print past the last column fails)')
check(`every one of the ${turn.length} frames on the glass equals the frame the renderer composed`, strictAlwaysEqual, firstMismatch)
check('every section header stands whole on its own row in every frame, spinner on and off', strictHeadersAlwaysWhole)
check('the composed frames themselves keep each header whole (one truncating line in a 24-column box)', headersWhole(wantRows), JSON.stringify(railColumn(wantRows).slice(0, 18)))
check('no write carries CR or LF, so nothing the renderer sends can scroll the alternate screen', stdout.writes.every(bytes => !/[\r\n]/.test(bytes)))

console.log('\n§2 the same bytes on a glass that slipped one row just before the turn (the U-58 capture: the frame’s top row pushed into the scrollback)')
check('the slip pushed the frame’s top row into the scrollback, as in the U-58..U-62 captures', slipped.scrollback.length === 1 && slipped.scrollback[0]!.startsWith('  lanes'), JSON.stringify(slipped.scrollback))
check('once the turn repaints the rail and the berth card, section headers come apart on the slipped glass', slippedBrokeDuringTurn)
check('they stay apart after the spinner card is gone — the renderer only rewrites cells it changed, as U-62 shows after the turn ended', !headersWhole(slippedRows), JSON.stringify(railColumn(slippedRows).slice(0, 18)))
console.log('    slipped rail after the turn:')
for (const [y, cell] of railColumn(slippedRows).slice(0, 18).entries()) console.log(`      ${String(y).padStart(2)} |${cell}`)

ink.unmount()
await ink.waitUntilExit()
rmSync(home, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} rail headers and the slipped glass: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
