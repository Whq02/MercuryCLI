#!/usr/bin/env bun
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const { appendChildNode, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { lastComposeCounts } = await import('../../src/ink/compose-buffer.js')
const { applySceneStyle, makeContext } = await import('../ink-runtime/frameHarness.ts')
type ComposeContext = import('../ink-runtime/frameHarness.ts').ComposeContext
type Styles = import('../../src/ink/styles.js').Styles

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const ROOT = resolve(import.meta.dirname, '..', '..')
const DIST = resolve(arg('--dist') ?? resolve(ROOT, 'dist', 'mercury.mjs'))
const HARNESS_ONLY = process.argv.includes('--harness-only')

const GROUND = '#101820'
const COLS = 96
const ROWS = 24

type Tree = {
  root: DOMElement
  render: ReturnType<typeof createRenderer>
  frames: [Frame, Frame]
  spinner: DOMElement
  label: DOMElement
  critter: DOMElement
  capsule: DOMElement
  rail: DOMElement
  ground: DOMElement
  transcript: DOMElement
  content: DOMElement
  items: DOMElement[]
  centre: DOMElement
}

function box(style: Styles, children: DOMElement[] = []): DOMElement {
  const el = createNode('ink-box')
  applySceneStyle(el, { flexDirection: 'column', flexGrow: 0, flexShrink: 0, ...style })
  for (const c of children) appendChildNode(el, c)
  return el
}

function text(s: string): DOMElement {
  const el = createNode('ink-text')
  appendChildNode(el, createTextNode(s) as never)
  return el
}

const textOf = (el: DOMElement): DOMElement['childNodes'][number] => el.childNodes[0]!

function retext(el: DOMElement, s: string): void {
  setTextNodeValue(textOf(el) as never, s)
}

function buildTree(ctx: ComposeContext): Tree {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  const spinner = text('✹')
  const label = text('Molting…')
  const timer = text('(1s)')
  const capsule = box({ flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }, [spinner, text(' '), label, text(' '), timer])
  const critter = text(' ▄▄▄ \n █▀█ \n ▀▀▀ ')
  const band = box({ flexDirection: 'row', borderStyle: 'round', width: COLS }, [box({ width: 7 }, [critter]), capsule])
  const rail = box({ width: 14, overflow: 'hidden' }, [text('lanes'), text('❯ WORKBENCH'), text('  hello')])
  const items = Array.from({ length: 30 }, (_, i) => text(`line ${String(i).padStart(2, '0')} · steady prose that stays`))
  const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, items)
  const transcript = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflowX: 'scroll', overflowY: 'scroll' }, [content])
  setAttribute(transcript, 'stickyScroll', true)
  const centre = box({ flexDirection: 'column', flexGrow: 1, minWidth: 0, overflow: 'hidden' }, [band, transcript])
  const row = box({ flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' }, [rail, centre])
  const footer = box({ flexDirection: 'row', width: COLS }, [text('Type a prompt')])
  const ground = box({ width: COLS, height: ROWS, overflow: 'hidden', backgroundColor: GROUND }, [row, footer])
  appendChildNode(root, ground)
  const frames: [Frame, Frame] = [
    emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
  ]
  return { root, render: createRenderer(root, ctx.stylePool), frames, spinner, label, critter, capsule, rail, ground, transcript, content, items, centre }
}

function renderTree(tree: Tree, scratch: boolean): Frame {
  tree.root.layoutNode!.calculateLayout(COLS, ROWS)
  const [front, back] = tree.frames
  const { frame } = tree.render({
    frontFrame: front,
    backFrame: back,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: scratch,
  })
  tree.frames = [frame, front]
  return frame
}

function firstDifference(a: Frame, b: Frame): string | null {
  const sa = a.screen
  const sb = b.screen
  if (sa.width !== sb.width || sa.height !== sb.height) return `size ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}`
  const words = sa.width * sa.height * 2
  for (let at = 0; at < words; at++) {
    if (sa.cells[at] !== sb.cells[at]) {
      const cell = at >> 1
      const x = cell % sa.width
      const y = Math.floor(cell / sa.width)
      return `cell (${x},${y}) glyph/style ${sa.cells[cell << 1]}/${sa.cells[(cell << 1) + 1]} vs ${sb.cells[cell << 1]}/${sb.cells[(cell << 1) + 1]}`
    }
  }
  return null
}

const ctx = makeContext()
const live = buildTree(ctx)
const scratch = buildTree(ctx)

type Step = { name: string; apply: (t: Tree) => void; writeCap?: number; expectNoWrite?: boolean }

const steps: Step[] = [
  { name: 'first paint', apply: () => {} },
  { name: 'spinner tick', apply: t => retext(t.spinner, '✺'), writeCap: COLS },
  { name: 'spinner tick with a longer label', apply: t => { retext(t.spinner, '✹'); retext(t.label, 'Tinder-shaving…') }, writeCap: COLS },
  { name: 'nothing changed', apply: () => {}, expectNoWrite: true },
  { name: 'label shrinks in place', apply: t => retext(t.label, 'Hm…'), writeCap: COLS },
  { name: 'spinner tick', apply: t => retext(t.spinner, '✻'), writeCap: COLS },
  { name: 'transcript tail grows (sticky)', apply: t => { const item = text('line 30 · the tail'); t.items.push(item); appendChildNode(t.content, item) } },
  { name: 'transcript tail line shrinks in place', apply: t => retext(t.items.at(-1)!, 'line 30') },
  { name: 'tail becomes two lines then one', apply: t => retext(t.items.at(-1)!, 'line 30\nmore words here') },
  { name: 'tail second line shortens', apply: t => retext(t.items.at(-1)!, 'line 30\nm') },
  { name: 'band grows a row', apply: t => retext(t.critter, ' ▄▄▄ \n █▀█ \n ▀▀▀ \n ▀ ▀ ') },
  { name: 'spinner tick after the band grew', apply: t => retext(t.spinner, '✹'), writeCap: COLS },
  { name: 'band shrinks back', apply: t => retext(t.critter, ' ▄▄▄ \n █▀█ \n ▀▀▀ ') },
  { name: 'a transcript item is removed', apply: t => { const gone = t.items.splice(28, 1)[0]!; removeChildNode(t.content, gone) } },
  { name: 'a transcript item is inserted', apply: t => { const item = text('line 28 · back'); insertBeforeNode(t.content, item, t.items[28]!); t.items.splice(28, 0, item) } },
  { name: 'capsule border removed', apply: t => applySceneStyle(t.capsule, { flexDirection: 'row', flexGrow: 1 }) },
  { name: 'capsule border restored', apply: t => applySceneStyle(t.capsule, { flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }) },
  { name: 'rail hidden', apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: 'none' }) },
  { name: 'rail shown', apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: 'flex' }) },
  { name: 'a popup opens over the transcript', apply: t => { const popup = box({ position: 'absolute', backgroundColor: '#3a2a10', borderStyle: 'round', width: 30, height: 6 }, [text('popup line one'), text('popup line two')]); ;(t as Tree & { popup?: DOMElement }).popup = popup; appendChildNode(t.centre, popup) } },
  { name: 'spinner tick with the popup open', apply: t => retext(t.spinner, '✺') },
  { name: 'popup text changes', apply: t => retext((t as Tree & { popup?: DOMElement }).popup!.childNodes[1] as DOMElement, 'popup line changed') },
  { name: 'popup closes', apply: t => { const popup = (t as Tree & { popup?: DOMElement }).popup!; removeChildNode(t.centre, popup) } },
  { name: 'spinner tick after the popup', apply: t => retext(t.spinner, '✹'), writeCap: COLS },
  { name: 'ground colour changes', apply: t => applySceneStyle(t.ground, { width: COLS, height: ROWS, overflow: 'hidden', backgroundColor: '#201810' }) },
  { name: 'spinner tick on the new ground', apply: t => retext(t.spinner, '✺'), writeCap: COLS },
  { name: 'transcript scrolls up by three', apply: t => { ;(t.transcript.scroll ??= {}).pendingScrollDelta = -3; t.transcript.scroll.stickyScroll = false; markDirty(t.transcript) } },
  { name: 'spinner tick while scrolled', apply: t => retext(t.spinner, '✹') },
  { name: 'nothing changed while scrolled', apply: () => {} },
]

console.log('the held ground: the compose walk reuses the previous frame under a filled box')
console.log('§1 harness — incremental compose equals a from-scratch compose at every step, and a tick writes its own row')
for (const step of steps) {
  step.apply(live)
  step.apply(scratch)
  const liveFrame = renderTree(live, false)
  const counts = { ...lastComposeCounts }
  const scratchFrame = renderTree(scratch, true)
  const diff = firstDifference(liveFrame, scratchFrame)
  check(`${step.name}: the screen equals the from-scratch compose`, diff === null, diff ?? '')
  if (step.writeCap !== undefined) {
    check(`${step.name}: writes ${counts.write} cells, within one row (${step.writeCap}), blits ${counts.blit}`, counts.write <= step.writeCap && counts.blit >= COLS * ROWS)
  }
  if (step.expectNoWrite) check(`${step.name}: writes nothing`, counts.write === 0, `write=${counts.write}`)
}

if (!HARNESS_ONLY) {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
    process.exit(2)
  }
  const { runArtifactArena } = await import('../streaming/artifactArena.ts')
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  type Composed = { f?: number; ts?: number; counts?: { blit: number; write: number }; rows?: string[] }

  async function capture(cols: number, rows: number, kind: 'hang' | 'paced'): Promise<{ frames: Composed[]; submit: number; complete: boolean; reason: string | null; emission: { start: number; end: number } | null }> {
    const dir = mkdtempSync(join(tmpdir(), 'ground-reuse-'))
    const tee = join(dir, 'composed.jsonl')
    const turn = kind === 'hang'
      ? { kind: 'hang' as const, deltas: [], whenModel: 'opus' }
      : { kind: 'paced' as const, whenModel: 'opus', deltas: Array.from({ length: 160 }, (_, i) => (i % 25 === 24 ? 'lattice.\n' : `word${i} `)), gapMs: 40 }
    const run = await runArtifactArena({
      turns: [turn],
      sends: ['4500:hello', '5300:\\r'],
      seconds: kind === 'hang' ? 12 : 14,
      cols,
      rows,
      distPath: DIST,
      anchor: { needle: 'Type a prompt', atMs: 3000 },
      extraEnv: { COLORTERM: 'truecolor', INK_COMPOSED_TEE: tee },
    })
    const frames: Composed[] = existsSync(tee)
      ? readFileSync(tee, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Composed).filter(r => typeof r.f === 'number')
      : []
    const emits = run.fixture.pacedEmits
    const emission = emits.length > 0 ? { start: Math.min(...emits.map(e => e.at)), end: Math.max(...emits.map(e => e.at)) } : null
    return { frames, submit: run.sendLog.at(-1)?.sent ?? 0, complete: run.outcome.complete, reason: run.outcome.reason, emission }
  }

  for (const cols of [178, 269]) {
    console.log(`§2 ${cols}x70, truecolor ground, a hung turn (the spinner ticks)`)
    const { frames, submit, complete, reason } = await capture(cols, 70, 'hang')
    check(`${cols}: the capture completed`, complete, reason ?? '')
    const steady = frames.filter(r => (r.ts ?? 0) >= submit + 1500)
    check(`${cols}: enough steady frames (${steady.length})`, steady.length >= 20)
    const ticks = steady.filter(r => (r.counts?.write ?? 0) > 0)
    check(`${cols}: the spinner ticked (${ticks.length} frames wrote)`, ticks.length >= 10)
    const scratchFrames = steady.filter(r => (r.counts?.blit ?? 0) === 0)
    check(`${cols}: no steady frame composes from scratch (blit=0 frames: ${scratchFrames.length})`, scratchFrames.length === 0)
    const over = steady.filter(r => (r.counts?.write ?? 0) > cols)
    const worst = Math.max(0, ...steady.map(r => r.counts?.write ?? 0))
    check(`${cols}: every tick writes at most one row of cells (worst ${worst}, cap ${cols})`, over.length === 0, over.slice(0, 3).map(r => `f=${r.f} write=${r.counts?.write} blit=${r.counts?.blit}`).join('; '))
  }

  {
    const cols = 269
    console.log(`§3 ${cols}x70, truecolor ground, a streamed turn (the tail grows)`)
    const { frames, complete, reason, emission } = await capture(cols, 70, 'paced')
    check(`stream: the capture completed`, complete, reason ?? '')
    check(`stream: the fixture streamed the turn`, emission !== null && emission.end - emission.start >= 3000, emission ? `${emission.end - emission.start} ms` : 'no emits')
    const steady = emission === null ? [] : frames.filter(r => (r.ts ?? 0) >= emission.start + 500 && (r.ts ?? 0) <= emission.end - 300)
    check(`stream: enough frames while the tail was live (${steady.length})`, steady.length >= 40)
    const scratchFrames = steady.filter(r => (r.counts?.blit ?? 0) === 0)
    check(`stream: no steady frame composes from scratch (blit=0 frames: ${scratchFrames.length})`, scratchFrames.length === 0)
    const grounded = steady.filter(r => (r.counts?.blit ?? 0) >= cols * 70)
    check(`stream: the ground is reused whole on every frame (${grounded.length}/${steady.length})`, grounded.length === steady.length)
    const over: string[] = []
    for (const r of steady) {
      const tailRows = (r.rows ?? []).filter(row => row.includes('word')).length
      const cap = 2 * (tailRows + 1) * cols
      if ((r.counts?.write ?? 0) > cap) over.push(`f=${r.f} write=${r.counts?.write} tailRows=${tailRows}`)
    }
    check(`stream: a publish writes no more than the tail node's rows (twice, ground and text)`, over.length === 0, over.slice(0, 3).join('; '))
  }
}

if (failures > 0) {
  console.error(`\n❌ ${failures} GROUND-REUSE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL GROUND-REUSE PROOFS PASS')
