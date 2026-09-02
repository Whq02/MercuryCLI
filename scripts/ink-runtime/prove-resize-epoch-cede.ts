#!/usr/bin/env bun
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from './ansiEmulator.js'
import { composeScene, makeContext, type FrameScene } from './frameHarness.js'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

function serialize(diff: ReturnType<typeof optimize>, skipSync = true): string {
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
  writeDiffToTerminal(fake as never, diff, skipSync)
  return captured
}

const VIEWPORT = 8
const mkScene = (cols: number, rows: string[]): FrameScene => ({
  name: 'resize-epoch',
  cols,
  rows: VIEWPORT,
  root: {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: rows.map(t => ({ kind: 'text' as const, text: t })),
  },
})

const CONTENT = Array.from({ length: 14 }, (_, n) => `row ${n} steady under resize`)

function grownJourney(cols: number): { log: FrameWriter; ctx: ReturnType<typeof makeContext>; prev: Frame } {
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  let prev: Frame | undefined
  for (const upTo of [4, 9, 14]) {
    const frame = composeScene(mkScene(cols, CONTENT.slice(0, upTo)), ctx, prev, {
      altScreen: false,
      viewportRows: VIEWPORT,
      contentHeight: true,
    })
    const emptyPrev: Frame = {
      screen: composeScene(mkScene(cols, []), makeContext(), undefined, { altScreen: false, viewportRows: VIEWPORT, contentHeight: true }).screen,
      viewport: { width: cols, height: VIEWPORT },
      cursor: { x: 0, y: 0, visible: true },
    }
    log.render(prev ?? emptyPrev, frame, false, true)
    prev = frame
  }
  return { log, ctx, prev: prev! }
}

const clearTotal = (diff: ReturnType<typeof optimize>): { ops: number; rows: number } => {
  let ops = 0
  let rows = 0
  for (const p of diff) {
    if (p.type === 'clear') {
      ops += 1
      rows += p.count
    }
  }
  return { ops, rows }
}

function widthBreakLaws(label: string, fromCols: number, toCols: number): void {
  const { log, ctx, prev } = grownJourney(fromCols)
  const next = composeScene(mkScene(toCols, CONTENT), ctx, prev, {
    altScreen: false,
    viewportRows: VIEWPORT,
    contentHeight: true,
  })
  const diff = log.render(prev, next, false, true)
  const bytes = serialize(optimize(diff))
  const { rows } = clearTotal(diff)
  check(`${label}: THE DEFECT PIN — no erase beyond the writer's own park row (model counts are void after re-flow)`, rows <= 1, j({ clearRows: rows }))
  check(`${label}: no ED bytes (the standing scrollback law)`, !/\x1b\[[0-3]?J/.test(bytes))
  const emu = new AnsiEmulator(toCols, VIEWPORT, false)
  emu.feed(bytes)
  const window = Array.from({ length: VIEWPORT }, (_, y) => emu.rowText(y)).join('\n')
  const tail = CONTENT.slice(14 - VIEWPORT + 1)
  check(`${label}: the new frame's tail paints complete below the ceded zone`, tail.every(t => window.includes(t)), j({ window: window.slice(0, 120) }))
}

section('§1 narrowing: the zone is ceded, the tail paints fresh')
widthBreakLaws('narrow 46→30', 46, 30)

section('§2 widening: the erase can never reach the operator scrollback')
widthBreakLaws('widen 40→64', 40, 64)

section('§3 the height-only control: the erase is KEPT where the arithmetic holds')
{
  const { log, ctx, prev } = grownJourney(40)
  const next = composeScene(mkScene(40, CONTENT), ctx, prev, {
    altScreen: false,
    viewportRows: VIEWPORT - 3,
    contentHeight: true,
  })
  const diff = log.render(prev, next, false, true)
  const { rows } = clearTotal(diff)
  check('a same-width viewport shrink still erases its rows (the valid epoch keeps its teeth)', rows > 1, j({ clearRows: rows }))
}

section('§4 the writer settles into the new epoch')
{
  const { log, ctx, prev } = grownJourney(46)
  const next = composeScene(mkScene(30, CONTENT), ctx, prev, { altScreen: false, viewportRows: VIEWPORT, contentHeight: true })
  log.render(prev, next, false, true)
  const again = composeScene(mkScene(30, CONTENT), ctx, next, { altScreen: false, viewportRows: VIEWPORT, contentHeight: true })
  const zd = serialize(optimize(log.render(next, again, false, true)))
  check('an unchanged follow-up frame emits zero bytes (zero-dirty law across the ceded epoch)', zd.length === 0, j(zd.slice(0, 60)))
}

console.log(failures === 0 ? '\nprove-resize-epoch-cede: ALL LAWS HOLD' : `\nprove-resize-epoch-cede: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
