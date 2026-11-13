#!/usr/bin/env bun
// gate-watch: src/ink/renderer.ts src/ink/frame-writer.ts src/ink/ink.tsx src/ink/cell-grid.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { EventEmitter } from 'node:events'
import React from 'react'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { CellWidth, cellAt, setCellAt } from '../../src/ink/cell-grid.js'
import { appendChildNode, createNode, type DOMElement } from '../../src/ink/dom.js'
import { emptyFrame, type FlickerRecord, type Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import useInput from '../../src/ink/hooks/use-input.js'
import Ink from '../../src/ink/ink.js'
import instances from '../../src/ink/instances.js'
import { createLayoutNode } from '../../src/ink/layout/engine.js'
import createRenderer from '../../src/ink/renderer.js'
import { AnsiEmulator } from './ansiEmulator.js'
import { buildDom, makeContext, screenLines } from './frameHarness.js'

const COLS = 40
const ROWS = 12
const ERASE_DISPLAY = /\x1b\[[0-3]?J/g
const UNMODELLED = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?u|\??[0-9;]*\$p|c|[0-9;]*t)/g
const ALT_SWITCH = /\x1b\[\?1049[hl]/

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

class TerminalStream extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  emulator = new AnsiEmulator(COLS, ROWS, true)
  bytes = ''
  write(chunk: string): boolean {
    this.bytes += chunk
    if (ALT_SWITCH.test(chunk)) {
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          this.emulator.grid[y]![x] = ' '
          this.emulator.cellStyles[y]![x] = null
        }
      }
    }
    this.emulator.feed(chunk.replace(UNMODELLED, ''))
    return true
  }
  mark(): number {
    return this.bytes.length
  }
  since(at: number): string {
    return this.bytes.slice(at)
  }
  lines(): string[] {
    return this.emulator.lines().map(line => line.trimEnd())
  }
}

function makeStdin(): NodeJS.ReadStream {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    readableLength: 0,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    ref() { return this },
    unref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
}

const settle = (ms = 220): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function AltScene({ head }: { head: string }): React.ReactNode {
  useInput(() => {})
  const h = React.createElement
  return h(
    AlternateScreen,
    { mouseTracking: false },
    h(
      Box,
      { flexDirection: 'column', justifyContent: 'space-between', height: ROWS, width: COLS },
      h(Text, null, head),
      h(Text, null, 'foot row kept'),
    ),
  )
}

console.log('§1 Ink on the alternate screen: an uncomputed or missing root layout never erases the screen')
{
  const out = new TerminalStream()
  const err = new TerminalStream()
  const flickers: FlickerRecord[] = []
  const ink = new Ink({
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: makeStdin(),
    stderr: err as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: event => {
      flickers.push(...event.flickers)
    },
  })
  ink.armAltScreenEntry('\x1b[?1049h\x1b[r\x1b[2J\x1b[H')
  ink.setAltScreenActive(true, false)
  const beforePrepaint = out.mark()
  ink.onRender()
  const prepaintBytes = out.since(beforePrepaint)
  check(
    'before the first tree lays out, onRender writes no bytes and flushes no pending alt-screen entry',
    prepaintBytes.length === 0,
    JSON.stringify(prepaintBytes),
  )
  check(
    'before the first tree lays out, onRender records no offscreen flicker',
    flickers.length === 0,
    JSON.stringify(flickers),
  )
  ;(ink as unknown as { isTTY: boolean }).isTTY = false
  ink.unmount()
}

{
  const out = new TerminalStream()
  const err = new TerminalStream()
  const flickers: FlickerRecord[] = []
  const ink = new Ink({
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: makeStdin(),
    stderr: err as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: event => {
      flickers.push(...event.flickers)
    },
  })
  instances.set(out as unknown as NodeJS.WriteStream, ink)
  const h = React.createElement

  ink.render(h(AltScene, { head: 'head row one' }))
  await settle(450)
  const paintedLines = out.lines()
  check(
    'control: the alternate screen paints both head and foot rows',
    paintedLines[0] === 'head row one' && paintedLines[ROWS - 1] === 'foot row kept',
    JSON.stringify([paintedLines[0], paintedLines[ROWS - 1]]),
  )

  flickers.length = 0
  const rootNode = (ink as unknown as { rootNode: DOMElement }).rootNode
  const savedLayout = rootNode.layoutNode
  rootNode.layoutNode = undefined
  const atMissing = out.mark()
  ink.onRender()
  const missingBytes = out.since(atMissing)
  const afterMissing = out.lines()
  check(
    'with rootNode.layoutNode absent, onRender emits no erase-in-display and writes nothing',
    (missingBytes.match(ERASE_DISPLAY) ?? []).length === 0 && missingBytes.length === 0,
    JSON.stringify(missingBytes),
  )
  check(
    'with rootNode.layoutNode absent, the painted head and foot rows remain on the terminal',
    afterMissing[0] === 'head row one' && afterMissing[ROWS - 1] === 'foot row kept',
    JSON.stringify([afterMissing[0], afterMissing[ROWS - 1]]),
  )
  check(
    'with rootNode.layoutNode absent, no offscreen flicker is recorded',
    flickers.length === 0,
    JSON.stringify(flickers),
  )

  rootNode.layoutNode = savedLayout
  ink.render(h(AltScene, { head: 'head row one' }))
  await settle()
  const uncomputed = createLayoutNode()
  rootNode.layoutNode = uncomputed
  const atNaN = out.mark()
  ink.onRender()
  const nanBytes = out.since(atNaN)
  const afterNaN = out.lines()
  uncomputed.free()
  rootNode.layoutNode = savedLayout
  check(
    'with an uncomputed (NaN) root layout, onRender writes nothing and keeps the painted rows',
    nanBytes.length === 0 && afterNaN[0] === 'head row one' && afterNaN[ROWS - 1] === 'foot row kept',
    JSON.stringify({ nanBytes, head: afterNaN[0], foot: afterNaN[ROWS - 1] }),
  )

  ink.render(h(AltScene, { head: 'head row two' }))
  await settle()
  const resumedLines = out.lines()
  check(
    'after layout returns, the next frame diffs cleanly against the held frontFrame without aliasing backFrame',
    resumedLines[0] === 'head row two' && resumedLines[ROWS - 1] === 'foot row kept',
    JSON.stringify([resumedLines[0], resumedLines[ROWS - 1]]),
  )
  ;(ink as unknown as { isTTY: boolean }).isTTY = false
  ink.unmount()
  instances.delete(out as unknown as NodeJS.WriteStream)
}

console.log('\n§2 createRenderer + FrameWriter directly: alternate screen, wide-edge mend, and inline mode')
{
  const ctx = makeContext()
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const built = buildDom({
    kind: 'box',
    style: { flexDirection: 'column', justifyContent: 'space-between', width: COLS, height: ROWS },
    children: [
      { kind: 'text', text: 'alpha line' },
      { kind: 'text', text: 'omega line' },
    ],
  })
  const root = createNode('ink-root')
  appendChildNode(root, built)
  root.layoutNode!.calculateLayout(COLS, ROWS)

  const render = createRenderer(root, ctx.stylePool)
  const emptyA = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const emptyB = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const first = render({
    frontFrame: emptyA,
    backFrame: emptyB,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: true,
  }).frame
  setCellAt(first.screen, COLS - 2, 0, {
    char: '漢',
    styleId: ctx.stylePool.none,
    width: CellWidth.Wide,
    hyperlink: undefined,
  })

  const savedLayout = root.layoutNode
  root.layoutNode = undefined
  const heldMissing = render({
    frontFrame: first,
    backFrame: emptyA,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: false,
  }).frame
  const diffMissing = writer.render({ ...first, cursor: { x: 0, y: 0, visible: false } }, heldMissing, true)
  const linesMissing = screenLines(heldMissing.screen).map(line => line.trimEnd())
  check(
    'altScreen missing layout: screen is terminalRows tall, distinct from frontFrame/backFrame, holds painted rows, and diffs to 0 patches',
    heldMissing.screen.height === ROWS &&
      heldMissing.screen !== first.screen &&
      heldMissing.screen !== emptyA.screen &&
      linesMissing[0]!.startsWith('alpha line') &&
      linesMissing[ROWS - 1] === 'omega line' &&
      diffMissing.length === 0,
    JSON.stringify({ height: heldMissing.screen.height, patches: diffMissing }),
  )

  const negativeLayout = createLayoutNode()
  ;(negativeLayout as unknown as { rounded: { left: number; top: number; width: number; height: number } }).rounded = {
    left: 0,
    top: 0,
    width: -4,
    height: ROWS,
  }
  root.layoutNode = negativeLayout
  const heldNegative = render({
    frontFrame: first,
    backFrame: emptyB,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: false,
  }).frame
  negativeLayout.free()
  const diffNegative = writer.render({ ...first, cursor: { x: 0, y: 0, visible: false } }, heldNegative, true)
  check(
    'altScreen negative layout: holds painted rows and emits no clearTerminal patch',
    heldNegative.screen.height === ROWS && diffNegative.length === 0,
    JSON.stringify(diffNegative),
  )

  root.layoutNode = undefined
  const narrower = render({
    frontFrame: first,
    backFrame: emptyA,
    isTTY: true,
    terminalWidth: COLS - 1,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: false,
  }).frame
  const edgeCell = cellAt(narrower.screen, COLS - 2, 0)
  check(
    'altScreen narrower invalid frame mends a wide glyph split at the right edge',
    narrower.screen.width === COLS - 1 && edgeCell?.width === CellWidth.Narrow && edgeCell.char === ' ',
    JSON.stringify(edgeCell),
  )

  root.layoutNode = savedLayout
}

{
  const ctx = makeContext()
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const built = buildDom({
    kind: 'box',
    style: { flexDirection: 'column', width: COLS },
    children: [
      { kind: 'text', text: 'inline one' },
      { kind: 'text', text: 'inline two' },
      { kind: 'text', text: 'inline three' },
    ],
  })
  const root = createNode('ink-root')
  appendChildNode(root, built)
  const render = createRenderer(root, ctx.stylePool)

  const blankA = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const blankB = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const beforeAny = render({
    frontFrame: blankA,
    backFrame: blankB,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: false,
    prevFrameContaminated: false,
  }).frame
  check(
    'inline before any frame: invalid layout answers a 0-row screen with visible home cursor and 0 patches',
    beforeAny.screen.height === 0 &&
      beforeAny.cursor.x === 0 &&
      beforeAny.cursor.y === 0 &&
      beforeAny.cursor.visible === true &&
      writer.render(blankA, beforeAny, false).length === 0,
    JSON.stringify({ height: beforeAny.screen.height, cursor: beforeAny.cursor }),
  )

  root.layoutNode!.calculateLayout(COLS, undefined)
  const paintedInline: Frame = render({
    frontFrame: blankA,
    backFrame: blankB,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: false,
    prevFrameContaminated: false,
  }).frame
  root.layoutNode = undefined
  const heldInline = render({
    frontFrame: paintedInline,
    backFrame: blankA,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: false,
    prevFrameContaminated: false,
  }).frame
  const inlineDiff = writer.render(paintedInline, heldInline, false)
  const inlineLines = screenLines(heldInline.screen).map(line => line.trimEnd())
  check(
    'inline after painting 3 rows: invalid layout holds all 3 rows and emits 0 clear/diff patches',
    heldInline.screen.height === 3 &&
      inlineLines[0] === 'inline one' &&
      inlineLines[2] === 'inline three' &&
      inlineDiff.length === 0,
    JSON.stringify({ height: heldInline.screen.height, patches: inlineDiff }),
  )
}

console.log(`\nprove-invalid-layout-holds-frame: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
