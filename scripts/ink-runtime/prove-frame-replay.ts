#!/usr/bin/env bun
import type { Frame } from '../../src/screen/renderer/frame.js'
import { FrameWriter } from '../../src/screen/renderer/frame-writer.js'
import { optimizePatches as optimize } from '../../src/screen/renderer/patch-stream.js'
import { charInCellAt } from '../../src/screen/renderer/cell-grid.js'
import { CURSOR_HOME } from '../../src/screen/renderer/termio/csi.js'
import { writeDiffToTerminal } from '../../src/screen/renderer/terminal-session/frameDelivery.js'
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

for (const pair of PAIRS) {
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const sceneA: FrameScene = { name: pair.name, cols: pair.cols, rows: pair.rows, root: pair.a }
  const sceneB: FrameScene = { name: pair.name, cols: pair.cols, rows: pair.rows, root: pair.b }
  const frameA = composeScene(sceneA, ctx)
  const frameB = composeScene(sceneB, ctx, frameA)

  const emu = seedEmulator(frameA)
  const { bytes } = emitAltScreen(log, frameA, frameB)
  try {
    emu.feed(bytes)
  } catch (e) {
    check(`replay parses: ${pair.name}`, false, `${String(e)} — the bytes from FrameWriter.render (src/screen/renderer/frame-writer.ts) through optimizePatches and writeDiffToTerminal contain a sequence the AnsiEmulator cannot parse; fix the emitting patch there, or teach scripts/ink-runtime/ansiEmulator.ts the sequence if it is valid`)
    continue
  }
  check(`replay equality: ${pair.name}`, compareGrids(emu, frameB) === '', `${compareGrids(emu, frameB)} — replaying the diff on the old frame must give the new frame; fix FrameWriter.render in src/screen/renderer/frame-writer.ts (or optimizePatches in src/screen/renderer/patch-stream.ts) so it emits the patches for that cell`)
}

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
    `${patchCount} patches, ${bytes.length} bytes — two identical frames must emit nothing; fix FrameWriter.render in src/screen/renderer/frame-writer.ts so an unchanged cell produces no patch`,
  )
}

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
  const frameB: Frame = { ...frameBRaw, scrollHint: { top: 0, bottom: 7, delta: 2 } }
  const emu = seedEmulator(frameA)
  const { bytes } = emitAltScreen(log, frameA, frameB)
  check('scroll: DECSTBM ops emitted', /\x1b\[\d+;\d+r/.test(bytes) && /\x1b\[\d+S/.test(bytes), `${JSON.stringify(bytes.slice(0, 80))} — a frame with scrollHint must emit a DECSTBM region plus a scroll-up (CSI r and CSI S); look at how FrameWriter.render in src/screen/renderer/frame-writer.ts uses scrollHint`)
  try {
    emu.feed(bytes)
    check('scroll: replay equality through DECSTBM', compareGrids(emu, frameB) === '', `${compareGrids(emu, frameB)} — the scrolled replay differs from the new frame; fix the scrollHint path in FrameWriter.render (src/screen/renderer/frame-writer.ts)`)
    check('scroll: region reset after use', emu.region === null, 'the scroll region (DECSTBM) was left set after the diff; the writer must reset it with CSI r in src/screen/renderer/frame-writer.ts')
  } catch (e) {
    check('scroll: replay parses', false, `${String(e)} — the scroll diff contains a sequence the AnsiEmulator cannot parse; check FrameWriter.render in src/screen/renderer/frame-writer.ts`)
  }
}


if (failures > 0) {
  console.log(`\nbedrock frame replay: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock frame replay: green')
