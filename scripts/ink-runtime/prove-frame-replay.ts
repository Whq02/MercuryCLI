#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-frame-replay.ts — the frame
//  differ/writer replay laws.
//
//  Drives the PRODUCTION diff→serialize pipeline (LogUpdate.render →
//  optimize → writeDiffToTerminal) over composed frame pairs and replays the
//  emitted bytes through the independent AnsiEmulator oracle:
//
//    • REPLAY EQUALITY — applying the patch bytes to the previous logical
//      screen reconstructs the next logical screen exactly, cell by cell
//      (alt-screen; text projection — styles ride the pinned ansi-tokenize
//      transition differ and the live visual baselines);
//    • ZERO-DIRTY ⇒ ZERO WRITE — identical screens emit no bytes at all;
//    • DECSTBM REPLAY — a full-width scroll hint (the composer's
//      FULL-WIDTH GUARD is source-pinned here) emits scroll-region ops that
//      replay to exactly the shifted screen;
//    • single-frame convergence — every pair converges in ONE patch
//      (replay(prev, patch) == next; no self-heal needed).
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-frame-replay.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { charInCellAt } from '../../src/ink/cell-grid.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
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

// Serialize a patch list through the production serializer.
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

function seedEmulator(frame: Frame): AnsiEmulator {
  const emu = new AnsiEmulator(frame.screen.width, frame.screen.height, true)
  for (let y = 0; y < frame.screen.height; y++) {
    for (let x = 0; x < frame.screen.width; x++) {
      emu.grid[y]![x] = charInCellAt(frame.screen, x, y) || ' '
    }
  }
  return emu
}

function compareGrids(emu: AnsiEmulator, frame: Frame): string {
  for (let y = 0; y < frame.screen.height; y++) {
    for (let x = 0; x < frame.screen.width; x++) {
      const want = charInCellAt(frame.screen, x, y) || ' '
      const got = emu.grid[y]![x] || ' '
      if (want !== got) {
        return `(${x},${y}): replay ${JSON.stringify(got)} vs frame ${JSON.stringify(want)}`
      }
    }
  }
  return ''
}

/** Render prev→next through the production pipeline exactly as ink.tsx does
 *  on the alt screen: anchored prev cursor, CSI H prepended when non-empty. */
function emitAltScreen(
  log: LogUpdate,
  prev: Frame,
  next: Frame,
): { bytes: string; patchCount: number } {
  const anchored: Frame = { ...prev, cursor: { x: 0, y: 0, visible: prev.cursor.visible } }
  const diff = optimize(log.render(anchored, next, true, true))
  if (diff.length === 0) return { bytes: '', patchCount: 0 }
  return { bytes: CURSOR_HOME + serialize(diff), patchCount: diff.length }
}

// ---------------------------------------------------------------------------
// Scene pairs: prev → next mutations across the composition vocabulary.

const base: SceneNode = {
  kind: 'box',
  style: { flexDirection: 'column' },
  children: [
    { kind: 'text', text: 'alpha line one' },
    { kind: 'text', style: { color: 'red' }, text: 'beta styled' },
    {
      kind: 'box',
      style: { flexDirection: 'row', gap: 2 },
      children: [
        { kind: 'text', text: 'left' },
        { kind: 'text', text: 'right' },
      ],
    },
  ],
}

const PAIRS: Array<{ name: string; cols: number; rows: number; a: SceneNode; b: SceneNode }> = [
  {
    name: 'text-edit-one-line',
    cols: 40,
    rows: 6,
    a: base,
    b: {
      ...base,
      children: [
        { kind: 'text', text: 'alpha line CHANGED' },
        base.children![1]!,
        base.children![2]!,
      ],
    },
  },
  {
    name: 'style-change-only',
    cols: 40,
    rows: 6,
    a: base,
    b: {
      ...base,
      children: [
        base.children![0]!,
        { kind: 'text', style: { color: 'green', bold: true }, text: 'beta styled' },
        base.children![2]!,
      ],
    },
  },
  {
    name: 'add-child-row',
    cols: 40,
    rows: 8,
    a: base,
    b: {
      ...base,
      children: [...base.children!, { kind: 'text', text: 'appended row' }],
    },
  },
  {
    name: 'remove-child-row',
    cols: 40,
    rows: 8,
    a: { ...base, children: [...base.children!, { kind: 'text', text: 'doomed row' }] },
    b: base,
  },
  {
    name: 'wide-glyph-swap',
    cols: 30,
    rows: 4,
    a: { kind: 'box', children: [{ kind: 'text', text: 'plain ascii here' }] },
    b: { kind: 'box', children: [{ kind: 'text', text: 'あい漢字 wide' }] },
  },
  {
    name: 'bordered-panel-resize',
    cols: 44,
    rows: 8,
    a: {
      kind: 'box',
      style: { flexDirection: 'row' },
      children: [
        { kind: 'box', style: { borderStyle: 'single', width: 14 }, children: [{ kind: 'text', text: 'rail' }] },
        { kind: 'box', style: { borderStyle: 'round', flexGrow: 1 }, children: [{ kind: 'text', text: 'center' }] },
      ],
    },
    b: {
      kind: 'box',
      style: { flexDirection: 'row' },
      children: [
        { kind: 'box', style: { borderStyle: 'single', width: 20 }, children: [{ kind: 'text', text: 'rail wider' }] },
        { kind: 'box', style: { borderStyle: 'round', flexGrow: 1 }, children: [{ kind: 'text', text: 'center' }] },
      ],
    },
  },
]

console.log('bedrock frame replay — production diff/writer vs the AnsiEmulator oracle')

// -- Law 1+4: replay equality, one patch per pair -----------------------------
for (const pair of PAIRS) {
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const sceneA: FrameScene = { name: pair.name, cols: pair.cols, rows: pair.rows, root: pair.a }
  const sceneB: FrameScene = { name: pair.name, cols: pair.cols, rows: pair.rows, root: pair.b }
  const frameA = composeScene(sceneA, ctx)
  const frameB = composeScene(sceneB, ctx, frameA)

  // Seed BEFORE emitting — the production differ mutates prev.screen
  // (shiftRows simulates the scroll), exactly like the real terminal
  // already holds the previous frame.
  const emu = seedEmulator(frameA)
  const { bytes } = emitAltScreen(log, frameA, frameB)
  try {
    emu.feed(bytes)
  } catch (e) {
    check(`replay parses: ${pair.name}`, false, String(e))
    continue
  }
  check(`replay equality: ${pair.name}`, compareGrids(emu, frameB) === '', compareGrids(emu, frameB))
}

// -- Law 2: zero-dirty ⇒ zero write -------------------------------------------
for (const pair of PAIRS.slice(0, 3)) {
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const scene: FrameScene = { name: pair.name, cols: pair.cols, rows: pair.rows, root: pair.a }
  const frame1 = composeScene(scene, ctx)
  const frame2 = composeScene(scene, ctx, frame1)
  const { bytes, patchCount } = emitAltScreen(log, frame1, frame2)
  check(
    `zero-dirty ⇒ zero write: ${pair.name}`,
    bytes === '' && patchCount === 0,
    `${patchCount} patches, ${bytes.length} bytes`,
  )
}

// -- Law 3: DECSTBM full-width scroll replays exactly --------------------------
{
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const mkScene = (offset: number): FrameScene => ({
    name: `scroll-${offset}`,
    cols: 30,
    rows: 8,
    root: {
      kind: 'box',
      style: { flexDirection: 'column' },
      children: Array.from({ length: 8 }, (_, i) => ({
        kind: 'text' as const,
        text: `transcript row ${offset + i}`,
      })),
    },
  })
  const frameA = composeScene(mkScene(0), ctx)
  const frameBRaw = composeScene(mkScene(2), ctx, frameA)
  // A full-width scroll hint, exactly the shape the composer publishes when
  // a full-width ScrollBox scrolls by 2 (rows [0..7], delta 2).
  const frameB: Frame = { ...frameBRaw, scrollHint: { top: 0, bottom: 7, delta: 2 } }
  const emu = seedEmulator(frameA)
  const { bytes } = emitAltScreen(log, frameA, frameB)
  check('scroll: DECSTBM ops emitted', /\x1b\[\d+;\d+r/.test(bytes) && /\x1b\[\d+S/.test(bytes), JSON.stringify(bytes.slice(0, 80)))
  try {
    emu.feed(bytes)
    check('scroll: replay equality through DECSTBM', compareGrids(emu, frameB) === '', compareGrids(emu, frameB))
    check('scroll: region reset after use', emu.region === null)
  } catch (e) {
    check('scroll: replay parses', false, String(e))
  }
}

// -- Law 3b: the composer's FULL-WIDTH GUARD is source-pinned ------------------
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'ink', 'compose-walk.ts'),
    'utf8',
  )
  check(
    'composer full-width guard present (spansFullWidth gates the DECSTBM hint)',
    src.includes('spansFullWidth') &&
      src.includes('Math.floor(x) <= 0 && Math.ceil(x + width) >= buffer.width') &&
      src.includes('stableForShift && spansFullWidth'),
    'the §STALE-PAINT guard moved or was renamed — update this pin deliberately',
  )
}

if (failures > 0) {
  console.log(`\nbedrock frame replay: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock frame replay: green')
