#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ptyDriverPython, vshotBudgetMs } from '../lib/captureDriver.ts'
import { cleanupScenario, scenario } from '../ui/renderScenarios.ts'

const RIG = join(import.meta.dir, 'lib', 'screenrig.py')
const COLS = 120
const ROWS = 44
const REDRAW = '\u000c'
const HELD_MS = 7000

type Row = { cells: string[]; attrs: Array<[number, string]> }
type Flash = { bytes: number; eraseDisplay: number; eraseBelow: number; altSwitch: number; maxLost: number; lostAt: string | null }
type Snap = { name: string; grid: Row[]; flash: Flash }

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

section('1. the detector, its own tick driven on a clock the proof holds')
{
  const { default: instances } = await import('../../src/ink/instances.ts')
  const out = (await import('../../src/ink/terminalOut.ts')) as { termWrite: (stream: never, bytes: string) => void; noteTerminalWriteHeld?: (ms: number) => void }
  const { writeAllSync } = await import('../../src/ink/session/delivery.ts')
  const { startEventLoopStallDetector } = await import('../../src/utils/eventLoopStallDetector.ts')

  let wall = 1_000_000
  let steady = 5_000
  let tick: (() => void) | null = null
  let reasserts = 0
  const realDateNow = Date.now
  const realSteadyNow = performance.now
  const realSetInterval = globalThis.setInterval
  const screenBefore = instances.get(process.stdout)
  Date.now = () => wall
  performance.now = () => steady
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn
    return { unref() {} }
  }) as never
  instances.set(process.stdout, { reassertTerminalModes: () => void reasserts++ } as never)
  try {
    startEventLoopStallDetector()
    globalThis.setInterval = realSetInterval
    const wakesAfter = (ms: number): number => {
      const before = reasserts
      wall += ms
      tick?.()
      return reasserts - before
    }
    const heldWrite = (ms: number) => () => {
      steady += ms
      wall += ms
    }

    check('the detector armed its interval', tick !== null)
    check('a tick on time re-asserts nothing', wakesAfter(200) === 0)
    check('a loop that stood still seven seconds with no terminal write in it is read as a wake', wakesAfter(7200) === 1)

    const frame = Buffer.from('a frame')
    const holdsFrame = heldWrite(6950)
    const delivered = writeAllSync(1, frame, { writeSync: (_fd, data) => (holdsFrame(), data.length), sleep: () => {} } as never)
    check('a frame the terminal held for seven seconds was delivered whole', delivered === true)
    check('seven seconds inside a frame write are no wake', wakesAfter(250) === 0, 'the detector re-asserted the screen')

    const holdsModes = heldWrite(6950)
    out.termWrite({ write: () => (holdsModes(), true) } as never, 'a mode write')
    check('seven seconds inside a mode write are no wake', wakesAfter(250) === 0, 'the detector re-asserted the screen')

    check('what a write held is spent by the tick that read it: the next seven-second gap is a wake', wakesAfter(7200) === 1)

    const holdsBriefly = heldWrite(800)
    out.termWrite({ write: () => (holdsBriefly(), true) } as never, 'a short write')
    check('a long gap with a short write in it is still a wake', wakesAfter(8400) === 1)

    let threw = false
    try {
      out.termWrite({ write: () => { heldWrite(6950)(); throw new Error('EIO') } } as never, 'a write that fails')
    } catch {
      threw = true
    }
    check('a write that throws after holding still reports what it held', threw && wakesAfter(250) === 0)
  } finally {
    Date.now = realDateNow
    performance.now = realSteadyNow
    globalThis.setInterval = realSetInterval
    if (screenBefore) instances.set(process.stdout, screenBefore)
    else instances.delete(process.stdout)
  }
}

section('2. the built product: a terminal that stops draining for seven seconds')
{
  const cells = (snap: Snap): string[] => snap.grid.flatMap(row => {
    const out: string[] = []
    let x = 0
    for (const [count, attrs] of row.attrs) for (let i = 0; i < count; i++, x++) out.push(`${row.cells[x]}\u0000${attrs}`)
    return out
  })
  const differing = (a: Snap, b: Snap): number => {
    const left = cells(a)
    const right = cells(b)
    let n = 0
    for (let i = 0; i < Math.max(left.length, right.length); i++) if (left[i] !== right[i]) n++
    return n
  }
  const steps = [
    { op: 'await', text: 'second task', maxMs: 40000 },
    { op: 'await', text: 'ctx ≈', maxMs: 40000 },
    { op: 'settle', quietMs: 2500, maxMs: 20000 },
    { op: 'snap', name: 'painted' },
    { op: 'send', data: REDRAW.repeat(12) },
    { op: 'hold', ms: HELD_MS },
    { op: 'settle', quietMs: 2500, maxMs: 20000 },
    { op: 'snap', name: 'drained' },
  ]
  const cfg = scenario('resume-2turn', COLS, ROWS)
  const dir = mkdtempSync(join(tmpdir(), 'blocked-write-'))
  const out = join(dir, 'out.json')
  const cfgPath = join(dir, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, cols: COLS, rows: ROWS, steps, out }))
  const env: Record<string, string | undefined> = { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }
  const run = spawnSync(ptyDriverPython('the blocked-write proof'), [RIG, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env: env as NodeJS.ProcessEnv })
  try {
    check('the rig ran its script to the end', run.status === 0, (run.stderr ?? '').slice(-400))
    if (run.status === 0) {
      const snaps = new Map((JSON.parse(readFileSync(out, 'utf8')) as { snaps: Snap[] }).snaps.map(snap => [snap.name, snap]))
      const painted = snaps.get('painted')
      const drained = snaps.get('drained')
      check('both frames were captured', painted !== undefined && drained !== undefined)
      if (painted && drained) {
        check(`twelve redraws were written into a terminal that did not read (${drained.flash.bytes} bytes arrived once it did)`, drained.flash.bytes > 100_000, `${drained.flash.bytes} bytes`)
        check('the wait was not read as a wake: the alternate screen is never left', drained.flash.altSwitch === 0 && drained.flash.lostAt === null, `${drained.flash.altSwitch} alternate-screen switches; ${drained.flash.maxLost} cells lost at ${JSON.stringify(drained.flash.lostAt)}`)
        check('and the screen holds the painted frame', differing(drained, painted) === 0, `${differing(drained, painted)} cells differ`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    cleanupScenario('resume-2turn')
  }
}

console.log(`\nblocked-write-is-no-wake: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
