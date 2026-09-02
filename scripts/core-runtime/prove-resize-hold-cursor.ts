#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { FrameWriter } = await import(join(SRC, 'ink/frame-writer.ts'))
const { emptyFrame } = await import(join(SRC, 'ink/frame.ts'))
const { composeScene, makeContext } = await import('../ink-runtime/frameHarness.js')

type Op = { type: string }
type FrameLike = { screen: unknown; viewport: { width: number; height: number }; cursor: { x: number; y: number; visible: boolean } }

const ctx = makeContext()
const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
const frame = composeScene(
  {
    name: 'hold',
    cols: 40,
    rows: 6,
    root: { kind: 'box', style: { flexDirection: 'column' }, children: [{ kind: 'text', text: 'a line that survives the resize' }, { kind: 'text', text: 'and another' }] },
  },
  ctx,
  undefined,
  { altScreen: true },
) as unknown as FrameLike
const kinds = (ops: Op[]): string[] => ops.map(op => op.type)

console.log('H1 a visible cursor comes back at the end of the holding paint')
{
  const visible = { ...frame, cursor: { ...frame.cursor, visible: true } }
  const ops = writer.holdingClipPaint(visible as never, 30, 4) as Op[]
  check('the diff paints (the clipped rows)', ops.length > 2, String(ops.length))
  check('it opens with the hide', ops[0]?.type === 'cursorHide', kinds(ops).slice(0, 3).join(','))
  check('and CLOSES with the show', ops[ops.length - 1]?.type === 'cursorShow', kinds(ops).slice(-3).join(','))
  check('exactly one show, after the hide', kinds(ops).filter(k => k === 'cursorShow').length === 1)
}

console.log('H2 a hidden cursor stays hidden')
{
  const hidden = { ...frame, cursor: { ...frame.cursor, visible: false } }
  const ops = writer.holdingClipPaint(hidden as never, 30, 4) as Op[]
  check('the diff still opens with the hide', ops[0]?.type === 'cursorHide')
  check('no show is emitted', !kinds(ops).includes('cursorShow'), kinds(ops).slice(-3).join(','))
}

console.log('H3 an empty frame paints nothing')
{
  const empty = emptyFrame(6, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const ops = writer.holdingClipPaint(empty as never, 30, 4) as Op[]
  check('no ops at all (a zero-height screen)', ops.length === 0, String(ops.length))
}

console.log(failures === 0 ? '\nprove-resize-hold-cursor: ALL PASS' : `\nprove-resize-hold-cursor: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
