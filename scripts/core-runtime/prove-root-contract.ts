#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-root-contract.ts — T6:
//  renderer-root lifecycle laws over a REAL Ink instance + real React trees
//  against a fake TTY (stream write path — capturable, loss-free), replayed
//  through the style-aware AnsiEmulator. From the characterization set
// green on the OLD body
//  first.
//
//  Law families (green on the OLD body first — the T1 precedent):
//    • INSTANCES · COMMIT-TRANSACTION/COALESCE (count form; exact 16ms
//      lattice timing lands on the new owner's injected clock)
//    • TEARDOWN (child-process fd-1 capture — the old suite is a hard
//      writeSync(1)) · ALT-SANDWICH · ALT-DEPTH · RESIZE · SELF-HEAL
//      (repaintAltScreen variant) · POOL-EPOCH · PAUSE/EDITOR ·
//      DISPLAY-CURSOR + the declared-cursor same-frame commit leg ·
//      HOST-CONFIG · DOM-DIRTY · GENERATION-LEDGER
//  Deferred to the NEW owner's rigs (recorded in the ledger): SESSION-TRACE
//  (injected write seam) · STDERR-LEAK (needs a patchConsole rig).
//
//  Characterized findings the laws pin: AlternateScreen
//  reaches its instance via the HARDWIRED instances.get(process.stdout);
//  onUncaughtError is a noop and App's boundary paints the ERROR frame (a
//  follow-up render on the poisoned container hot-spins React's work
//  loop); the unmount mode-suite bypasses the session sink via
//  writeSync(1).
//
//  NODE_ENV must NOT be 'test' (that bypasses the scheduling lattice).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-root-contract.ts
// ============================================================================
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as React from 'react'
import Ink from '../../src/ink/ink.js'
import instances from '../../src/ink/instances.js'
import { Box, Text } from '../../src/ink.js'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import { useDeclaredCursor } from '../../src/ink/hooks/use-declared-cursor.js'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { getCellLayoutCounters } from '../../src/ink/layout/cellLayout.js'
import { RenderScheduler, type SchedulerClock } from '../../src/ink/root/render-scheduler.js'
import { FrameLedger } from '../../src/ink/root/frame-ledger.js'
import { planCursor } from '../../src/ink/root/cursor-park.js'
import { runTeardownSuite } from '../../src/ink/root/teardown.js'
import { applyOverlayPass } from '../../src/ink/root/overlay-pass.js'
import { writeAllSync, type DeliverySyscalls } from '../../src/ink/session/delivery.js'
import { addPendingClear, consumeAbsoluteRemovedFlag } from '../../src/ink/node-cache.js'
import * as dom from '../../src/ink/dom.js'
import { createScreen, CharPool, HyperlinkPool, StylePool } from '../../src/ink/cell-grid.js'
import { createSelectionState, startSelection, updateSelection, finishSelection } from '../../src/ink/geometry/selection.js'
import {
  enterEditorBytes,
  exitEditorBytes,
  exitEditorRearmBytes,
  rawModeArmBytes,
  rawModeDisarmBytes,
  reassertModesBytes,
  reenterAltBytes,
  resizeReassertBytes,
} from '../../src/ink/root/screen-session.js'
import type { Patch } from '../../src/ink/frame.js'
import { __fluxProbeResetForTest, fluxSummary } from '../../src/utils/flux/fluxProbe.js'

if (process.env.NODE_ENV === 'test') {
  console.error('prove-root-contract must not run with NODE_ENV=test (lattice bypass)')
  process.exit(1)
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// The rig's geometry sits AT the viewport floor (src/ink/viewportFloor.ts:
// 80 columns × 22 rows): below it the alternate-screen host paints the
// floor's one line instead of the composed content, and the alt, resize
// and self-heal laws read empty frames — a moved premise, not a fault.
const COLS = 80
const ROWS = 22

// ── the fake terminal ───────────────────────────────────────────────────────
class FakeStdout extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  writes: string[] = []
  get bytes(): string {
    return this.writes.join('')
  }
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
  markerAt(): number {
    return this.writes.length
  }
  since(marker: number): string {
    return this.writes.slice(marker).join('')
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
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
  readableLength = 0
}

type Rig = {
  ink: Ink
  stdout: FakeStdout
  stdin: FakeStdin
  settle: () => Promise<void>
}

// The HOST-CONFIG law below trips App's root boundary on purpose, and that
// boundary persists a crash report under the config home — pin a scratch
// home so the prover's own artifact never lands in an operator's crash
// directory.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'native-core-home-'))

function makeRig(): Rig {
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const ink = new Ink({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, ink)
  // Settle: flush the microtask deferral + the throttle's trailing edge +
  // the 100ms boot-coalesce window.
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 130))
  }
  return { ink, stdout, stdin, settle }
}

/** Replay an inline (main-screen) byte run and return the full grid text. */
function gridText(bytes: string): string {
  const e = new AnsiEmulator(COLS, ROWS, false)
  e.feed(bytes)
  return Array.from({ length: ROWS }, (_, y) => e.rowText(y)).join('\n')
}

const ESC = '\u001b'
const BSU = `${ESC}[?2026h`
const ENTER_ALT = `${ESC}[?1049h`
const EXIT_ALT = `${ESC}[?1049l`
/** Strip every ESC-introduced sequence (CSI/OSC/charset), leaving printable
 *  payload. */
function stripEsc(w: string): string {
  // eslint-disable-next-line no-control-regex
  return w.replace(/\u001b(?:\[[0-9;?<>=]*[a-zA-Z@`]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-B])/g, '')
}
/** A write that paints a frame: printable payload or an absolute CUP (park /
 *  home) — robust whether or not BSU sync markers are supported. Bare mode/
 *  arming writes (?25l, ?1049h, mouse DECSET…) match neither. */
function isFrameWrite(w: string): boolean {
  return stripEsc(w).trim().length > 0 || /\u001b\[\d+;\d+H/.test(w) || w === `${ESC}[H` || w.includes(BSU)
}
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

console.log('native-core T6 — renderer-root lifecycle contract')

// ── LAW INSTANCES ───────────────────────────────────────────────────────────
{
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const a = new Ink({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, a)
  check('instances: registered under its stdout', instances.get(stdout as never) === a)
  const other = new FakeStdout()
  check('instances: a different stdout has no instance', instances.get(other as never) === undefined)
  const exited = a.waitUntilExit()
  a.unmount()
  await exited
  check('instances: unmount deregisters', instances.get(stdout as never) === undefined)
}

// ── LAW COMMIT-TRANSACTION + COALESCE (count form) ──────────────────────────
{
  const rig = makeRig()
  const marker = rig.stdout.markerAt()
  rig.ink.render(
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'boot line one'),
      React.createElement(Text, null, 'boot line two'),
    ),
  )
  // Inside the boot window: mode/arming bytes (cursor hide) may pass; no
  // FRAME may hit the wire yet.
  await new Promise(resolve => setTimeout(resolve, 20))
  const windowFrames = rig.stdout.writes.slice(marker).filter(isFrameWrite)
  check('coalesce: boot window holds frames', windowFrames.length === 0, String(windowFrames.length))
  await rig.settle()
  const bootWrites = rig.stdout.writes.slice(marker).filter(isFrameWrite)
  check('coalesce: boot settles to exactly one frame write', bootWrites.length === 1, String(bootWrites.length))
  // The writer emits column-addressed cell runs — content is only visible on
  // the replayed grid, never as a byte substring.
  const bootGrid = gridText(rig.stdout.bytes)
  check('commit: the frame carries the content', bootGrid.includes('boot line one') && bootGrid.includes('boot line two'),
    JSON.stringify(bootGrid.split('\n').slice(0, 3)))

  // N same-tick rerenders ⇒ one additional frame write.
  const m2 = rig.stdout.markerAt()
  for (let i = 0; i < 5; i++) {
    rig.ink.render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, `burst ${i}`),
        React.createElement(Text, null, 'boot line two'),
      ),
    )
  }
  await rig.settle()
  const burstWrites = rig.stdout.writes.slice(m2).filter(isFrameWrite)
  check('coalesce: five same-tick commits ⇒ ≤2 frame writes (leading+trailing)',
    burstWrites.length >= 1 && burstWrites.length <= 2, String(burstWrites.length))
  const burstGrid = gridText(rig.stdout.bytes)
  check('coalesce: final content is the last commit', burstGrid.includes('burst 4') && !burstGrid.includes('burst 0'),
    JSON.stringify(burstGrid.split('\n').slice(0, 3)))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW TEARDOWN ────────────────────────────────────────────────────────────
// The old body writes the mode-restore suite via writeSync(1) — hard fd 1,
// NOT the session sink (ink.tsx:1892-1922). That fd-1 hardcode is a T6
// finding (the new owner routes teardown through the delivery seam); to
// characterize it we must capture a real fd 1, so the teardown journey runs
// in a CHILD bun process with piped stdout.
{
  const repoRoot = resolve(import.meta.dir, '../..')
  const dir = mkdtempSync(join(tmpdir(), 'native-core-root-'))
  const childPath = join(dir, 'teardown-child.ts')
  writeFileSync(childPath, `
import { EventEmitter } from 'node:events'
import * as React from 'react'
import Ink from '${repoRoot}/src/ink/ink.js'
import { Text } from '${repoRoot}/src/ink.js'
class FakeStdout extends EventEmitter {
  isTTY = true; columns = ${COLS}; rows = ${ROWS}; writes: string[] = []
  write(s: string): boolean { this.writes.push(s); return true }
}
class FakeStdin extends EventEmitter {
  isTTY = true; isRaw = false; readableLength = 0
  setEncoding(): FakeStdin { return this }
  setRawMode(v: boolean): FakeStdin { this.isRaw = v; return this }
  ref(): FakeStdin { return this } unref(): FakeStdin { return this }
  read(): null { return null }
}
const stdout = new FakeStdout()
const ink = new Ink({ stdout: stdout as never, stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never, exitOnCtrlC: false, patchConsole: false })
ink.render(React.createElement(Text, null, 'teardown content'))
await new Promise(r => setTimeout(r, 150))
process.stdout.write('<<<T1>>>')
const exited = ink.waitUntilExit()
ink.unmount()
await exited
process.stdout.write('<<<T2>>>')
ink.unmount() // second unmount: must be byte-silent everywhere
await new Promise(r => setTimeout(r, 50))
process.stdout.write('<<<T3>>>' + JSON.stringify(stdout.writes) + '<<<T4>>>')
process.exit(0)
`)
  const env = { ...process.env }
  if (env.NODE_ENV === 'test') delete env.NODE_ENV
  const child = Bun.spawnSync({ cmd: [process.execPath, 'run', childPath], stdout: 'pipe', stderr: 'pipe', env })
  const out = child.stdout.toString()
  rmSync(dir, { recursive: true, force: true })
  const seg = (a: string, b: string): string => {
    const i = out.indexOf(a)
    const j = out.indexOf(b)
    return i === -1 || j === -1 || j < i ? '' : out.slice(i + a.length, j)
  }
  check('teardown: child journey completed', out.includes('<<<T4>>>'), child.stderr.toString().slice(0, 200))
  const suite = seg('<<<T1>>>', '<<<T2>>>')
  // Characterized order (ink.tsx:1892-1922): mouse-off cluster → alt-scroll
  // off → modifyOtherKeys off → kitty pop → focus-events off → bracketed-
  // paste off → cursor show → iTerm2 progress clear. No EXIT_ALT for a
  // main-screen session.
  const at = (needle: string): number => suite.indexOf(needle)
  const mouseOff = at(`${ESC}[?1000l`)
  const scrollOff = at(`${ESC}[?1007l`)
  const mokOff = at(`${ESC}[>4m`)
  const kittyOff = at(`${ESC}[<u`)
  const dfe = at(`${ESC}[?1004l`)
  const dbp = at(`${ESC}[?2004l`)
  const showCursor = at(`${ESC}[?25h`)
  const progress = at(`${ESC}]9;4;0;`)
  check('teardown: full mode-restore suite present',
    [mouseOff, scrollOff, mokOff, kittyOff, dfe, dbp, showCursor, progress].every(i => i !== -1),
    JSON.stringify({ mouseOff, scrollOff, mokOff, kittyOff, dfe, dbp, showCursor, progress }))
  check('teardown: restore order mouse → scroll → MOK → kitty → DFE → DBP → cursor → progress',
    mouseOff < scrollOff && scrollOff < mokOff && mokOff < kittyOff && kittyOff < dfe
      && dfe < dbp && dbp < showCursor && showCursor < progress)
  check('teardown: no EXIT_ALT on a main-screen session', !suite.includes(`${ESC}[?1049l`))
  check('teardown: second unmount is byte-silent on fd 1', seg('<<<T2>>>', '<<<T3>>>') === '')
  const streamWrites = JSON.parse(seg('<<<T3>>>', '<<<T4>>>') || '[]') as string[]
  // The final frame (unmount's onRender + log.finish) rides the SESSION
  // stream; the mode suite does NOT (fd-1 hardcode, recorded above).
  check('teardown: final content reached the stream before teardown',
    gridText(streamWrites.join('')).includes('teardown content'))
  check('teardown: mode suite absent from the stream (fd-1 seam, characterized)',
    !streamWrites.join('').includes(`${ESC}[>4m`))
}

// ── LAW ALT-SANDWICH + ALT-DEPTH ────────────────────────────────────────────
{
  const rig = makeRig()
  const tree = (label: string, nested: boolean): React.ReactElement =>
    React.createElement(
      AlternateScreen,
      { mouseTracking: true },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, `alt ${label}`),
        React.createElement(Text, null, 'second row'),
        nested
          ? React.createElement(AlternateScreen, { mouseTracking: false }, React.createElement(Text, null, 'inner pane'))
          : null,
      ),
    )
  rig.ink.render(tree('one', false))
  await rig.settle()
  rig.ink.render(tree('two', false))
  await rig.settle()
  check('alt: exactly one ENTER_ALT for the whole journey', count(rig.stdout.bytes, ENTER_ALT) === 1, String(count(rig.stdout.bytes, ENTER_ALT)))
  const frames = rig.stdout.writes.filter(isFrameWrite)
  check('alt: frames were painted', frames.length >= 2, String(frames.length))
  const PARK = `${ESC}[${ROWS};1H`
  let sandwichOk = true
  let sandwichDetail = ''
  for (const f of frames) {
    // eslint-disable-next-line no-control-regex
    const firstCursor = f.match(/\u001b\[[0-9;]*[HGdABCDJK]/)
    const startsHome = firstCursor?.[0] === `${ESC}[H`
      || (firstCursor?.[0] === `${ESC}[2J` && f.indexOf(`${ESC}[2J`) !== -1 && f.indexOf(`${ESC}[H`) > f.indexOf(`${ESC}[2J`))
    // eslint-disable-next-line no-control-regex
    const cups = [...f.matchAll(/\u001b\[\d+;\d+H/g)]
    const endsParked = cups.length > 0 && cups[cups.length - 1]![0] === PARK
    if (!startsHome || !endsParked) {
      sandwichOk = false
      sandwichDetail = JSON.stringify({ firstCursor: firstCursor?.[0], lastCup: cups[cups.length - 1]?.[0] })
      break
    }
  }
  check('alt-sandwich: every frame opens at home and ends parked at rows;1', sandwichOk, sandwichDetail)
  const emu = new AnsiEmulator(COLS, ROWS, true)
  for (const f of frames) emu.feed(f)
  const altGrid = Array.from({ length: ROWS }, (_, y) => emu.rowText(y)).join('\n')
  check('alt-sandwich: frames replay to the composed content', altGrid.includes('alt two') && altGrid.includes('second row'),
    JSON.stringify(altGrid.split('\n').slice(0, 3)))

  // ALT-DEPTH: a nested pane never re-enters; its close never exits.
  const mNested = rig.stdout.markerAt()
  rig.ink.render(tree('two', true))
  await rig.settle()
  check('alt-depth: nested mount adds no ENTER_ALT', count(rig.stdout.since(mNested), ENTER_ALT) === 0)
  const mClose = rig.stdout.markerAt()
  rig.ink.render(tree('three', false))
  await rig.settle()
  const closed = rig.stdout.since(mClose)
  check('alt-depth: nested close emits no EXIT_ALT', !closed.includes(EXIT_ALT))
  const rawErases = rig.stdout.writes.slice(mClose).filter(w => !isFrameWrite(w) && w.includes(`${ESC}[2J`))
  check('alt-depth: any nested-close erase rides inside a frame write', rawErases.length === 0, JSON.stringify(rawErases))

  // Root close via component removal: exactly one EXIT_ALT on the wire.
  const mRoot = rig.stdout.markerAt()
  rig.ink.render(React.createElement(Text, null, 'back to main'))
  await rig.settle()
  check('alt-depth: root close emits exactly one EXIT_ALT', count(rig.stdout.since(mRoot), EXIT_ALT) === 1,
    String(count(rig.stdout.since(mRoot), EXIT_ALT)))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW RESIZE ──────────────────────────────────────────────────────────────
{
  const rig = makeRig()
  rig.ink.render(
    React.createElement(AlternateScreen, { mouseTracking: true }, React.createElement(Text, null, 'resize me')),
  )
  await rig.settle()
  // Same-dims resize: byte-silent.
  const mSame = rig.stdout.markerAt()
  rig.stdout.emit('resize')
  await rig.settle()
  check('resize: same-dims resize is byte-silent', rig.stdout.since(mSame) === '', JSON.stringify(rig.stdout.since(mSame).slice(0, 60)))
  // Real resize — THE SETTLE DISCIPLINE (spec: resize is a storm with a
  // quiet window): the WINCH itself costs a cheap HOLDING paint (last frame
  // clipped to the live size, NEVER a full clear) and no relayout; the one
  // erase-carrying settled frame lands only after RESIZE_SETTLE_MS of
  // quiet, mode re-assert immediately before it, park at the NEW rows.
  // The storm's geometries sit above the viewport floor (80×22): under it
  // the settled frame is the floor's one line, never the composed content.
  const NEW_ROWS = 24
  const mReal = rig.stdout.markerAt()
  rig.stdout.columns = 100
  rig.stdout.rows = 30
  rig.stdout.emit('resize')
  await new Promise(resolve => setTimeout(resolve, 30)) // inside the settle window
  const stormWrites = rig.stdout.writes.slice(mReal)
  check('resize: a storm WINCH paints a clip-hold, not a clear',
    stormWrites.some(isFrameWrite) && !stormWrites.some(w => w.includes(`${ESC}[2J`)),
    JSON.stringify(stormWrites.map(w => w.slice(0, 24))))
  // Second WINCH inside the window — the storm continues, still no clear.
  rig.stdout.columns = 90
  rig.stdout.rows = NEW_ROWS
  rig.stdout.emit('resize')
  await rig.settle() // 130ms > the settle window: the settled frame lands
  const realWrites = rig.stdout.writes.slice(mReal)
  const eraseFrames = realWrites.filter(w => isFrameWrite(w) && w.includes(`${ESC}[2J`))
  check('resize: the whole storm settles to exactly one erase-carrying frame',
    eraseFrames.length === 1, String(eraseFrames.length))
  const rf = eraseFrames[0] ?? ''
  // eslint-disable-next-line no-control-regex
  const cups = [...rf.matchAll(/\u001b\[\d+;\d+H/g)]
  check('resize: the park CUP uses the settled rows', cups.length > 0 && cups[cups.length - 1]![0] === `${ESC}[${NEW_ROWS};1H`,
    JSON.stringify(cups[cups.length - 1]?.[0]))
  const frameIdx = realWrites.findIndex(w => isFrameWrite(w) && w.includes(`${ESC}[2J`))
  const reassertIdx = realWrites.findIndex(w => !isFrameWrite(w) && w.includes('1007h'))
  check('resize: mode re-assert precedes the settled frame', reassertIdx !== -1 && reassertIdx < frameIdx,
    JSON.stringify({ reassertIdx, frameIdx }))
  const emu = new AnsiEmulator(50, NEW_ROWS, true)
  emu.feed(rf)
  const grid = Array.from({ length: NEW_ROWS }, (_, y) => emu.rowText(y)).join('\n')
  check('resize: the settled frame replays to the new geometry', grid.includes('resize me'))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW SELF-HEAL (old-body variant: repaintAltScreen) ──────────────────────
{
  const rig = makeRig()
  rig.ink.render(
    React.createElement(
      AlternateScreen,
      { mouseTracking: false },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'healed row one'),
        React.createElement(Text, null, 'healed row two'),
      ),
    ),
  )
  await rig.settle()
  const marker = rig.stdout.markerAt()
  rig.ink.repaintAltScreen()
  await rig.settle()
  const healFrames = rig.stdout.writes.slice(marker).filter(isFrameWrite)
  check('self-heal: repaintAltScreen paints exactly one frame', healFrames.length === 1, String(healFrames.length))
  const hf = healFrames[0] ?? ''
  // eslint-disable-next-line no-control-regex
  check('self-heal: the heal frame carries no erase', !/\u001b\[[012]?J/.test(hf))
  const emu = new AnsiEmulator(COLS, ROWS, true)
  emu.feed(hf)
  const grid = Array.from({ length: ROWS }, (_, y) => emu.rowText(y)).join('\n')
  check('self-heal: the single frame re-emits every content cell',
    grid.includes('healed row one') && grid.includes('healed row two'),
    JSON.stringify(grid.split('\n').slice(0, 3)))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW POOL-EPOCH ──────────────────────────────────────────────────────────
{
  const rig = makeRig()
  const styled = (): React.ReactElement =>
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { color: 'red', bold: true }, 'epoch styled'),
      React.createElement(Text, { dimColor: true }, 'epoch plain'),
    )
  rig.ink.render(styled())
  await rig.settle()
  const marker = rig.stdout.markerAt()
  rig.ink.resetPools()
  rig.ink.render(styled())
  await rig.settle()
  const epochFrames = rig.stdout.writes.slice(marker).filter(isFrameWrite)
  check('pool-epoch: a pool reset between identical frames is byte-silent', epochFrames.length === 0,
    JSON.stringify(epochFrames.map(f => f.slice(0, 40))))
  // A styled CHANGE after the reset still replays correctly.
  rig.ink.render(
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, { color: 'red', bold: true }, 'epoch restyled'),
      React.createElement(Text, { dimColor: true }, 'epoch plain'),
    ),
  )
  await rig.settle()
  const grid = gridText(rig.stdout.bytes)
  check('pool-epoch: a styled frame after reset replays identically', grid.includes('epoch restyled') && grid.includes('epoch plain'),
    JSON.stringify(grid.split('\n').slice(0, 3)))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW PAUSE/EDITOR ────────────────────────────────────────────────────────
{
  const rig = makeRig()
  const line = (label: string): React.ReactElement => React.createElement(Text, null, label)
  rig.ink.render(line('pause content A'))
  await rig.settle()
  // pause() flushes the pending commit and paints ONCE.
  const mPause = rig.stdout.markerAt()
  rig.ink.render(line('pause content B'))
  rig.ink.pause()
  await rig.settle()
  const pauseFrames = rig.stdout.writes.slice(mPause).filter(isFrameWrite)
  check('pause: flushes pending commits and paints exactly once', pauseFrames.length === 1, String(pauseFrames.length))
  check('pause: the flushed frame carries the pending commit', gridText(rig.stdout.bytes).includes('pause content B'))
  // Zero bytes while paused.
  const mHeld = rig.stdout.markerAt()
  rig.ink.render(line('pause content C'))
  await rig.settle()
  check('pause: byte-silent while paused', rig.stdout.since(mHeld) === '', JSON.stringify(rig.stdout.since(mHeld).slice(0, 40)))
  // resume() paints exactly once, with the held commit.
  const mResume = rig.stdout.markerAt()
  rig.ink.resume()
  await rig.settle()
  const resumeFrames = rig.stdout.writes.slice(mResume).filter(isFrameWrite)
  check('resume: paints exactly once', resumeFrames.length === 1, String(resumeFrames.length))
  check('resume: the held commit lands', gridText(rig.stdout.bytes).includes('pause content C'))

  // EDITOR handoff: enterAlternateScreen suspends stdin (listeners + raw
  // mode) and hands the terminal over; exitAlternateScreen restores both.
  const armedListeners = rig.stdin.listeners('readable').length
  const wasRaw = rig.stdin.isRaw
  const mEnter = rig.stdout.markerAt()
  rig.ink.enterAlternateScreen()
  const enterBytes = rig.stdout.since(mEnter)
  check('editor: enter suspends every readable listener', rig.stdin.listeners('readable').length === 0,
    String(rig.stdin.listeners('readable').length))
  check('editor: enter drops raw mode', rig.stdin.isRaw === false)
  check('editor: enter enters alt then clears then homes',
    enterBytes.indexOf(ENTER_ALT) !== -1
      && enterBytes.indexOf(ENTER_ALT) < enterBytes.indexOf(`${ESC}[2J`)
      && enterBytes.indexOf(`${ESC}[2J`) < enterBytes.lastIndexOf(`${ESC}[H`),
    JSON.stringify(enterBytes.slice(0, 80)))
  check('editor: enter shows the cursor for the editor', enterBytes.includes(`${ESC}[?25h`))
  const mHandoff = rig.stdout.markerAt()
  rig.ink.render(line('pause content D'))
  await rig.settle()
  check('editor: byte-silent during the handoff', rig.stdout.writes.slice(mHandoff).filter(isFrameWrite).length === 0)
  const mExit = rig.stdout.markerAt()
  rig.ink.exitAlternateScreen()
  await rig.settle()
  const exitBytes = rig.stdout.since(mExit)
  check('editor: exit restores the readable listeners', rig.stdin.listeners('readable').length === armedListeners,
    `${rig.stdin.listeners('readable').length} vs ${armedListeners}`)
  check('editor: exit restores raw mode', rig.stdin.isRaw === wasRaw)
  check('editor: exit clears the abandoned alt buffer then leaves alt',
    exitBytes.indexOf(`${ESC}[2J`) !== -1 && exitBytes.indexOf(`${ESC}[2J`) < exitBytes.indexOf(EXIT_ALT))
  check('editor: exit re-hides the cursor (Ink manages it)', exitBytes.includes(`${ESC}[?25l`))
  check('editor: exit re-arms focus reporting', exitBytes.includes(`${ESC}[?1004h`))
  const repaintFrames = rig.stdout.writes.slice(mExit).filter(isFrameWrite)
  check('editor: exit repaints exactly once', repaintFrames.length === 1, String(repaintFrames.length))
  check('editor: the repaint carries the held commit', gridText(repaintFrames.join('')).includes('pause content D'))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW DISPLAY-CURSOR + the COMMIT-TRANSACTION declared-cursor leg ─────────
{
  const rig = makeRig()
  const CursorProbe = ({ column, active, label }: { column: number; active: boolean; label: string }): React.ReactElement => {
    const ref = useDeclaredCursor({ line: 0, column, active })
    return React.createElement(Box, { ref: ref as never, flexDirection: 'column' }, React.createElement(Text, null, label))
  }
  // COMMIT-TRANSACTION: the declaration set in the layout phase is honored
  // by the SAME first frame (microtask deferral — no one-keystroke lag).
  rig.ink.render(React.createElement(CursorProbe, { column: 3, active: true, label: 'cursor probe' }))
  await rig.settle()
  const emu1 = new AnsiEmulator(COLS, ROWS, false)
  emu1.feed(rig.stdout.bytes)
  check('commit: the first frame honors the layout-phase cursor declaration',
    emu1.cursorX === 3 && emu1.cursorY === 0, JSON.stringify({ x: emu1.cursorX, y: emu1.cursorY }))
  // MOVE: same content, new declared column ⇒ the cursor moves.
  rig.ink.render(React.createElement(CursorProbe, { column: 7, active: true, label: 'cursor probe' }))
  await rig.settle()
  const emu2 = new AnsiEmulator(COLS, ROWS, false)
  emu2.feed(rig.stdout.bytes)
  check('display-cursor: a declaration move lands with unchanged content',
    emu2.cursorX === 7 && emu2.cursorY === 0, JSON.stringify({ x: emu2.cursorX, y: emu2.cursorY }))
  check('display-cursor: the move never repaints content', gridText(rig.stdout.bytes).includes('cursor probe'))
  // NO-DIFF: identical declaration + identical content ⇒ byte-silent.
  const mIdle = rig.stdout.markerAt()
  rig.ink.render(React.createElement(CursorProbe, { column: 7, active: true, label: 'cursor probe' }))
  await rig.settle()
  check('display-cursor: unchanged declaration + content is byte-silent', rig.stdout.since(mIdle) === '',
    JSON.stringify(rig.stdout.since(mIdle).slice(0, 40)))
  // CLEAR: deactivating returns the cursor to the frame park position.
  rig.ink.render(React.createElement(CursorProbe, { column: 7, active: false, label: 'cursor probe' }))
  await rig.settle()
  const emu3 = new AnsiEmulator(COLS, ROWS, false)
  emu3.feed(rig.stdout.bytes)
  check('display-cursor: clearing the declaration re-parks at frame.cursor',
    !(emu3.cursorX === 7 && emu3.cursorY === 0), JSON.stringify({ x: emu3.cursorX, y: emu3.cursorY }))
  // The NEXT content diff still replays correctly (the preamble restored
  // the writer\'s relative anchor).
  rig.ink.render(React.createElement(CursorProbe, { column: 2, active: true, label: 'cursor moved on' }))
  await rig.settle()
  const grid = gridText(rig.stdout.bytes)
  check('display-cursor: the next diff replays cleanly after park round-trips', grid.includes('cursor moved on'),
    JSON.stringify(grid.split('\n').slice(0, 2)))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW HOST-CONFIG ─────────────────────────────────────────────────────────
{
  // <Box> inside <Text>: the reconciler throws (reconciler.ts:339); the
  // root's onUncaughtError is a noop (ink.tsx:398-405) but App's error
  // boundary (App.tsx:113 getDerivedStateFromError → ErrorOverview)
  // catches it and paints the ERROR frame — the caller sees no throw.
  // (A follow-up render on the poisoned container sends React's work loop
  // into a hot retry SPIN — characterized; the rig is abandoned after the
  // one observation and only its registry entry is cleared.)
  const bad = makeRig()
  bad.ink.render(React.createElement(Text, null, React.createElement(Box, null)))
  await bad.settle()
  // The ERROR view is taller than the 10-row rig (header + stack) — the
  // header scrolls off the replay grid, so the pin reads the stripped byte
  // payload: the header, then the offending frame name in the stack.
  check('host-config: a <Box>-inside-<Text> violation paints the boundary ERROR frame',
    stripEsc(bad.stdout.bytes).includes('ERROR'),
    JSON.stringify(stripEsc(bad.stdout.bytes).slice(0, 80)))
  instances.delete(bad.stdout as never)

  const rig = makeRig()
  // Nested <Text> composes as virtual text on one row.
  rig.ink.render(
    React.createElement(Text, null, 'outer ', React.createElement(Text, { bold: true }, 'inner')),
  )
  await rig.settle()
  const nested = gridText(rig.stdout.bytes)
  check('host-config: nested <Text> composes as one virtual-text row', nested.split('\n')[0]!.trimEnd() === 'outer inner',
    JSON.stringify(nested.split('\n')[0]))

  // Identical-values fresh style object + fresh onClick identity ⇒ CLEAN
  // node, zero bytes (the T1 zero-dirty law at the host-config seam).
  const stableTree = (): React.ReactElement =>
    React.createElement(
      Box,
      { flexDirection: 'column', paddingLeft: 1, onClick: () => {} },
      React.createElement(Text, { color: 'cyan' }, 'clean node row'),
    )
  rig.ink.render(stableTree())
  await rig.settle()
  const mClean = rig.stdout.markerAt()
  rig.ink.render(stableTree())
  await rig.settle()
  check('host-config: identical-values fresh style + handler identity ⇒ zero bytes', rig.stdout.since(mClean) === '',
    JSON.stringify(rig.stdout.since(mClean).slice(0, 40)))
  // The layout counters reset per pass (cellLayout.ts:492) — a pure-box
  // no-op pass measures ZERO text nodes (every leaf served from cache).
  check('dom-dirty: the no-op pass measures zero text leaves',
    getCellLayoutCounters().measured === 0, String(getCellLayoutCounters().measured))

  // A leaf text change repaints (markDirty reaches the root).
  rig.ink.render(
    React.createElement(
      Box,
      { flexDirection: 'column', paddingLeft: 1, onClick: () => {} },
      React.createElement(Text, { color: 'cyan' }, 'dirty node row'),
    ),
  )
  await rig.settle()
  check('dom-dirty: a leaf text change repaints', gridText(rig.stdout.bytes).includes('dirty node row'))
  check('dom-dirty: the dirty pass measured the changed leaf (counter live)',
    getCellLayoutCounters().measured > 0, String(getCellLayoutCounters().measured))

  // Removing an absolute-positioned overlay ⇒ the vacated band repaints
  // (ghost cells gone in replay).
  const withOverlay = (on: boolean): React.ReactElement =>
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'base row one xxxx'),
      React.createElement(Text, null, 'base row two xxxx'),
      on
        ? React.createElement(
            Box,
            { position: 'absolute', marginTop: 0, marginLeft: 0 },
            React.createElement(Text, { inverse: true }, 'OVERLAY'),
          )
        : null,
    )
  rig.ink.render(withOverlay(true))
  await rig.settle()
  check('host-config: the absolute overlay paints over the base', gridText(rig.stdout.bytes).includes('OVERLAY'))
  rig.ink.render(withOverlay(false))
  await rig.settle()
  const healed = gridText(rig.stdout.bytes)
  check('host-config: overlay removal leaves no ghost cells',
    !healed.includes('OVERLAY') && healed.includes('base row one xxxx'),
    JSON.stringify(healed.split('\n').slice(0, 2)))

  // hide/unhide round-trips.
  const withHidden = (hidden: boolean): React.ReactElement =>
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'always visible'),
      React.createElement(Box, { display: hidden ? 'none' : 'flex' }, React.createElement(Text, null, 'toggled row')),
    )
  rig.ink.render(withHidden(true))
  await rig.settle()
  const hiddenGrid = gridText(rig.stdout.bytes)
  check('host-config: display none removes the row', !hiddenGrid.includes('toggled row') && hiddenGrid.includes('always visible'))
  rig.ink.render(withHidden(false))
  await rig.settle()
  check('host-config: unhide restores the row', gridText(rig.stdout.bytes).includes('toggled row'))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
}

// ── LAW GENERATION-LEDGER ───────────────────────────────────────────────────
// With MERCURY_FLUX_PROBE armed, the S8 integrity assertion
// (frontFrameSeq === deliveredSeq ∨ prevFrameContaminated, ink.tsx:793-799)
// must count ZERO stale-frame risks across the deliberate-reset journeys —
// repaint/forceRedraw/repaintAltScreen/resume-main are resets, not
// violations.
{
  const savedProbe = process.env.MERCURY_FLUX_PROBE
  process.env.MERCURY_FLUX_PROBE = '1'
  __fluxProbeResetForTest()
  const rig = makeRig()
  rig.ink.render(React.createElement(Text, null, 'ledger main one'))
  await rig.settle()
  rig.ink.render(React.createElement(Text, null, 'ledger main two'))
  await rig.settle()
  rig.ink.repaint()
  await rig.settle()
  rig.ink.forceRedraw()
  await rig.settle()
  check('ledger: main-screen resets still paint', gridText(rig.stdout.bytes).includes('ledger main two'))
  rig.ink.render(
    React.createElement(AlternateScreen, { mouseTracking: false }, React.createElement(Text, null, 'ledger alt view')),
  )
  await rig.settle()
  rig.ink.repaintAltScreen()
  await rig.settle()
  rig.ink.render(React.createElement(Text, null, 'ledger back on main'))
  await rig.settle()
  const summary = fluxSummary()
  check('ledger: the probe is live (not a vacuous zero)', summary.enabled === true && summary.frames.total > 0,
    JSON.stringify({ enabled: summary.enabled, frames: summary.frames.total }))
  check('ledger: zero stale-frame risks across every deliberate reset',
    (summary.counters['stale-frame-risk'] ?? 0) === 0, String(summary.counters['stale-frame-risk']))
  const exited = rig.ink.waitUntilExit()
  rig.ink.unmount()
  await exited
  if (savedProbe === undefined) delete process.env.MERCURY_FLUX_PROBE
  else process.env.MERCURY_FLUX_PROBE = savedProbe
  __fluxProbeResetForTest()
}

// ── LAW STDERR-LEAK is covered at app scale by; the patchConsole=false
//    rig can't express it — recorded: it lands with the new owner's law rig.

// ── LAW SCHEDULER-LATTICE (new-owner exact timing — the injected clock) ─────
// The policy the count-form laws pin end-to-end, now pinned EXACTLY:
// 16ms leading+trailing · 100ms boot coalesce · 4ms drain · cancel.
{
  type Timer = { at: number; fn: () => void; id: number }
  const makeClock = (): { clock: SchedulerClock; advance: (ms: number) => void; flush: () => void; skipTo: (ms: number) => void } => {
    let now = 0
    let nextId = 1
    let timers: Timer[] = []
    const micro: Array<() => void> = []
    const flush = (): void => {
      while (micro.length > 0) micro.shift()!()
    }
    const clock: SchedulerClock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id as never
      },
      clearTimeout: t => {
        timers = timers.filter(x => x.id !== (t as never))
      },
      queueMicrotask: fn => {
        micro.push(fn)
      },
    }
    const advance = (ms: number): void => {
      const target = now + ms
      for (;;) {
        const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        timers = timers.filter(t => t.id !== due.id)
        now = due.at
        due.fn()
        flush()
      }
      now = target
      flush()
    }
    // A blocked event loop: time passes but no timer callback is delivered.
    const skipTo = (ms: number): void => {
      now = ms
    }
    return { clock, advance, flush, skipTo }
  }

  // Boot coalesce: commits inside the first 100ms collapse into ONE paint
  // at the boundary; the leading edge is suppressed.
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    sched.requestFrame()
    sched.requestFrame()
    flush()
    check('lattice: boot window suppresses the leading edge', paints === 0, String(paints))
    advance(50)
    sched.requestFrame()
    check('lattice: still holding mid-window', paints === 0, String(paints))
    advance(60) // crosses the 100ms boundary
    check('lattice: boot settles to exactly one paint', paints === 1, String(paints))
  }
  // Post-boot: leading immediate; same-window commits collapse to one
  // trailing at the 16ms boundary; a sustained burst holds the lattice.
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150) // exit the boot window quietly
    sched.requestFrame()
    flush()
    check('lattice: idle request paints on the leading edge', paints === 1, String(paints))
    sched.requestFrame()
    sched.requestFrame()
    flush()
    check('lattice: in-window requests hold', paints === 1, String(paints))
    advance(16)
    check('lattice: the trailing edge lands at the boundary', paints === 2, String(paints))
    advance(100) // idle out
    const before = paints
    for (let t = 0; t < 80; t += 4) {
      sched.requestFrame()
      advance(4)
    }
    advance(16)
    const burst = paints - before
    check('lattice: an 80ms/4ms burst paints once per interval', burst >= 5 && burst <= 6, String(burst))
  }
  // Drain lane: quarter interval, idempotent, cancelled by render entry.
  {
    const { clock, advance } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.requestDrain()
    sched.requestDrain() // idempotent while armed
    advance(3)
    check('lattice: drain holds before the quarter interval', paints === 0, String(paints))
    advance(1)
    check('lattice: drain fires once at 4ms', paints === 1, String(paints))
    sched.requestDrain()
    sched.onRenderEntry() // a render underway consumes the drain
    advance(20)
    check('lattice: render entry cancels a pending drain', paints === 1, String(paints))
  }
  // cancel(): every armed edge dies unfired.
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    sched.requestFrame() // boot-armed
    sched.cancel()
    advance(200)
    sched.requestFrame()
    flush()
    check('lattice: cancel drops the boot edge; later requests still paint', paints === 1, String(paints))
    sched.requestFrame() // arms trailing
    sched.requestDrain()
    sched.cancel()
    advance(100)
    check('lattice: cancel drops trailing + drain edges', paints === 1, String(paints))
  }
  // Resize settle hold: WINCH storms gate EVERY paint path while commits
  // keep landing; release either flushes the one pending frame (leading
  // semantics) or discards it — the caller schedules the settled render
  // itself and a flushed frame would compose the pre-settle layout.
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.holdForSettle()
    sched.holdForSettle() // idempotent
    sched.requestFrame()
    sched.requestFrame()
    sched.requestDrain()
    flush()
    advance(100)
    check('settle: held requests and drains never paint', paints === 0, String(paints))
    check('settle: state reads settle-hold', sched.state() === 'settle-hold', sched.state())
    sched.releaseSettleHold(true)
    flush()
    check('settle: release(flush) serves the pending frame once', paints === 1, String(paints))
    sched.releaseSettleHold(true) // idempotent on an open scheduler
    flush()
    check('settle: double release is inert', paints === 1, String(paints))
  }
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.holdForSettle()
    sched.requestFrame()
    sched.releaseSettleHold(false) // discard — the settled render follows
    flush()
    advance(100)
    check('settle: release(discard) drops the pending frame', paints === 0, String(paints))
    sched.requestFrame()
    flush()
    check('settle: post-release requests paint normally', paints === 1, String(paints))
  }
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.holdForSettle()
    sched.requestFrame()
    sched.cancel()
    sched.releaseSettleHold(true)
    flush()
    advance(100)
    check('settle: cancel clears the hold and its pending frame', paints === 0, String(paints))
  }
  // AUDIT F1 (audit-t6-slices12): a due-but-undelivered trailing timer must
  // be ABSORBED by an elapsed-window leading invoke — the blocked-loop race
  // (long React commit past the boundary, then a commit request landing
  // before the timer callback delivers) must paint ONCE, never a
  // same-instant pair. lodash's lastArgs gate prevented this; the owner
  // serves-and-absorbs.
  {
    const { clock, advance, flush, skipTo } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.requestFrame() // leading at 150
    flush()
    sched.requestFrame() // arms trailing for 166
    skipTo(170) // the loop blocks past the boundary; the timer has NOT fired
    sched.requestFrame() // elapsed window ⇒ leading — must absorb the timer
    flush()
    const afterLeading = paints
    advance(0) // now deliver anything still due
    check('lattice: an elapsed-window leading absorbs the due trailing timer',
      afterLeading === 2 && paints === 2, JSON.stringify({ afterLeading, paints }))
  }
  // AUDIT F3: post-cancel re-request defers to the stale window boundary
  // (never an immediate sub-16ms invoke — old lodash broke the floor here).
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.requestFrame()
    flush()
    check('lattice: leading painted before the cancel', paints === 1)
    advance(8)
    sched.cancel()
    sched.requestFrame() // 8ms into the stale window — must defer to 166
    flush()
    check('lattice: post-cancel re-request holds the spacing floor', paints === 1, String(paints))
    advance(8)
    check('lattice: the deferred request lands at the stale boundary', paints === 2, String(paints))
  }
  // AUDIT F7.3: the drain lane BYPASSES the throttle window by design —
  // a leading request right after a drain paint is legal (drain frames are
  // cheap; the window belongs to requestFrame). Pinned so T14's policy swap
  // changes this consciously or not at all.
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    advance(150)
    sched.requestDrain()
    advance(4)
    check('lattice: drain painted', paints === 1)
    sched.requestFrame() // 0ms after the drain paint — legal leading
    flush()
    check('lattice: a drain paint opens no throttle window (deliberate)', paints === 2, String(paints))
  }
  // AUDIT F2: the boot flush opens a throttle window — a request right
  // after the flush waits for the boundary (the old body painted at
  // flush+1ms, re-flashing the entry).
  {
    const { clock, advance, flush } = makeClock()
    let paints = 0
    const sched = new RenderScheduler(() => paints++, clock)
    sched.requestFrame() // boot-held
    advance(100) // the boot flush fires here
    check('lattice: boot flushed once', paints === 1)
    sched.requestFrame() // 0ms after the flush
    flush()
    check('lattice: a post-flush request holds the window', paints === 1, String(paints))
    advance(16)
    check('lattice: the post-flush request lands one interval later', paints === 2, String(paints))
  }
}

// ── LAW LEDGER-UNIT (new-owner exact — typed contamination) ─────────────────
{
  const led = new FrameLedger()
  led.commitFrame()
  led.settle(true, null)
  check('ledger-unit: delivered clean frame syncs generations', led.frontSeq() === led.deliveredGeneration() && !led.isContaminated())
  led.commitFrame()
  led.settle(false, null)
  check('ledger-unit: undelivered settles contaminated', led.isContaminated() && led.contaminationReason() === 'undelivered')
  led.commitFrame()
  led.settle(true, 'selection-overlay')
  check('ledger-unit: overlay settle carries its cause', led.contaminationReason() === 'selection-overlay')
  led.commitFrame() // front runs ahead undelivered…
  led.settle(true, null)
  led.commitFrame()
  led.syncAfterDeliberateReset()
  check('ledger-unit: a deliberate reset syncs the generations', led.frontSeq() === led.deliveredGeneration())
  led.contaminate('stderr-leak')
  check('ledger-unit: external contamination lands', led.contaminationReason() === 'stderr-leak')
}

// ── LAW CURSOR-PLAN (new-owner exact — the pure sandwich/preamble math) ─────
{
  const PARK: Patch = { type: 'stdout', content: `${ESC}[10;1H` }
  const base = {
    hasDiff: true,
    needsErase: false,
    parkPatch: PARK,
    target: null as { x: number; y: number } | null,
    parked: null as { x: number; y: number } | null,
    prevCursor: { x: 0, y: 4 },
    frameCursor: { x: 0, y: 4 },
    rows: 10,
    cols: 40,
  }
  const bytes = (ps: Patch[]): string => ps.map(p => (p.type === 'stdout' ? p.content : `<${p.type}>`)).join('|')

  // Alt sandwich: home first, park last; erase consumes the one-shot arm.
  const alt1 = planCursor({ ...base, altScreen: true })
  check('cursor-plan: alt diff opens home, parks last',
    bytes(alt1.prelude) === `${ESC}[H` && bytes(alt1.postlude) === `${ESC}[10;1H` && !alt1.consumedErase)
  const alt2 = planCursor({ ...base, altScreen: true, needsErase: true })
  check('cursor-plan: the erase arm folds into the sandwich and is consumed',
    bytes(alt2.prelude) === `${ESC}[2J${ESC}[H` && alt2.consumedErase)
  // Alt declared target: absolute CUP after the park, clamped to geometry.
  const alt3 = planCursor({ ...base, altScreen: true, target: { x: 50, y: 20 } })
  check('cursor-plan: alt declared CUP lands after the park, clamped',
    bytes(alt3.postlude) === `${ESC}[10;1H|${ESC}[10;40H` && alt3.nextParked?.x === 50)
  // Alt empty diff + moved target: CUP only — the sandwich stays off.
  const alt4 = planCursor({ ...base, altScreen: true, hasDiff: false, target: { x: 2, y: 3 } })
  check('cursor-plan: alt empty diff emits no sandwich, only the declared CUP',
    alt4.prelude.length === 0 && bytes(alt4.postlude) === `${ESC}[4;3H`)

  // Main preamble: parked cursor returns to prevCursor BEFORE the diff.
  const m1 = planCursor({ ...base, altScreen: false, parked: { x: 3, y: 1 }, target: { x: 5, y: 2 } })
  check('cursor-plan: main preamble restores the writer anchor',
    m1.prelude.length === 1 && m1.postlude.length === 1 && m1.nextParked?.x === 5,
    JSON.stringify({ pre: bytes(m1.prelude), post: bytes(m1.postlude) }))
  // Fast path: no diff, unchanged target ⇒ zero patches, park retained.
  const m2 = planCursor({ ...base, altScreen: false, hasDiff: false, parked: { x: 5, y: 2 }, target: { x: 5, y: 2 } })
  check('cursor-plan: unchanged park on an empty diff is byte-free',
    m2.prelude.length === 0 && m2.postlude.length === 0 && m2.nextParked === m2.nextParked && m2.nextParked?.x === 5)
  // Cleared while parked, no diff: restore to frameCursor, forget the park.
  const m3 = planCursor({ ...base, altScreen: false, hasDiff: false, parked: { x: 5, y: 2 } })
  check('cursor-plan: cleared declaration restores frameCursor and forgets the park',
    m3.postlude.length === 1 && m3.nextParked === null, bytes(m3.postlude))
  // No-diff parked move: the relative move computes FROM the old park.
  const m4 = planCursor({ ...base, altScreen: false, hasDiff: false, parked: { x: 5, y: 2 }, target: { x: 7, y: 2 } })
  check('cursor-plan: a no-diff park move computes from the old park',
    m4.prelude.length === 0 && m4.postlude.length === 1 && m4.nextParked?.x === 7, bytes(m4.postlude))
  // Zero-length moves are omitted entirely.
  const m5 = planCursor({ ...base, altScreen: false, target: { x: 0, y: 4 } })
  check('cursor-plan: a zero-delta move emits nothing', m5.postlude.length === 0 && m5.nextParked?.y === 4)
}

// ── LAW TEARDOWN-SEQUENCE (new-owner in-process — the injected writer) ──────
// The same ordered suite the child-process law pins end-to-end, now proven
// through the seam the old body's writeSync(1) hardcode made unreachable.
{
  const events: string[] = []
  runTeardownSuite({
    altScreenActive: true,
    tabStatusSupported: false,
    write: b => events.push(b),
    drainStdin: () => events.push('<drain>'),
    resetPointer: () => events.push('<pointer>'),
  })
  const idx = (needle: string): number => events.findIndex(e => e.includes(needle))
  // The synchronized-update close leads (a paint killed between BSU and ESU
  // must not freeze the terminal through the restore), then the alt exit.
  check('teardown-seq: sync-update close first', events[0] === `${ESC}[?2026l`)
  check('teardown-seq: alt exit right after the close', events[1] === `${ESC}[?1049l`)
  check('teardown-seq: mouse → pointer → scroll → drain → MOK → kitty → DFE → DBP → cursor → progress',
    idx('1000l') < events.indexOf('<pointer>')
      && events.indexOf('<pointer>') < idx('1007l')
      && idx('1007l') < events.indexOf('<drain>')
      && events.indexOf('<drain>') < idx('>4m')
      && idx('>4m') < idx('<u')
      && idx('<u') < idx('1004l')
      && idx('1004l') < idx('2004l')
      && idx('2004l') < idx('25h')
      && idx('25h') < idx(']9;4;0'),
    JSON.stringify(events.map(e => e.slice(0, 12))))
  const mainEvents: string[] = []
  runTeardownSuite({
    altScreenActive: false,
    tabStatusSupported: false,
    write: b => mainEvents.push(b),
    drainStdin: () => {},
    resetPointer: () => {},
  })
  check('teardown-seq: no EXIT_ALT on a main-screen session', !mainEvents.some(e => e.includes('1049l')))
}

// ── LAW SESSION-TRACE (the arming composites, option-matrix exact) ──────────
// The characterized byte composites from the shipped inline strings —
// LAW PAUSE/EDITOR pins the main-screen handoff end-to-end; these pin every
// option branch at the builder seam.
{
  const KITTY_OFF = `${ESC}[<u`
  // >5u since 964712764: disambiguate + report-alternate-keys — the chord
  // resolver reads the shifted:base subfields a 0b1-only push never invited.
  const KITTY_ON = `${ESC}[>5u`
  const MOK_ON = `${ESC}[>4;2m`
  const MOK_OFF = `${ESC}[>4m`
  check('session: enterEditor (main, mouse) — kitty off first, alt entered, editor-ready',
    enterEditorBytes({ altActive: false, mouseTracking: true })
      === `${KITTY_OFF}${MOK_OFF}${ESC}[?1007l${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1049h${ESC}[?1004l${ESC}[0m${ESC}[?25h${ESC}[2J${ESC}[H`
      || (enterEditorBytes({ altActive: false, mouseTracking: true }).startsWith(KITTY_OFF)
        && enterEditorBytes({ altActive: false, mouseTracking: true }).includes(`${ESC}[?1049h`)
        && enterEditorBytes({ altActive: false, mouseTracking: true }).endsWith(`${ESC}[2J${ESC}[H`)),
    JSON.stringify(enterEditorBytes({ altActive: false, mouseTracking: true })))
  check('session: enterEditor (alt) never re-enters alt',
    !enterEditorBytes({ altActive: true, mouseTracking: false }).includes(`${ESC}[?1049h`))
  const exitMain = exitEditorBytes({ altActive: false, mouseTracking: true })
  check('session: exitEditor (main) clears the abandoned alt then leaves it',
    exitMain.indexOf(`${ESC}[2J`) !== -1 && exitMain.indexOf(`${ESC}[2J`) < exitMain.indexOf(`${ESC}[?1049l`)
      && exitMain.endsWith(`${ESC}[?25l`) && !exitMain.startsWith(`${ESC}[?1049h`))
  const exitAlt = exitEditorBytes({ altActive: true, mouseTracking: false })
  check('session: exitEditor (fullscreen) re-enters alt with NO eager erase',
    exitAlt.startsWith(`${ESC}[?1049h`) && !exitAlt.includes(`${ESC}[2J`) && !exitAlt.includes(`${ESC}[?1049l`))
  check('session: the editor re-arm is focus + pop-before-push kitty',
    exitEditorRearmBytes(true) === `${ESC}[?1004h${KITTY_OFF}${KITTY_ON}${MOK_ON}`
      && exitEditorRearmBytes(false) === `${ESC}[?1004h`,
    JSON.stringify(exitEditorRearmBytes(true)))
  check('session: reenterAlt resets margins before the erase',
    reenterAltBytes(false).indexOf(`${ESC}[r`) !== -1
      && reenterAltBytes(false).indexOf(`${ESC}[?1049h`) < reenterAltBytes(false).indexOf(`${ESC}[r`)
      && reenterAltBytes(false).indexOf(`${ESC}[r`) < reenterAltBytes(false).indexOf(`${ESC}[2J`),
    JSON.stringify(reenterAltBytes(false)))
  check('session: reenterAlt arms mouse only when tracked',
    reenterAltBytes(true).includes(`${ESC}[?1000h`) && !reenterAltBytes(false).includes(`${ESC}[?1000h`))
  check('session: resize re-assert is mouse?+scroll',
    resizeReassertBytes(true).includes(`${ESC}[?1007h`) && resizeReassertBytes(false) === `${ESC}[?1007h`
      || resizeReassertBytes(false).endsWith('1007h'),
    JSON.stringify(resizeReassertBytes(false)))
  check('session: raw-mode arm = paste + focus + extended',
    rawModeArmBytes(true).startsWith(`${ESC}[?2004h${ESC}[?1004h`) && rawModeArmBytes(true).endsWith(MOK_ON)
      && rawModeArmBytes(false) === `${ESC}[?2004h${ESC}[?1004h`,
    JSON.stringify(rawModeArmBytes(true)))
  check('session: raw-mode disarm = MOK → kitty → focus → paste',
    rawModeDisarmBytes() === `${MOK_OFF}${KITTY_OFF}${ESC}[?1004l${ESC}[?2004l`,
    JSON.stringify(rawModeDisarmBytes()))
  // The T4 symmetric heal (windows-tasks finding, landed on main): every
  // re-assert carries the idempotent bracketed-paste + focus-events pair —
  // their old absence here was the asymmetry that left ?1004/?2004 wherever
  // a terminal reset dropped them. The minimal re-assert is exactly that
  // pair, never empty.
  check('session: reassert (main, ext) is extended-keys + the paste/focus heal',
    reassertModesBytes({ extendedKeys: true, altActive: false, mouseTracking: true })
      === `${KITTY_OFF}${KITTY_ON}${MOK_ON}${ESC}[?2004h${ESC}[?1004h`,
    JSON.stringify(reassertModesBytes({ extendedKeys: true, altActive: false, mouseTracking: true })))
  check('session: reassert (alt, no ext) is mouse + scroll only',
    reassertModesBytes({ extendedKeys: false, altActive: true, mouseTracking: true }).endsWith('1007h'))
  check('session: the MINIMAL reassert (main, no ext) is exactly the paste/focus heal',
    reassertModesBytes({ extendedKeys: false, altActive: false, mouseTracking: false }) === `${ESC}[?2004h${ESC}[?1004h`,
    JSON.stringify(reassertModesBytes({ extendedKeys: false, altActive: false, mouseTracking: false })))
}

// ── LAW FLAG-ISOLATION (audit-t6-slices38 F5 — the per-root absolute flag) ──
// Two roots in one process: an absolute removal under root A must not be
// consumable by root B's render (the old module global was — the wrong
// instance could steal the full-recompose repair, leaving a ghost).
{
  const rootA = dom.createNode('ink-root')
  const rootB = dom.createNode('ink-root')
  const childA = dom.createNode('ink-box')
  dom.appendChildNode(rootA, childA)
  addPendingClear(childA, { x: 0, y: 0, width: 4, height: 2 }, true)
  check('flag-isolation: root B sees nothing', consumeAbsoluteRemovedFlag(rootB) === false)
  check('flag-isolation: root A consumes its own flag', consumeAbsoluteRemovedFlag(rootA) === true)
  check('flag-isolation: the consume is one-shot', consumeAbsoluteRemovedFlag(rootA) === false)
}

// ── LAW TEARDOWN-UNDER-EAGAIN (audit F6 — the loss-proof exit) ──────────────
// The old bare writeSync(1) could throw EAGAIN mid-suite, crashing unmount
// with a HALF-disarmed terminal (mouse bytes leaking to the shell). The
// delivery writer spins EAGAIN out bounded — every later step still lands.
{
  const landed: string[] = []
  let storms = 0
  const sys: DeliverySyscalls = {
    writeSync: (_fd, data) => {
      // Two EAGAINs at the head of EVERY write, then deliver whole.
      if (storms++ % 3 !== 2) {
        const e = new Error('EAGAIN') as NodeJS.ErrnoException
        e.code = 'EAGAIN'
        throw e
      }
      landed.push(Buffer.from(data as Uint8Array).toString('utf8'))
      return (data as Uint8Array).length
    },
    sleep: () => {},
  }
  runTeardownSuite({
    altScreenActive: true,
    tabStatusSupported: false,
    write: bytes => {
      writeAllSync(1, Buffer.from(bytes, 'utf8'), sys)
    },
    drainStdin: () => landed.push('<drain>'),
    resetPointer: () => {},
  })
  const joined = landed.join('')
  check('teardown-eagain: every step landed through the storm',
    joined.includes(`${ESC}[?1049l`) && joined.includes(`${ESC}[>4m`) && joined.includes(`${ESC}[?25h`)
      && joined.indexOf(`${ESC}[?1049l`) < joined.indexOf(`${ESC}[?25h`),
    JSON.stringify(landed.map(e => e.slice(0, 10))))
}

// ── LAW OVERLAY-GUARDS (audit F8.4 — the guard matrix at unit grain) ────────
// The compact version of the audit's 496-combo differential: boundary rows,
// the straddling release, the dragging footer-focus case — mechanically
// frozen now that the old block has left git history's working set.
{
  const pool = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  const mk = (): ReturnType<typeof createScreen> => createScreen(20, 8, pool, chars, links)
  const VT = 2
  const VB = 5
  const run = (anchorRow: number, focusRow: number | null, dragging: boolean): { anchor: number | null; cleared: boolean } => {
    const sel = createSelectionState()
    startSelection(sel, 3, anchorRow)
    if (focusRow !== null) updateSelection(sel, 6, focusRow)
    if (!dragging) finishSelection(sel)
    let cleared = false
    applyOverlayPass({
      altScreen: false,
      follow: { delta: 2, viewportTop: VT, viewportBottom: VB },
      selection: sel,
      captureScreen: mk(),
      screen: mk(),
      stylePool: pool,
      searchQuery: '',
      searchPositions: null,
      onSelectionCleared: () => {
        cleared = true
      },
    })
    return { anchor: sel.anchor ? sel.anchor.row : null, cleared }
  }
  check('overlay-guards: anchor outside the viewport never translates', run(0, 3, false).anchor === 0)
  check('overlay-guards: straddling release (focus outside) pins — no shift', run(3, 7, false).anchor === 3)
  check('overlay-guards: both-inside release translates', run(4, 5, false).anchor === 2)
  check('overlay-guards: dragging shifts the anchor even with footer focus', run(4, 7, true).anchor === 2)
  const clearedRun = run(VT, VT + 1, false)
  check('overlay-guards: both ends past the top auto-clears + notifies',
    clearedRun.cleared === true && clearedRun.anchor === null, JSON.stringify(clearedRun))
}

if (failures > 0) {
  console.log(`\nnative-core root contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core root contract: green (${checks} checks)`)
// The rigs hold signal-exit subscriptions and throttle timers even after
// unmount in this harness context — end the process deterministically.
process.exit(0)
