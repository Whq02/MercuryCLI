#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.NODE_ENV === 'test') {
  console.error('prove-alt-entry-restore-point must not run with NODE_ENV=test (lattice bypass)')
  process.exit(1)
}

const REPO = resolve(import.meta.dir, '../..')
const SRC = REPO.replace(/\\/g, '/')
const ESC = '\x1b'
const COLS = 80
const ROWS = 22
const PRE_ROWS = 6

type Pos = { row: number; col: number }
type Journey = { writes: string[]; marks: Record<string, number> }
type Scenario = 'held' | 'direct' | 'live' | 'heldlive'

const START: Pos = { row: PRE_ROWS + 1, col: 1 }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  [PASS] ${label}`)
  else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
function show(bytes: string): string {
  return bytes.replace(/\x1b/g, 'ESC').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

const JOURNEY = `
import { EventEmitter } from 'node:events'
import * as React from 'react'
import Ink from '${SRC}/src/ink/ink.js'
import instances from '${SRC}/src/ink/instances.js'
import { Box, Text } from '${SRC}/src/ink.js'
import { AlternateScreen } from '${SRC}/src/ink/components/AlternateScreen.js'

class FakeStdout extends EventEmitter {
  isTTY = true
  columns = ${COLS}
  rows = ${ROWS}
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  read(): null {
    return null
  }
}

const ESC = String.fromCharCode(27)
const ENTER = ESC + '[?1049h'
const RESET = ESC + '[r'
const stdout = new FakeStdout()
const ink = new Ink({
  stdout: stdout as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
instances.set(stdout as never, ink)
const e = React.createElement
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(15)
  }
  return false
}
const entered = () => stdout.writes.some(w => w.includes(ENTER))
const marks: Record<string, number> = {}
const surface = (key: string, withPane: boolean) =>
  e(
    Box,
    { key },
    e(
      AlternateScreen,
      { mouseTracking: true },
      e(
        Box,
        { flexDirection: 'column' },
        e(Text, null, key),
        withPane ? e(AlternateScreen, { mouseTracking: false }, e(Text, null, 'pane')) : null,
      ),
    ),
  )

const scenario = process.env.PROOF_SCENARIO
if (scenario === 'held') {
  ink.render(surface('card', false))
  await until(() => stdout.writes.some(w => w.includes(ESC + '[2J')))
  await sleep(100)
  marks.cardUp = stdout.writes.length
  ink.render(surface('boot', true))
  await until(entered)
  await sleep(150)
  marks.bootUp = stdout.writes.length
} else if (scenario === 'direct') {
  ink.render(surface('boot', true))
  await until(entered)
  await sleep(150)
  marks.bootUp = stdout.writes.length
} else {
  const ready = () => (scenario === 'heldlive' ? stdout.writes.some(w => w.includes(ESC + '[2J')) : entered())
  ink.render(surface('boot', false))
  await until(ready)
  await sleep(150)
  marks.entered = stdout.writes.length
  ink.render(surface('boot', true))
  await until(() => stdout.writes.slice(marks.entered).some(w => w === RESET))
  await sleep(150)
  marks.paneOpen = stdout.writes.length
}
const exited = ink.waitUntilExit()
ink.unmount()
await exited
process.stdout.write('<<<BYTES>>>' + JSON.stringify({ writes: stdout.writes, marks }) + '<<<END>>>')
process.exit(0)
`

const PROBE = `
const fs = require('node:fs')
const ESC = String.fromCharCode(27)
const chunks = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const preRows = Number(process.argv[3])
const hold = process.argv[4] === 'hold'
const out = process.argv[5]
let buf = ''
let waiter = null
const writeAll = s => {
  const b = Buffer.from(s, 'utf8')
  let o = 0
  while (o < b.length) o += fs.writeSync(1, b, o, b.length - o)
}
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', d => {
  buf += d.toString('utf8')
  for (;;) {
    const i = buf.indexOf(ESC + '[')
    if (i < 0) return
    let j = i + 2
    while (j < buf.length && !(buf.charCodeAt(j) >= 64 && buf.charCodeAt(j) <= 126)) j++
    if (j >= buf.length) return
    const body = buf.slice(i + 2, j)
    const fin = buf[j]
    buf = buf.slice(j + 1)
    if (fin === 'R' && /^[0-9]+;[0-9]+$/.test(body) && waiter) {
      const w = waiter
      waiter = null
      w(body.split(';').map(Number))
    }
  }
})
const cpr = () =>
  new Promise(res => {
    const t = setTimeout(() => {
      waiter = null
      res([-1, -1])
    }, 5000)
    waiter = p => {
      clearTimeout(t)
      res(p)
    }
    writeAll(ESC + '[6n')
  })
const main = async () => {
  writeAll(String.fromCharCode(13, 10).repeat(preRows))
  const before = await cpr()
  if (hold) writeAll(ESC + '[?1049h' + ESC + '[2J' + ESC + '[H')
  for (const c of chunks) writeAll(c)
  const after = await cpr()
  fs.writeFileSync(out, JSON.stringify({ before, after }))
  process.exit(0)
}
main()
`

const TOKEN = /\x1b\[([?<>=]?)([0-9;:]*)([ -\/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -\/]*[0-~]|[\s\S]/g

function movers(bytes: string): string[] {
  const found: string[] = []
  for (const m of bytes.matchAll(TOKEN)) {
    const t = m[0]
    if (m[4] !== undefined) {
      if (m[1] === '' && 'ABCDEFGHdfr'.includes(m[4])) found.push(t)
    } else if (t.length === 1) {
      const code = t.charCodeAt(0)
      if ((code >= 0x20 && code !== 0x7f) || '\r\n\b\t\v\f'.includes(t)) found.push(t)
    } else if (/^\x1b[78DEM]$/.test(t)) found.push(t)
  }
  return found
}

function mainWindows(bytes: string, startInAlt: boolean): string[] {
  const out: string[] = []
  let inAlt = startInAlt
  let from = 0
  for (const m of bytes.matchAll(/\x1b\[\?1049([hl])/g)) {
    const at = m.index ?? 0
    if (m[1] === 'h') {
      if (!inAlt) out.push(bytes.slice(from, at))
      inAlt = true
    } else {
      inAlt = false
      from = at + m[0].length
    }
  }
  if (!inAlt) out.push(bytes.slice(from))
  return out
}

function replay(bytes: string, start: Pos, startInAlt: boolean): Pos {
  let main: Pos = { ...start }
  let alt: Pos = { row: 1, col: 1 }
  let saved: Pos = { ...start }
  let inAlt = startInAlt
  const go = (row: number, col: number): void => {
    const p = {
      row: Math.min(ROWS, Math.max(1, row)),
      col: Math.min(COLS, Math.max(1, col)),
    }
    if (inAlt) alt = p
    else main = p
  }
  for (const m of bytes.matchAll(TOKEN)) {
    const t = m[0]
    const p = inAlt ? alt : main
    if (m[4] !== undefined) {
      const nums = m[2]!.split(';').map(s => (s === '' ? 0 : Number(s)))
      const n = nums[0] || 1
      if (m[1] === '?' && (m[4] === 'h' || m[4] === 'l') && nums.includes(1049)) {
        if (m[4] === 'h') {
          if (!inAlt) saved = { ...main }
          inAlt = true
          alt = { row: 1, col: 1 }
        } else {
          inAlt = false
          main = { ...saved }
        }
      } else if (m[1] === '') {
        if (m[4] === 'H' || m[4] === 'f') go(nums[0] || 1, nums[1] || 1)
        else if (m[4] === 'r') go(1, 1)
        else if (m[4] === 'A') go(p.row - n, p.col)
        else if (m[4] === 'B') go(p.row + n, p.col)
        else if (m[4] === 'C') go(p.row, p.col + n)
        else if (m[4] === 'D') go(p.row, p.col - n)
        else if (m[4] === 'E') go(p.row + n, 1)
        else if (m[4] === 'F') go(p.row - n, 1)
        else if (m[4] === 'G') go(p.row, n)
        else if (m[4] === 'd') go(n, p.col)
      }
    } else if (t === '\r') go(p.row, 1)
    else if (t === '\n') go(p.row + 1, p.col)
    else if (t.length === 1 && t.charCodeAt(0) >= 0x20 && t.charCodeAt(0) !== 0x7f) go(p.row, p.col + 1)
  }
  return main
}

function runJourney(scenario: Scenario, dir: string, home: string): Journey | null {
  const childPath = join(dir, `journey-${scenario}.ts`)
  writeFileSync(childPath, JOURNEY)
  const env: Record<string, string | undefined> = {
    ...process.env,
    PROOF_SCENARIO: scenario,
    MERCURY_CONFIG_DIR: home,
  }
  delete env.NODE_ENV
  delete env.MERCURY_ALT_HELD
  delete env.MERCURY_FULLSCREEN
  if (scenario === 'held' || scenario === 'heldlive') env.MERCURY_ALT_HELD = '1'
  const child = Bun.spawnSync({ cmd: [process.execPath, 'run', childPath], cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' })
  const out = child.stdout.toString()
  const from = out.indexOf('<<<BYTES>>>')
  const to = out.indexOf('<<<END>>>')
  if (from < 0 || to < from) {
    console.log(`  journey ${scenario} produced no bytes: ${child.stderr.toString().slice(0, 400)}`)
    return null
  }
  return JSON.parse(out.slice(from + 11, to)) as Journey
}

type ConsoleRun = { before: number[]; after: number[] } | { skipped: string } | { failed: string }

async function consoleRun(dir: string, tag: string, chunks: string[], hold: boolean): Promise<ConsoleRun> {
  if (process.platform !== 'win32') return { skipped: 'not a Windows console host' }
  const node = Bun.which('node')
  if (node === null) return { skipped: 'no node on PATH to drive the console' }
  const probe = join(dir, 'probe.cjs')
  writeFileSync(probe, PROBE)
  const chunkFile = join(dir, `chunks-${tag}.json`)
  writeFileSync(chunkFile, JSON.stringify(chunks))
  const result = join(dir, `result-${tag}.json`)
  let seen = ''
  let proc: { exited: Promise<number>; kill: () => void; terminal?: { close: () => void } }
  try {
    proc = Bun.spawn({
      cmd: [node, probe, chunkFile, String(PRE_ROWS), hold ? 'hold' : 'bare', result],
      terminal: {
        cols: COLS,
        rows: ROWS,
        data(_t: unknown, d: Uint8Array) {
          seen = (seen + Buffer.from(d).toString()).slice(-400)
        },
      },
    } as never) as never
  } catch (err) {
    return { skipped: `this Bun cannot open a pseudo-console: ${(err as Error).message}` }
  }
  if (proc.terminal === undefined) {
    proc.kill()
    return { skipped: 'this Bun has no spawn terminal option' }
  }
  const timer = setTimeout(() => proc.kill(), 30_000)
  await proc.exited
  clearTimeout(timer)
  proc.terminal.close()
  if (!existsSync(result)) return { failed: `the probe left no result; the console said ${show(seen)}` }
  return JSON.parse(readFileSync(result, 'utf8')) as ConsoleRun
}

const at = (p: Pos): string => `row ${p.row}, col ${p.col}`

async function prove(scenario: Scenario, title: string, dir: string, home: string): Promise<void> {
  console.log(`\n${title}`)
  const j = runJourney(scenario, dir, home)
  check(`${scenario}: the journey ran to its exit`, j !== null)
  if (j === null) return
  const startInAlt = scenario === 'held' || scenario === 'heldlive'
  const paneOnly = scenario === 'live' || scenario === 'heldlive'
  const bytes = j.writes.join('')
  const order = [...bytes.matchAll(/\x1b\[\?1049([hl])/g)]
    .map(m => m[1])
    .join('')
    .replace(/(.)\1+/g, '$1')
  const orders: Record<Scenario, [string, string]> = {
    held: ['lhl', 'left by the card, entered by the next surface, left at exit'],
    direct: ['hl', 'entered once and left at exit'],
    live: ['hl', 'entered once and left at exit'],
    heldlive: ['l', 'left once, at exit'],
  }
  check(`${scenario}: the alternate screen is ${orders[scenario][1]}`, order === orders[scenario][0], `leave/enter order was ${order}`)

  if (paneOnly) {
    const resets = j.writes.slice(j.marks.entered, j.marks.paneOpen).filter(w => w === `${ESC}[r`).length
    check(`${scenario}: a pane opened inside the alternate screen still resets the scroll margins there`, resets === 1, `${resets} margin resets`)
  }

  const before = mainWindows(bytes, startInAlt).slice(0, -1).join('')
  const moved = movers(before)
  check(
    `${scenario}: nothing that moves the cursor is written to the main screen before the surface enters the alternate screen`,
    moved.length === 0,
    `wrote ${moved.map(show).join(' ')} on the main screen`,
  )

  const end = replay(bytes, START, startInAlt)
  check(
    `${scenario}: a VT host restores the cursor to the launcher's save point at exit`,
    end.row === START.row && end.col === START.col,
    `the cursor came back to ${at(end)}; the launcher saved ${at(START)}`,
  )

  if (paneOnly) return
  const label = `${scenario}: the real console host leaves the cursor where it was before the alternate screen was taken`
  const run = await consoleRun(dir, scenario, j.writes, startInAlt)
  if ('skipped' in run) skip(label, run.skipped)
  else if ('failed' in run) check(label, false, run.failed)
  else {
    const same = run.after[0] === run.before[0] && run.after[1] === run.before[1]
    check(label, same && run.before[0] === START.row, `the console reported row ${run.before[0]}, col ${run.before[1]} before and row ${run.after[0]}, col ${run.after[1]} after exit`)
  }
}

console.log('prove-alt-entry-restore-point')
const dir = mkdtempSync(join(tmpdir(), 'alt-entry-restore-'))
const home = join(dir, 'home')
mkdirSync(home, { recursive: true })
try {
  await prove('held', 'a card closes the launcher-held alternate screen and the next surface opens its own', dir, home)
  await prove('direct', 'a surface with a second pane opens the alternate screen without a launcher hold', dir, home)
  await prove('live', 'a second pane opened inside the entered alternate screen', dir, home)
  await prove('heldlive', 'a second pane opened inside the launcher-held alternate screen', dir, home)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n❌ ${failures} ALT-ENTRY RESTORE-POINT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL ALT-ENTRY RESTORE-POINT PROOFS PASS')
