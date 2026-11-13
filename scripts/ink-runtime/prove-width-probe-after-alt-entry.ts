#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import React from 'react'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import useInput from '../../src/ink/hooks/use-input.js'
import Ink from '../../src/ink/ink.js'
import instances from '../../src/ink/instances.js'
import { readTerminalWidthMeasurements, WIDTH_PROBE_SAMPLES } from '../../src/ink/session/widthProbe.js'
import { AnsiEmulator } from './ansiEmulator.js'

const COLS = 40
const ROWS = 12
const ALT_ENTRY = '\x1b[?1049h'
const CURSOR_ASK = '\x1b[6n'
const LINE_ERASE = '\x1b[2K'
const UNMODELLED = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?u|\??[0-9;]*\$p|c|[0-9;]*t|6n)/g
const ALT_SWITCH = /\x1b\[\?1049[hl]/
const ADVANCES = [1, 4, 5, 2, 1, 0, 1, 2]

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const show = (bytes: string): string => JSON.stringify(bytes.length > 220 ? `${bytes.slice(0, 220)}…` : bytes)
const countOf = (bytes: string, needle: string): number => bytes.split(needle).length - 1
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  emulator = new AnsiEmulator(COLS, ROWS, true)
  bytes = ''
  chunks: string[] = []
  onWrite: ((chunk: string) => void) | null = null
  write(chunk: string): boolean {
    this.bytes += chunk
    this.chunks.push(chunk)
    if (ALT_SWITCH.test(chunk)) {
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          this.emulator.grid[y]![x] = ' '
          this.emulator.cellStyles[y]![x] = null
        }
      }
    }
    this.emulator.feed(chunk.replace(UNMODELLED, ''))
    this.onWrite?.(chunk)
    return true
  }
  lines(): string[] {
    return this.emulator.lines().map(line => line.trimEnd())
  }
}

type FedStdin = NodeJS.ReadStream & { feed(bytes: string): void }
function makeStdin(): FedStdin {
  const queue: string[] = []
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    readableLength: 0,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return queue.shift() ?? null },
    ref() { return this },
    unref() { return this },
    pause() { return this },
    resume() { return this },
    feed(bytes: string) {
      queue.push(bytes)
      stdin.emit('readable')
    },
  })
  return stdin as unknown as FedStdin
}

const rowText = (row: number): string => `row ${row} of the first screen`
function FirstScreen(): React.ReactNode {
  useInput(() => {})
  const h = React.createElement
  return h(
    AlternateScreen,
    { mouseTracking: false },
    h(
      Box,
      { flexDirection: 'column', height: ROWS, width: COLS },
      ...Array.from({ length: ROWS }, (_, i) => h(Text, { key: i }, rowText(i + 1))),
    ),
  )
}

console.log('§1 a first screen that takes the alternate screen and the keyboard in one commit: the width probe waits for the entry')
{
  const out = new Terminal()
  const err = new Terminal()
  const stdin = makeStdin()
  const ink = new Ink({
    stdout: out as unknown as NodeJS.WriteStream,
    stdin,
    stderr: err as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(out as unknown as NodeJS.WriteStream, ink)
  let answered = false
  out.onWrite = chunk => {
    if (answered || !chunk.includes(CURSOR_ASK)) return
    answered = true
    const replies = WIDTH_PROBE_SAMPLES.map((_, i) => `\x1b[${i + 2};${ADVANCES[i]! + 1}R`).join('') + '\x1b[?62;4c'
    setTimeout(() => stdin.feed(replies), 5)
  }
  ink.render(React.createElement(FirstScreen))
  await settle(900)

  const bytes = out.bytes
  const altAt = bytes.indexOf(ALT_ENTRY)
  const firstAsk = bytes.indexOf(CURSOR_ASK)
  const firstErase = bytes.indexOf(LINE_ERASE)
  const entryWrite = out.chunks.findIndex(chunk => chunk.includes(ALT_ENTRY))
  const askWrite = out.chunks.findIndex(chunk => chunk.includes(CURSOR_ASK))
  check(
    'control: the alternate screen is entered once and the eight samples are asked',
    countOf(bytes, ALT_ENTRY) === 1 && countOf(bytes, CURSOR_ASK) === WIDTH_PROBE_SAMPLES.length,
    `entries ${countOf(bytes, ALT_ENTRY)}, asks ${countOf(bytes, CURSOR_ASK)}`,
  )
  const before = altAt < 0 ? bytes : bytes.slice(0, altAt)
  check(
    "no sample is written, no row erased and no cell addressed before the alternate screen's entry: what stood in the terminal stays",
    altAt >= 0 && !before.includes(CURSOR_ASK) && !before.includes(LINE_ERASE) && !/\x1b\[\d+;\d+H/.test(before),
    `entry at ${altAt}, first ask at ${firstAsk}, first row erase at ${firstErase}; before the entry: ${show(before)}`,
  )
  check(
    'the entry and the first frame go out in one write, down to the last row, and the samples in a later one',
    entryWrite >= 0 && out.chunks[entryWrite]!.includes(`\x1b[${ROWS};1H`) && askWrite > entryWrite,
    `the entry in write ${entryWrite}, the first ask in write ${askWrite}; the entry's write: ${show(out.chunks[entryWrite] ?? '')}`,
  )
  const measured = readTerminalWidthMeasurements()
  const expected = Object.fromEntries(WIDTH_PROBE_SAMPLES.map((sample, i) => [sample.kind, ADVANCES[i]!]))
  check(
    "the terminal's answers are taken: the eight classes are measured",
    JSON.stringify(measured) === JSON.stringify(expected),
    `${JSON.stringify(measured)} against ${JSON.stringify(expected)}`,
  )
  const lines = out.lines()
  const wanted = Array.from({ length: ROWS }, (_, i) => rowText(i + 1))
  check(
    "after the probe every row of the frame stands again, the eight it sampled on among them",
    JSON.stringify(lines) === JSON.stringify(wanted),
    JSON.stringify(lines),
  )
  ;(ink as unknown as { isTTY: boolean }).isTTY = false
  ink.unmount()
  instances.delete(out as unknown as NodeJS.WriteStream)
}

console.log('§2 a first screen that gives the alternate screen up before its entry is written: no sample reaches the terminal')
{
  const out = new Terminal()
  const err = new Terminal()
  const ink = new Ink({
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: makeStdin(),
    stderr: err as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(out as unknown as NodeJS.WriteStream, ink)
  function PlainScreen(): React.ReactNode {
    useInput(() => {})
    return React.createElement(Text, null, 'plain-screen-painted')
  }
  ink.render(React.createElement(FirstScreen))
  const owed = ink.isAltEntryPending()
  ink.render(React.createElement(PlainScreen))
  await settle(700)
  check('control: the first screen armed the entry and still owed it when it was replaced', owed && !ink.isAltScreenActive)
  check('control: the plain screen is painted', out.bytes.includes('plain-screen-painted'), show(out.bytes))
  check(
    "the alternate screen is never entered, and nothing of the probe is written on the terminal's own screen",
    !out.bytes.includes(ALT_ENTRY) && !out.bytes.includes(CURSOR_ASK) && !out.bytes.includes(LINE_ERASE) && !out.bytes.includes('\x1b7'),
    show(out.bytes),
  )
  ;(ink as unknown as { isTTY: boolean }).isTTY = false
  ink.unmount()
  instances.delete(out as unknown as NodeJS.WriteStream)
}

console.log(`\nprove-width-probe-after-alt-entry: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
