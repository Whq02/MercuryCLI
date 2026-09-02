#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-inline-history.ts — the
//  bounded-live-region laws (the §INLINE family).
//
//  Drives the PRODUCTION inline (main-screen) writer over a long transcript
//  journey — growth past the viewport, steady-state appends, a shrink below
//  the flush line (the modal-close epoch), and renewed growth — replaying
//  every emitted byte through the AnsiEmulator's main-screen model (visible
//  window + scrollback), and asserts the contract:
//
//    • the writer NEVER erases the display or scrollback (no ED of any mode,
//      no clearTerminal patches — [2J/[3J are structurally absent);
//    • rows ceded to terminal scrollback are FROZEN — once a row enters the
//      emulator's scrollback it never changes again (prefix stability);
//    • the live tail stays TRUE — after every frame the terminal's full
//      logical output (scrollback + window, end-trimmed) ends with exactly
//      the frame's lines.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-inline-history.ts
// ============================================================================
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { charInCellAt } from '../../src/ink/cell-grid.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from './ansiEmulator.js'
import {
  composeScene,
  type FrameScene,
  makeContext,
  type SceneNode,
} from './frameHarness.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const COLS = 30
const VIEWPORT = 10

function transcriptScene(lines: string[]): FrameScene {
  const root: SceneNode = {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: lines.map(text => ({ kind: 'text' as const, text })),
  }
  return { name: 'inline', cols: COLS, rows: VIEWPORT, root }
}

function serialize(diff: ReturnType<typeof optimize>): string {
  let captured = ''
  const fake = {
    stdout: {
      write(s: string) {
        captured += s
        return true
      },
      isTTY: false,
    },
  }
  writeDiffToTerminal(fake as never, diff, true)
  return captured
}

function frameLines(frame: Frame): string[] {
  const out: string[] = []
  for (let y = 0; y < frame.screen.height; y++) {
    let line = ''
    for (let x = 0; x < frame.screen.width; x++) {
      line += charInCellAt(frame.screen, x, y) || ' '
    }
    out.push(line.replace(/\s+$/, ''))
  }
  return out
}

console.log('bedrock inline history — the bounded live region vs the main-screen emulator')

const ctx = makeContext()
const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
const emu = new AnsiEmulator(COLS, VIEWPORT, false)

// The journey: grow 2→24 rows in steps, edit the last line, shrink to 4
// (modal-close epoch: content drops below the flush line), grow again.
const steps: string[][] = []
{
  const transcript: string[] = []
  for (let n = 2; n <= 24; n += 3) {
    while (transcript.length < n) transcript.push(`line ${transcript.length}`)
    steps.push([...transcript])
  }
  // steady-state edit of the live tail
  const edited = [...transcript]
  edited[edited.length - 1] = 'line edited-tail'
  steps.push(edited)
  // shrink below the flush line (the epoch path)
  steps.push(edited.slice(0, 4).map((_, i) => `post-modal ${i}`))
  // renewed growth
  const regrow = steps[steps.length - 1]!.slice()
  for (let i = 0; i < 8; i++) regrow.push(`regrow ${i}`)
  steps.push(regrow)
}

let prevFrame: Frame | undefined
let frozenSnapshot: string[] = []
let sawGrowthPastViewport = false

for (let si = 0; si < steps.length; si++) {
  const scene = transcriptScene(steps[si]!)
  const frame = composeScene(scene, ctx, prevFrame, {
    altScreen: false,
    viewportRows: VIEWPORT,
    contentHeight: true,
  })

  const rawDiff = log.render(
    prevFrame ?? {
      screen: composeScene(transcriptScene([]), makeContext(), undefined, {
        altScreen: false,
        viewportRows: VIEWPORT,
        contentHeight: true,
      }).screen,
      viewport: { width: COLS, height: VIEWPORT },
      cursor: { x: 0, y: 0, visible: true },
    },
    frame,
    false,
    true,
  )
  const diff = optimize(rawDiff)

  // Law 1: no erase-display in any form.
  const clearPatches = diff.filter(p => p.type === 'clearTerminal')
  check(`step ${si}: no clearTerminal patch`, clearPatches.length === 0, `${clearPatches.length}`)
  const bytes = serialize(diff)
  check(
    `step ${si}: no ED bytes ([J/[2J/[3J)`,
    !/\x1b\[[0-3]?J/.test(bytes),
    JSON.stringify(bytes.slice(0, 120)),
  )

  try {
    emu.feed(bytes)
  } catch (e) {
    check(`step ${si}: replay parses`, false, String(e))
    break
  }
  check(`step ${si}: emulator saw no ED`, emu.edClears === 0 && emu.scrollbackErased === 0)

  // Law 2: ceded scrollback rows are frozen forever.
  check(
    `step ${si}: scrollback prefix stable (${frozenSnapshot.length} frozen rows)`,
    frozenSnapshot.every((row, i) => emu.scrollback[i] === row),
    `frozen ${JSON.stringify(frozenSnapshot)} vs now ${JSON.stringify(emu.scrollback.slice(0, frozenSnapshot.length))}`,
  )
  frozenSnapshot = [...emu.scrollback]
  if (frame.screen.height > VIEWPORT) sawGrowthPastViewport = true

  // Law 3: the terminal's full logical output (scrollback + visible window,
  // end-trimmed) ENDS WITH the frame's lines. Window-position independent —
  // the writer's trailing cursor-line LFs shift where the tail sits in the
  // window, but never what it says.
  const lines = frameLines(frame)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const logical = [...emu.scrollback, ...emu.lines()]
  while (logical.length > 0 && logical[logical.length - 1] === '') logical.pop()
  const tail = logical.slice(-lines.length)
  check(
    `step ${si}: logical output ends with the frame's lines`,
    JSON.stringify(tail) === JSON.stringify(lines),
    `tail ${JSON.stringify(tail)} vs frame ${JSON.stringify(lines)}`,
  )

  prevFrame = frame
}

check('journey actually grew past the viewport', sawGrowthPastViewport)
check('journey actually ceded rows to scrollback', frozenSnapshot.length > 0)

if (failures > 0) {
  console.log(`\nbedrock inline history: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log(`\nbedrock inline history: green (${steps.length} steps, ${frozenSnapshot.length} rows ceded + frozen)`)
