#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-alt-paint-scroll.ts — MERCURY NATIVE CORE T1:
//  alt-screen full paints never scroll the buffer.
//
//  A CR+NL emitted with the cursor on the BOTTOM row scrolls the whole
//  alternate buffer one row while the writer's model stays put; every later
//  diff then repaints rows one off their painted position and the shifted
//  copies survive as ghosts (the ghost-row / doubled-row class,
//  observed on ConPTY where full repaints are frequent, reproducible on any
//  terminal). Alt rows always exist and are addressable, so the writer
//  advances full paints with absolute CUP and emits no trailing LF.
//
//  LAWS (production pipeline: FrameWriter.render → optimize →
//  writeDiffToTerminal → AnsiEmulator replay):
//    · FULL-REPAINT REPLAY — a width-change full repaint of FULL-HEIGHT
//      content replays cell-exact (the final row's paint cannot scroll);
//    · GROWTH REPLAY — growth to full height replays cell-exact;
//    · NO ALT LF — neither byte stream contains a bare line feed.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-alt-paint-scroll.ts
// ============================================================================
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { charInCellAt } from '../../src/ink/cell-grid.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { composeScene, makeContext, type SceneNode } from '../ink-runtime/frameHarness.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const ROWS = 8
const COLS = 24

function scene(lines: number): SceneNode {
  return {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: Array.from({ length: lines }, (_, i) => ({
      kind: 'text' as const,
      text: `row-${i} content here`,
    })),
  }
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
  writeDiffToTerminal(fake as never, diff, false)
  return captured
}

function replayAlt(prev: Frame, next: Frame, label: string): void {
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const anchored: Frame = { ...prev, cursor: { x: 0, y: 0, visible: prev.cursor.visible } }
  const diff = optimize(writer.render(anchored, next, true, true))
  const bytes = CURSOR_HOME + serialize(diff)
  check(`${label}: no bare LF in the alt byte stream`, !bytes.includes('\n'))
  const emu = new AnsiEmulator(next.screen.width, ROWS, true)
  for (let y = 0; y < Math.min(ROWS, prev.screen.height); y++) {
    for (let x = 0; x < Math.min(next.screen.width, prev.screen.width); x++) {
      emu.grid[y]![x] = charInCellAt(prev.screen, x, y) || ' '
    }
  }
  emu.feed(bytes)
  let mismatch = ''
  for (let y = 0; y < next.screen.height && !mismatch; y++) {
    for (let x = 0; x < next.screen.width; x++) {
      const want = charInCellAt(next.screen, x, y) || ' '
      const got = emu.grid[y]![x] || ' '
      if (want !== got) {
        mismatch = `(${x},${y}): replay ${JSON.stringify(got)} vs frame ${JSON.stringify(want)}`
        break
      }
    }
  }
  check(`${label}: replay cell-exact`, mismatch === '', mismatch)
}

console.log('native-core T1 — alt full paints never scroll the buffer\n')

const ctx = makeContext()

// Width change ⇒ contained full repaint of FULL-HEIGHT content: the final
// row's paint must not scroll.
replayAlt(
  composeScene({ root: scene(ROWS), cols: COLS - 1, rows: ROWS }, ctx),
  composeScene({ root: scene(ROWS), cols: COLS, rows: ROWS }, ctx),
  'width-change full repaint',
)

// Growth to full height: the growth pass paints the new bottom rows.
replayAlt(
  composeScene({ root: scene(4), cols: COLS, rows: ROWS }, ctx, undefined, { contentHeight: true }),
  composeScene({ root: scene(ROWS), cols: COLS, rows: ROWS }, ctx),
  'growth to full height',
)

// Exact-fit BORDERED card (the Q5 handoff shape): a card of height == rows —
// the top border row is the visible sentinel; one phantom scroll and it is
// the row that disappears. Both entry paths must keep it at row 0.
const card = (cols: number): SceneNode => ({
  kind: 'box',
  style: { flexDirection: 'column', borderStyle: 'round', height: ROWS, width: cols },
  children: Array.from({ length: ROWS - 2 }, (_, i) => ({
    kind: 'text' as const,
    text: `card row ${i}`,
  })),
})
{
  const prev = composeScene({ root: card(COLS - 1), cols: COLS - 1, rows: ROWS }, ctx)
  const next = composeScene({ root: card(COLS), cols: COLS, rows: ROWS }, ctx)
  let topBorder = ''
  for (let x = 0; x < next.screen.width; x++) topBorder += charInCellAt(next.screen, x, 0) || ' '
  check('exact-fit card: the composed frame owns a top border at row 0', topBorder.includes('╭'))
  replayAlt(prev, next, 'exact-fit bordered card (width-change repaint)')
}
{
  const prev = composeScene({ root: scene(3), cols: COLS, rows: ROWS }, ctx, undefined, { contentHeight: true })
  const next = composeScene({ root: card(COLS), cols: COLS, rows: ROWS }, ctx)
  replayAlt(prev, next, 'exact-fit bordered card (growth entry)')
}

if (failures > 0) {
  console.log(`\nnative-core alt-paint-scroll: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core alt-paint-scroll: green (${checks} checks)`)
