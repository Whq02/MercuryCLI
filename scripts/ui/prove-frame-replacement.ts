#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { pinScratchHome, pinSourceRef, settle } from '../lib/settingsPopupHarness.js'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'

const home = pinScratchHome('frame-replacement')
pinSourceRef()
delete process.env.NODE_ENV
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { Box, Text } = await import('../../src/ink.js')
const { MercurySetupFrame } = await import('../../src/components/MercurySetupFrame.js')
const { useTerminalSize } = await import('../../src/hooks/useTerminalSize.js')
const { regionScrollTrustedNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.js')
upgradeSyncOutputSupport()

const h = React.createElement
const frameAt = process.argv.indexOf('--frames')
const frameDir = frameAt < 0 ? undefined : process.argv[frameAt + 1]
if (frameDir) mkdirSync(frameDir, { recursive: true })
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const probe = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
class Output extends EventEmitter {
  isTTY = true
  writes: string[] = []
  constructor(public columns: number, public rows: number) { super() }
  write(s: string): boolean { this.writes.push(s); return true }
}
class Input extends EventEmitter {
  isTTY = false
  read(): null { return null }
  setEncoding(): this { return this }
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  readableLength = 0
}
function rig(columns: number, rows: number, alt = true) {
  const stdout = new Output(columns, rows)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(columns, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  if (alt) ink.setAltScreenActive(true, false)
  return { ink, stdout }
}
function feed(terminal: AnsiEmulator, writes: readonly string[]): void {
  for (const bytes of writes) {
    if (/\x1b7.*\x1b\[6n/s.test(bytes)) continue
    terminal.feed(bytes.replace(probe, ''))
  }
}
function model(ink: InstanceType<typeof Ink>, rows: number): string[] {
  const lines = stripAnsi(ink.lastFrameText()).split('\n').map(line => line.trimEnd())
  while (lines.length < rows) lines.push('')
  return lines
}
function sameGlass(label: string, terminal: AnsiEmulator, ink: InstanceType<typeof Ink>): void {
  const want = model(ink, terminal.height)
  const got = terminal.lines()
  check(label, JSON.stringify(got) === JSON.stringify(want), got.flatMap((line, y) => line === want[y] ? [] : [`row ${y}: ${JSON.stringify(line)} != ${JSON.stringify(want[y])}`]).slice(0, 4).join(' | '))
}
function save(name: string, terminal: AnsiEmulator): void {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), terminal.lines().join('\n') + '\n')
}
function wizard(tall: boolean): React.ReactElement {
  return h(MercurySetupFrame, {
    title: 'first run', stepTag: tall ? 'theme · 1/4' : 'guardrails · 3/4', firstRunCard: true,
    steps: [{ key: 'theme', label: 'theme', state: tall ? 'current' : 'done' }, { key: 'guardrails', label: 'guardrails', state: tall ? 'pending' : 'current' }],
    footer: tall ? '↑↓ preview · ↵ keep · esc exits' : '↵ continue · esc back',
    children: h(Box, { flexDirection: 'column' }, ...Array.from({ length: tall ? 16 : 3 }, (_, i) => h(Text, { key: i }, tall ? `Choose your theme ${i} ${'theme '.repeat(7)}` : ['Guardrails', 'Mercury can be wrong.', ' ▸ continue'][i]))),
  })
}
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew
for (const profile of ['alt', 'conpty', 'inline'] as const) {
  if (profile === 'conpty') process.env.WT_SESSION = 'frame-replacement'
  else delete process.env.WT_SESSION
  check(`${profile}: region scrolling follows the profile`, regionScrollTrustedNow() === (profile !== 'conpty' && process.platform !== 'win32'))
  for (const idle of [false, true]) {
    const { ink, stdout } = rig(80, 24, profile !== 'inline')
    const terminal = new AnsiEmulator(80, 24, profile !== 'inline')
    ink.render(wizard(true))
    await settle(100)
    feed(terminal, stdout.writes)
    sameGlass(`${profile} ${idle ? 'idle' : 'active'}: tall wizard frame`, terminal, ink)
    const before = stdout.writes.length
    if (idle) skew += 31_000
    ink.render(wizard(false))
    await settle(100)
    const writes = stdout.writes.slice(before)
    feed(terminal, writes)
    sameGlass(`${profile} ${idle ? 'idle' : 'active'}: short wizard replaces every old cell`, terminal, ink)
    check(`${profile}: no old tail remains`, !terminal.lines().some(line => line.includes('theme 15')))
    if (profile === 'inline') check('inline shrink never erases the screen or scrollback', !/\x1b\[[0123]?J/.test(writes.join('')))
    else if (idle) {
      const bytes = writes.join('')
      check(`${profile}: idle erase and repaint share one synchronized write`, writes.length === 1 && bytes.startsWith('\x1b[?2026h') && bytes.endsWith('\x1b[?2026l') && bytes.indexOf('\x1b[2J') !== -1 && bytes.indexOf('\x1b[2J') < bytes.indexOf('Guardrails') && bytes.split('\x1b[2J').length === 2)
    } else check(`${profile}: an ordinary step change needs no whole-screen erase`, !/\x1b\[[0123]?J/.test(writes.join('')))
    save(`${profile}-${idle ? 'idle' : 'active'}-short`, terminal)
    ink.unmount()
    await ink.waitUntilExit()
  }
}
Date.now = realNow

function Cockpit({ busy }: { busy: boolean }): React.ReactElement {
  const { columns } = useTerminalSize()
  return h(Box, { width: '100%', flexDirection: 'column', flexGrow: 1 },
    h(Box, { flexDirection: 'row', flexGrow: 1, overflow: 'hidden' },
      columns >= 100 ? h(Box, { width: 24, flexShrink: 0, flexDirection: 'column', borderStyle: 'single', borderTop: false, borderBottom: false, borderLeft: false },
        ...['RECENT', 'WORKBENCH', 'NEXT', 'FILES', 'VITALS'].map(text => h(Text, { key: text }, text))) : null,
      h(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'round' },
        h(Text, null, 'a transcript line'),
        busy ? h(Box, { borderStyle: 'round' }, h(Text, null, '✷ Zero drag… (1m 32s)')) : null)),
    h(Text, null, 'ready'),
    h(Box, { width: '100%', flexShrink: 0, borderStyle: 'round' }, h(Text, null, '❯ Type a prompt')),
    h(Text, null, '? for shortcuts'))
}
function cropped(from: AnsiEmulator, columns: number, rows: number): AnsiEmulator {
  const to = new AnsiEmulator(columns, rows, true)
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
process.env.WT_SESSION = 'frame-replacement'
const { ink, stdout } = rig(110, 32)
let terminal = new AnsiEmulator(110, 32, true)
ink.render(h(Cockpit, { busy: false }))
await settle(100)
feed(terminal, stdout.writes)
let mark = stdout.writes.length
for (const busy of [true, false, true]) {
  ink.render(h(Cockpit, { busy }))
  await settle(100)
  feed(terminal, stdout.writes.slice(mark))
  mark = stdout.writes.length
  sameGlass(`110x32 spinner ${busy}: replay equals composed cells`, terminal, ink)
  check('rail titles stay on one row', ['NEXT', 'FILES', 'VITALS'].every(word => terminal.lines().some(line => line.startsWith(word))))
}
for (const [columns, rows] of [[80, 24], [140, 40], [110, 32]] as const) {
  terminal = cropped(terminal, columns, rows)
  stdout.columns = columns
  stdout.rows = rows
  stdout.emit('resize')
  await settle(250)
  feed(terminal, stdout.writes.slice(mark))
  mark = stdout.writes.length
  sameGlass(`${columns}x${rows}: settled resize removes all old cells`, terminal, ink)
  check(`${columns}x${rows}: no spilled border fragment`, terminal.lines().every(line => !/^[─╮╯]/.test(line)))
  save(`resize-${columns}x${rows}`, terminal)
}
ink.unmount()
await ink.waitUntilExit()
rmSync(home, { recursive: true, force: true })
console.log(`frame-replacement: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
