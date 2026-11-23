#!/usr/bin/env bun
import type { Frame } from '../../src/screen/renderer/frame.js'
import { FrameWriter } from '../../src/screen/renderer/frame-writer.js'
import { optimizePatches as optimize } from '../../src/screen/renderer/patch-stream.js'
import { charInCellAt } from '../../src/screen/renderer/cell-grid.js'
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

const steps: string[][] = []
{
  const transcript: string[] = []
  for (let n = 2; n <= 24; n += 3) {
    while (transcript.length < n) transcript.push(`line ${transcript.length}`)
    steps.push([...transcript])
  }
  const edited = [...transcript]
  edited[edited.length - 1] = 'line edited-tail'
  steps.push(edited)
  steps.push(edited.slice(0, 4).map((_, i) => `post-modal ${i}`))
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

  const clearPatches = diff.filter(p => p.type === 'clearTerminal')
  check(
    `step ${si}: no clearTerminal patch`,
    clearPatches.length === 0,
    `${clearPatches.length} clearTerminal patches; the inline (non-alt-screen) path of FrameWriter.render in src/screen/renderer/frame-writer.ts must not emit clearTerminal`,
  )
  const bytes = serialize(diff)
  check(
    `step ${si}: no ED bytes ([J/[2J/[3J)`,
    !/\x1b\[[0-3]?J/.test(bytes),
    `${JSON.stringify(bytes.slice(0, 120))}; the bytes writeDiffToTerminal (src/screen/renderer/terminal-session/frameDelivery.ts) wrote contain an erase-display escape, so an inline frame diff must not produce one`,
  )

  try {
    emu.feed(bytes)
  } catch (e) {
    check(`step ${si}: replay parses`, false, String(e))
    break
  }
  check(
    `step ${si}: emulator saw no ED`,
    emu.edClears === 0 && emu.scrollbackErased === 0,
    `edClears ${emu.edClears}, scrollbackErased ${emu.scrollbackErased}; an inline frame diff from FrameWriter.render (src/screen/renderer/frame-writer.ts) cleared the screen or scrollback`,
  )

  check(
    `step ${si}: scrollback prefix stable (${frozenSnapshot.length} frozen rows)`,
    frozenSnapshot.every((row, i) => emu.scrollback[i] === row),
    `frozen ${JSON.stringify(frozenSnapshot)} vs now ${JSON.stringify(emu.scrollback.slice(0, frozenSnapshot.length))}; rows already ceded to scrollback were rewritten, so check how FrameWriter.render (src/screen/renderer/frame-writer.ts) repaints rows above the live region`,
  )
  frozenSnapshot = [...emu.scrollback]
  if (frame.screen.height > VIEWPORT) sawGrowthPastViewport = true

  const lines = frameLines(frame)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const logical = [...emu.scrollback, ...emu.lines()]
  while (logical.length > 0 && logical[logical.length - 1] === '') logical.pop()
  const tail = logical.slice(-lines.length)
  check(
    `step ${si}: logical output ends with the frame's lines`,
    JSON.stringify(tail) === JSON.stringify(lines),
    `tail ${JSON.stringify(tail)} vs frame ${JSON.stringify(lines)}; the replayed terminal no longer matches the composed frame, so check the diff FrameWriter.render (src/screen/renderer/frame-writer.ts) and optimizePatches (src/screen/renderer/patch-stream.ts) produce`,
  )

  prevFrame = frame
}

check(
  'journey actually grew past the viewport',
  sawGrowthPastViewport,
  'no composed frame was taller than the 10-row viewport; check the steps list and the contentHeight option passed to composeScene in this file',
)
check(
  'journey actually ceded rows to scrollback',
  frozenSnapshot.length > 0,
  'the emulator scrollback stayed empty; the inline diff never scrolled rows out of the live region, so check writeDiffToTerminal in src/screen/renderer/terminal-session/frameDelivery.ts',
)

if (failures > 0) {
  console.log(`\nbedrock inline history: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log(`\nbedrock inline history: green (${steps.length} steps, ${frozenSnapshot.length} rows ceded + frozen)`)
