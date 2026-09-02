#!/usr/bin/env bun
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import {
  appendChildNode,
  createNode,
  createTextNode,
} from '../../src/ink/dom.js'
import { CellWidth, cellAt, charInCellAt } from '../../src/ink/cell-grid.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import {
  AnsiEmulator,
  defaultSgr,
  type SgrState,
  sgrStateOfStyleString,
} from '../ink-runtime/ansiEmulator.js'
import {
  applySceneStyle,
  buildDom,
  composeScene,
  type ComposeContext,
  type FrameScene,
  makeContext,
  type SceneNode,
} from '../ink-runtime/frameHarness.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

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

function expectedStyle(ctx: ComposeContext, styleId: number): SgrState {
  const str = ctx.stylePool.transition(ctx.stylePool.none, styleId)
  return sgrStateOfStyleString(str)
}

function sameVisibleStyle(char: string, actual: SgrState | null, expected: SgrState): boolean {
  const a = actual ?? defaultSgr()
  if (char === ' ') {
    return (
      a.bg === expected.bg &&
      a.inverse === expected.inverse &&
      a.underline === expected.underline &&
      a.strike === expected.strike
    )
  }
  return (
    a.bold === expected.bold &&
    a.dim === expected.dim &&
    a.italic === expected.italic &&
    a.underline === expected.underline &&
    a.inverse === expected.inverse &&
    a.strike === expected.strike &&
    a.fg === expected.fg &&
    a.bg === expected.bg
  )
}

function checkFrameState(
  label: string,
  emu: AnsiEmulator,
  frame: Frame,
  ctx: ComposeContext,
  rowOffset: number,
): void {
  const { screen } = frame
  for (let y = Math.max(0, rowOffset); y < screen.height; y++) {
    const wy = y - rowOffset
    if (wy < 0 || wy >= emu.height) continue
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)
      const char = cell && cell.width !== CellWidth.SpacerTail ? cell.char : cell ? '' : ' '
      const emuChar = emu.grid[wy]![x]!
      const modelChar = cell === undefined || char === '' ? emuChar : char
      if (cell !== undefined && cell.width !== CellWidth.SpacerTail && cell.width !== CellWidth.SpacerHead) {
        check(
          `${label}: text (${x},${y})`,
          emuChar === (cell.char === '' ? ' ' : cell.char) || (cell.char === ' ' && emuChar === ' '),
          `model ${JSON.stringify(cell.char)} vs terminal ${JSON.stringify(emuChar)}`,
        )
        const exp = expectedStyle(ctx, cell.styleId)
        check(
          `${label}: style (${x},${y}) ${JSON.stringify(cell.char)}`,
          sameVisibleStyle(cell.char, emu.styleAt(x, wy), exp),
          `expected ${JSON.stringify(exp)} got ${JSON.stringify(emu.styleAt(x, wy))}`,
        )
        if (cell.char !== ' ') {
          check(
            `${label}: link (${x},${y})`,
            (emu.linkAt(x, wy) ?? undefined) === cell.hyperlink,
            `expected ${JSON.stringify(cell.hyperlink)} got ${JSON.stringify(emu.linkAt(x, wy))}`,
          )
        }
      } else if (cell === undefined) {
        check(`${label}: blank (${x},${y})`, emuChar === ' ' || emuChar === '', `terminal ${JSON.stringify(emuChar)}`)
        void modelChar
      }
    }
  }
}

const ALT_COLS = 40
const ALT_ROWS = 12

function styledPane(step: number): FrameScene {
  const root: SceneNode = {
    kind: 'box',
    style: { flexDirection: 'column', width: ALT_COLS, height: ALT_ROWS },
    children: [
      {
        kind: 'box',
        style: { borderStyle: 'round', flexDirection: 'column', flexGrow: 1 },
        children: [
          { kind: 'text', text: `step ${step} — the quick fox`, style: { color: 'red', bold: true } },
          { kind: 'text', text: `dim ${step % 3} 值 wide 漢字 row`, style: { dimColor: true } },
          {
            kind: 'text',
            text: step % 2 === 0 ? 'inverse block' : 'plain block',
            style: step % 2 === 0 ? { inverse: true } : {},
          },
          { kind: 'text', text: `hex ${step}`, style: { color: '#22aa66', backgroundColor: '#112233' } },
        ],
      },
    ],
  }
  return { name: `styled-${step}`, cols: ALT_COLS, rows: ALT_ROWS, root }
}

function linkScene(ctx: ComposeContext): Frame {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: ALT_COLS, height: ALT_ROWS, flexDirection: 'column' })
  const box = createNode('ink-box')
  applySceneStyle(box, { flexDirection: 'column', flexGrow: 0, flexShrink: 1 })
  const text = createNode('ink-text')
  const link = createNode('ink-link')
  link.attributes['href'] = 'https://mercury.example/doc'
  appendChildNode(link, createTextNode('linked words') as never)
  appendChildNode(text, link as never)
  const plain = createNode('ink-text')
  appendChildNode(plain, createTextNode('plain after') as never)
  appendChildNode(box, text)
  appendChildNode(box, plain)
  appendChildNode(root, box)
  root.layoutNode!.calculateLayout(ALT_COLS, ALT_ROWS)
  const scene: FrameScene = { name: 'link', cols: ALT_COLS, rows: ALT_ROWS, root: { kind: 'box' } }
  void scene
  const createRenderer = require('../../src/ink/renderer.js').default as (
    r: unknown,
    p: unknown,
  ) => (o: unknown) => Frame
  const { emptyFrame } = require('../../src/ink/frame.js') as typeof import('../../src/ink/frame.js')
  const render = createRenderer(root, ctx.stylePool)
  return render({
    frontFrame: emptyFrame(ALT_ROWS, ALT_COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    backFrame: emptyFrame(ALT_ROWS, ALT_COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    isTTY: true,
    terminalWidth: ALT_COLS,
    terminalRows: ALT_ROWS,
    altScreen: true,
    prevFrameContaminated: true,
  }).frame
}

console.log('native-core T1 — writer contract (style-aware replay laws)')
{
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const emu = new AnsiEmulator(ALT_COLS, ALT_ROWS, true)
  let prev: Frame | undefined
  for (let step = 0; step < 6; step++) {
    const frame = composeScene(styledPane(step), ctx, prev, { altScreen: true })
    const raw = log.render(
      prev ?? {
        screen: composeScene(styledPane(0), makeContext(), undefined, { altScreen: true }).screen,
        viewport: { width: ALT_COLS, height: ALT_ROWS },
        cursor: { x: 0, y: 0, visible: true },
      },
      frame,
      true,
      true,
    )
    if (prev === undefined) {
      const empty = composeScene(
        { name: 'empty', cols: ALT_COLS, rows: ALT_ROWS, root: { kind: 'box' } },
        ctx,
        undefined,
        { altScreen: true },
      )
      const first = log.render(empty, frame, true, true)
      emu.feed(CURSOR_HOME)
      emu.feed(serialize(optimize(first)))
      checkFrameState('alt step 0', emu, frame, ctx, 0)
      prev = frame
      continue
    }

    const rawBytes = serialize(raw)
    const opt = optimize(raw)
    const optBytes = serialize(opt)
    const emuRaw = cloneEmu(emu)
    emuRaw.feed(CURSOR_HOME)
    emuRaw.feed(rawBytes)
    emu.feed(CURSOR_HOME)
    emu.feed(optBytes)
    check(
      `alt step ${step}: optimizer replay-equivalent`,
      JSON.stringify(emuRaw.grid) === JSON.stringify(emu.grid) &&
        JSON.stringify(emuRaw.cellStyles) === JSON.stringify(emu.cellStyles) &&
        JSON.stringify(emuRaw.cellLinks) === JSON.stringify(emu.cellLinks),
    )
    check(
      `alt step ${step}: optimize idempotent`,
      JSON.stringify(optimize(opt)) === JSON.stringify(opt),
    )

    checkFrameState(`alt step ${step}`, emu, frame, ctx, 0)
    prev = frame
  }

  const again = composeScene(styledPane(5), ctx, prev, { altScreen: true })
  const zd = serialize(optimize(log.render(prev!, again, true, true)))
  check('alt zero-dirty ⇒ zero bytes', zd.length === 0, JSON.stringify(zd.slice(0, 60)))

  const ctx2 = makeContext()
  const log2 = new FrameWriter({ isTTY: true, stylePool: ctx2.stylePool })
  const emu2 = new AnsiEmulator(ALT_COLS, ALT_ROWS, true)
  const linked = linkScene(ctx2)
  const empty2 = composeScene(
    { name: 'empty', cols: ALT_COLS, rows: ALT_ROWS, root: { kind: 'box' } },
    ctx2,
    undefined,
    { altScreen: true },
  )
  emu2.feed(CURSOR_HOME)
  emu2.feed(serialize(optimize(log2.render(empty2, linked, true, true))))
  checkFrameState('link scene', emu2, linked, ctx2, 0)
}

{
  const COLS = 34
  const VIEWPORT = 8
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const emu = new AnsiEmulator(COLS, VIEWPORT, false)

  const mkScene = (lines: Array<{ t: string; c?: string; b?: boolean }>): FrameScene => ({
    name: 'inline-styled',
    cols: COLS,
    rows: VIEWPORT,
    root: {
      kind: 'box',
      style: { flexDirection: 'column' },
      children: lines.map(l => ({
        kind: 'text' as const,
        text: l.t,
        style: { ...(l.c ? { color: l.c } : {}), ...(l.b ? { bold: true } : {}) },
      })),
    },
  })

  const steps: Array<Array<{ t: string; c?: string; b?: boolean }>> = []
  {
    const lines: Array<{ t: string; c?: string; b?: boolean }> = []
    for (let n = 0; n < 14; n++) {
      lines.push({ t: `row ${n} steady`, c: n % 3 === 0 ? 'cyan' : undefined, b: n % 4 === 0 })
      if (n >= 1 && n % 2 === 1) steps.push([...lines])
    }
    const edited = [...lines]
    edited[edited.length - 1] = { t: 'tail edited 漢字', c: 'yellow', b: true }
    steps.push(edited)
    steps.push(edited.slice(0, 12))
    const regrow12 = [...edited.slice(0, 12)]
    regrow12.push({ t: 'reborn 12', c: 'cyan' }, { t: 'reborn 13' })
    steps.push(regrow12)
    steps.push(regrow12.slice(0, 3).map((_, i) => ({ t: `post-epoch ${i}`, c: 'green' })))
    const regrow = [...steps[steps.length - 1]!]
    for (let i = 0; i < 6; i++) regrow.push({ t: `regrow ${i}` })
    steps.push(regrow)
    steps.push([])
    steps.push([{ t: 'after empty', c: 'yellow' }, { t: 'second row' }])
  }

  let prev: Frame | undefined
  for (let si = 0; si < steps.length; si++) {
    const frame = composeScene(mkScene(steps[si]!), ctx, prev, {
      altScreen: false,
      viewportRows: VIEWPORT,
      contentHeight: true,
    })
    const emptyPrev: Frame = {
      screen: composeScene(mkScene([]), makeContext(), undefined, {
        altScreen: false,
        viewportRows: VIEWPORT,
        contentHeight: true,
      }).screen,
      viewport: { width: COLS, height: VIEWPORT },
      cursor: { x: 0, y: 0, visible: true },
    }
    const diff = optimize(log.render(prev ?? emptyPrev, frame, false, true))
    const bytes = serialize(diff)
    check(`main step ${si}: no ED bytes`, !/\x1b\[[0-3]?J/.test(bytes))
    emu.feed(bytes)

    for (let wy = emu.cursorY + 1; wy < emu.height; wy++) {
      check(
        `main step ${si}: row below park blank (w${wy})`,
        emu.rowText(wy) === '',
        JSON.stringify(emu.rowText(wy)),
      )
    }

    const rowOffset = frame.cursor.y - emu.cursorY
    checkFrameState(`main step ${si}`, emu, frame, ctx, rowOffset)

    {
      const frameLines: string[] = []
      for (let y = 0; y < frame.screen.height; y++) {
        let line = ''
        for (let x = 0; x < frame.screen.width; x++) {
          line += charInCellAt(frame.screen, x, y) || ' '
        }
        frameLines.push(line.replace(/\s+$/, ''))
      }
      while (frameLines.length > 0 && frameLines[frameLines.length - 1] === '') frameLines.pop()
      const logical = [...emu.scrollback, ...emu.lines()]
      while (logical.length > 0 && logical[logical.length - 1] === '') logical.pop()
      const lastLineWindowRow = logical.length - 1 - emu.scrollback.length
      const expectedY = lastLineWindowRow + (frame.cursor.y - (frameLines.length - 1))
      check(
        `main step ${si}: cursor law`,
        emu.cursorY === expectedY && emu.cursorX === frame.cursor.x,
        `terminal (${emu.cursorX},${emu.cursorY}) vs expected (${frame.cursor.x},${expectedY})`,
      )
    }
    prev = frame
  }
}

function cloneEmu(src: AnsiEmulator): AnsiEmulator {
  const c = new AnsiEmulator(src.width, src.height, true)
  c.grid = src.grid.map(r => [...r])
  c.cellStyles = src.cellStyles.map(r => r.map(s => (s ? { ...s } : null)))
  c.cellLinks = src.cellLinks.map(r => [...r])
  c.cursorX = src.cursorX
  c.cursorY = src.cursorY
  c.sgr = { ...src.sgr }
  c.activeLink = src.activeLink
  return c
}

if (failures > 0) {
  console.log(`\nnative-core writer contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core writer contract: green (${checks} checks)`)
