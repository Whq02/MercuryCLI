#!/usr/bin/env bun
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
const BAND = '#4b2527'
const COLS = 96
const ROWS = 24

type Rig = {
  root: DOMElement
  render: ReturnType<typeof createRenderer>
  frames: [Frame, Frame]
  cols: number
  rows: number
  regionScroll: boolean
}

function box(style: Styles, children: DOMElement[] = []): DOMElement {
  const el = createNode('ink-box')
  applySceneStyle(el, { flexDirection: 'column', flexGrow: 0, flexShrink: 0, ...style })
  for (const c of children) appendChildNode(el, c)
  return el
}

function text(s: string, style?: Styles): DOMElement {
  const el = createNode('ink-text')
  if (style) applySceneStyle(el, style)
  appendChildNode(el, createTextNode(s) as never)
  return el
}

const textOf = (el: DOMElement): DOMElement['childNodes'][number] => el.childNodes[0]!

function retext(el: DOMElement, s: string): void {
  setTextNodeValue(textOf(el) as never, s)
}

function rig(ctx: ComposeContext, cols: number, rows: number, regionScroll: boolean): Rig {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
  const frames: [Frame, Frame] = [
    emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
  ]
  return { root, render: createRenderer(root, ctx.stylePool), frames, cols, rows, regionScroll }
}

function renderRig(r: Rig, scratch: boolean): Frame {
  r.root.layoutNode!.calculateLayout(r.cols, r.rows)
  const [front, back] = r.frames
  const { frame } = r.render({
    frontFrame: front,
    backFrame: back,
    isTTY: true,
    terminalWidth: r.cols,
    terminalRows: r.rows,
    altScreen: true,
    prevFrameContaminated: scratch,
    regionScrollUsable: r.regionScroll,
  })
  r.frames = [frame, front]
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

type Step<T> = { name: string; apply: (t: T) => void; writeCap?: number; expectNoWrite?: boolean }

function runScene<T extends { rig: Rig }>(title: string, live: T, scratch: T, steps: Step<T>[]): void {
  console.log(title)
  for (const step of steps) {
    step.apply(live)
    step.apply(scratch)
    const liveFrame = renderRig(live.rig, false)
    const counts = { ...lastComposeCounts }
    const scratchFrame = renderRig(scratch.rig, true)
    const diff = firstDifference(liveFrame, scratchFrame)
    check(`${step.name}: the screen equals the from-scratch compose`, diff === null, diff ?? '')
    if (step.writeCap !== undefined) {
      check(`${step.name}: writes ${counts.write} cells, within one row (${step.writeCap}), blits ${counts.blit}`, counts.write <= step.writeCap && counts.blit >= live.rig.cols * live.rig.rows)
    }
    if (step.expectNoWrite) check(`${step.name}: writes nothing`, counts.write === 0, `write=${counts.write}`)
  }
}

const scrollTo = (scroller: DOMElement, top: number): void => {
  const scroll = (scroller.scroll ??= {})
  scroll.scrollTop = Math.max(0, top)
  scroll.stickyScroll = false
  scroll.pendingScrollDelta = undefined
  markDirty(scroller)
}

const scrollBy = (scroller: DOMElement, delta: number): void => scrollTo(scroller, (scroller.scroll?.scrollTop ?? 0) + delta)

type Cockpit = {
  rig: Rig
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
  popup?: DOMElement
}

function buildCockpit(ctx: ComposeContext): Cockpit {
  const r = rig(ctx, COLS, ROWS, false)
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
  appendChildNode(r.root, ground)
  return { rig: r, spinner, label, critter, capsule, rail, ground, transcript, content, items, centre }
}

const cockpitSteps: Step<Cockpit>[] = [
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
  { name: 'a popup opens over the transcript', apply: t => { t.popup = box({ position: 'absolute', backgroundColor: '#3a2a10', borderStyle: 'round', width: 30, height: 6 }, [text('popup line one'), text('popup line two')]); appendChildNode(t.centre, t.popup) } },
  { name: 'spinner tick with the popup open', apply: t => retext(t.spinner, '✺') },
  { name: 'popup text changes', apply: t => retext(t.popup!.childNodes[1] as DOMElement, 'popup line changed') },
  { name: 'popup closes', apply: t => removeChildNode(t.centre, t.popup!) },
  { name: 'spinner tick after the popup', apply: t => retext(t.spinner, '✹'), writeCap: COLS },
  { name: 'ground colour changes', apply: t => applySceneStyle(t.ground, { width: COLS, height: ROWS, overflow: 'hidden', backgroundColor: '#201810' }) },
  { name: 'spinner tick on the new ground', apply: t => retext(t.spinner, '✺'), writeCap: COLS },
  { name: 'transcript scrolls up by three', apply: t => { ;(t.transcript.scroll ??= {}).pendingScrollDelta = -3; t.transcript.scroll.stickyScroll = false; markDirty(t.transcript) } },
  { name: 'spinner tick while scrolled', apply: t => retext(t.spinner, '✹') },
  { name: 'nothing changed while scrolled', apply: () => {} },
  { name: 'a scrolled item grows two lines after the scroll', apply: t => retext(t.items[22]!, 'line 22 · grew\nsecond line\nthird') },
  { name: 'the grown item folds back', apply: t => retext(t.items[22]!, 'line 22 · steady prose that stays') },
]

type Section = { header: DOMElement; rows: Row[] }
type Row = { box: DOMElement; label: DOMElement; evidence: DOMElement | null; words: string }
type Health = { rig: Rig; scroller: DOMElement; content: DOMElement; sections: Section[]; footer: DOMElement; selected: Row | null }

const HEALTH_LIST_ROWS = 16
const HEALTH_INNER = COLS - 4

function healthRow(label: string, status: string): Row {
  const words = `  · ${label.padEnd(18).slice(0, 18)} ${status}`
  const rowText = text(words, { textWrap: 'truncate-end' })
  const rowBox = box({ flexDirection: 'column', width: HEALTH_INNER, overflow: 'hidden' }, [rowText])
  return { box: rowBox, label: rowText, evidence: null, words }
}

function healthSection(title: string, first: boolean, rows: Row[]): Section {
  const rule = box({ flexGrow: 1, height: 1, marginLeft: 1, borderStyle: 'single', borderTop: false, borderLeft: false, borderRight: false })
  const header = box({ flexDirection: 'row', marginTop: first ? 0 : 1 }, [text(title), rule])
  return { header, rows }
}

function buildHealth(ctx: ComposeContext): Health {
  const r = rig(ctx, COLS, ROWS, false)
  const statuses = ['ok', 'off', 'info', 'ok', 'ok', 'warn', 'info']
  const labels = ['Version locks', 'Crash reports', 'Edit outcomes', 'Node & ripgrep', 'Bash tool shell', 'Eval languages']
  const sections: Section[] = ['ENVIRONMENT', 'RUNTIME', 'DURABILITY', 'TERMINAL', 'STORAGE', 'NETWORK', 'ACCOUNTS', 'EXTENSIONS', 'SCHEDULER', 'SESSIONS'].map((title, s) =>
    healthSection(title, s === 0, labels.slice(0, 3 + (s % 3)).map((label, i) => healthRow(`${label} ${s}`, statuses[(i + s) % statuses.length]!))),
  )
  const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, sections.map(s => box({ flexDirection: 'column' }, [s.header, ...s.rows.map(row => row.box)])))
  const scroller = box({ height: HEALTH_LIST_ROWS, flexDirection: 'column', overflowX: 'scroll', overflowY: 'scroll' }, [content])
  const footer = text('↑↓ move · ↵ unfold · esc closes', { textWrap: 'truncate-end' })
  const certificate = box(
    { width: COLS, height: ROWS, borderStyle: 'round', paddingX: 1, backgroundColor: GROUND, opaque: true, flexDirection: 'column' },
    [
      box({ height: 1 }, [text('Mercury · health · OK')]),
      box({ height: 1 }, [text('42 checks · 30 ok · 5 off · 7 info')]),
      box({ height: 1 }),
      scroller,
      box({ height: 1 }, [footer]),
    ],
  )
  appendChildNode(r.root, certificate)
  return { rig: r, scroller, content, sections, footer, selected: null }
}

function select(h: Health, row: Row | null): void {
  if (h.selected) applySceneStyle(h.selected.box, { flexDirection: 'column', width: HEALTH_INNER, overflow: 'hidden' })
  h.selected = row
  if (row) applySceneStyle(row.box, { flexDirection: 'column', width: HEALTH_INNER, overflow: 'hidden', backgroundColor: BAND })
}

function unfold(row: Row, evidence: string): void {
  if (row.evidence) return
  row.evidence = box({ flexDirection: 'column', marginLeft: 4, marginBottom: 1 }, [text(evidence, { textWrap: 'wrap' })])
  appendChildNode(row.box, row.evidence)
}

function fold(row: Row): void {
  if (!row.evidence) return
  removeChildNode(row.box, row.evidence)
  row.evidence = null
}

const row = (h: Health, s: number, i: number): Row => h.sections[s]!.rows[i]!

const healthSteps: Step<Health>[] = [
  { name: 'first paint', apply: () => {} },
  { name: 'select a row', apply: h => select(h, row(h, 0, 2)) },
  ...Array.from({ length: 12 }, (_, k) => ({ name: `scroll down one row (${k + 1})`, apply: (h: Health) => scrollBy(h.scroller, 1) })),
  { name: 'select a row further down', apply: h => select(h, row(h, 1, 3)) },
  { name: 'the selected row unfolds after the scroll', apply: h => unfold(row(h, 1, 3), 'native image processor — sharp and libvips from the vendored build, with the full format table and the colour management profile loaded') },
  { name: 'the footer changes while unfolded', apply: h => retext(h.footer, '↑↓ move · ↵ fold · esc closes') },
  { name: 'nothing changed while unfolded', apply: () => {}, expectNoWrite: true },
  { name: 'the unfolded row folds', apply: h => fold(row(h, 1, 3)) },
  { name: 'the next row is selected', apply: h => select(h, row(h, 2, 0)) },
  { name: 'the next row unfolds (two lines and a spacer)', apply: h => unfold(row(h, 2, 0), 'the system shell serves the Bash tool; arm the vendored engine with the setting or the environment variable to switch') },
  { name: 'scroll up three while unfolded', apply: h => scrollBy(h.scroller, -3) },
  { name: 'the unfolded row folds after the upward scroll', apply: h => fold(row(h, 2, 0)) },
  { name: 'a status shrinks after the scroll (info to ok)', apply: h => retext(row(h, 1, 1).label, row(h, 1, 1).words.replace(/\S+$/, 'ok')) },
  ...Array.from({ length: 5 }, (_, k) => ({ name: `scroll down one row again (${k + 1})`, apply: (h: Health) => scrollBy(h.scroller, 1) })),
  { name: 'a row label grows after the scroll', apply: h => retext(row(h, 3, 0).label, row(h, 3, 0).words.replace(/\S+$/, 'STILL FAILING')) },
  { name: 'a section header line grows', apply: h => retext(h.sections[2]!.header.childNodes[0] as DOMElement, 'DURABILITY (3)') },
  { name: 'scroll to the top', apply: h => scrollTo(h.scroller, 0) },
  { name: 'the first row unfolds at the top', apply: h => unfold(row(h, 0, 0), 'one line of evidence') },
  { name: 'scroll down past the unfolded row', apply: h => scrollBy(h.scroller, 4) },
  { name: 'the first row folds out of sight', apply: h => fold(row(h, 0, 0)) },
  { name: 'nothing changed at the end', apply: () => {}, expectNoWrite: true },
]

type Transcript = { rig: Rig; status: DOMElement; scroller: DOMElement; content: DOMElement; items: DOMElement[] }

function buildTranscript(ctx: ComposeContext): Transcript {
  const r = rig(ctx, COLS, ROWS, true)
  const status = text('✹ thinking')
  const items = Array.from({ length: 40 }, (_, i) => text(`${String(i).padStart(2, '0')} ${i % 3 === 0 ? 'a short row' : i % 3 === 1 ? 'a longer row of transcript prose that reaches further' : 'medium row of prose'}`))
  const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, items)
  const scroller = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, width: COLS, overflowX: 'scroll', overflowY: 'scroll' }, [content])
  setAttribute(scroller, 'stickyScroll', true)
  const ground = box({ width: COLS, height: ROWS, overflow: 'hidden', backgroundColor: GROUND }, [box({ height: 2, flexDirection: 'row' }, [status]), scroller, box({ height: 1 }, [text('Type a prompt')])])
  appendChildNode(r.root, ground)
  return { rig: r, status, scroller, content, items }
}

const transcriptSteps: Step<Transcript>[] = [
  { name: 'first paint (sticky at the bottom)', apply: () => {} },
  { name: 'spinner tick', apply: t => retext(t.status, '✺ thinking'), writeCap: COLS },
  { name: 'tail grows a row (the region scrolls by one)', apply: t => { const item = text('40 the tail'); t.items.push(item); appendChildNode(t.content, item) } },
  { name: 'tail grows another row', apply: t => { const item = text('41 a longer tail row of prose that reaches'); t.items.push(item); appendChildNode(t.content, item) } },
  { name: 'a visible row unfolds right after the region scroll', apply: t => retext(t.items[36]!, '36 a short row\n   unfolded into a second line\n   and a third') },
  { name: 'spinner tick while unfolded', apply: t => retext(t.status, '✹ thinking'), writeCap: COLS },
  { name: 'the unfolded row folds', apply: t => retext(t.items[36]!, '36 a short row') },
  { name: 'scroll up two rows', apply: t => scrollBy(t.scroller, -2) },
  { name: 'a visible row shrinks after the upward scroll', apply: t => retext(t.items[34]!, '34 x') },
  { name: 'scroll up one more row', apply: t => scrollBy(t.scroller, -1) },
  { name: 'the shrunk row grows again', apply: t => retext(t.items[34]!, '34 a longer row of transcript prose that reaches further') },
  { name: 'nothing changed', apply: () => {}, expectNoWrite: true },
  { name: 'scroll to the top', apply: t => scrollTo(t.scroller, 0) },
  ...Array.from({ length: 6 }, (_, k) => ({ name: `scroll down one row from the top (${k + 1})`, apply: (t: Transcript) => scrollBy(t.scroller, 1) })),
  { name: 'a visible row unfolds after the downward scroll', apply: t => retext(t.items[12]!, '12 a short row\n   unfolded into a second line\n   and a third') },
  { name: 'spinner tick while unfolded again', apply: t => retext(t.status, '✺ thinking'), writeCap: COLS },
  { name: 'the row folds after the downward scroll', apply: t => retext(t.items[12]!, '12 a short row') },
  { name: 'a visible row grows by one line after the fold', apply: t => retext(t.items[15]!, '15 a short row\n   with a second line') },
  { name: 'that row shrinks back', apply: t => retext(t.items[15]!, '15 a short row') },
  { name: 'the scroll follows the tail again', apply: t => { ;(t.scroller.scroll ??= {}).stickyScroll = true; markDirty(t.scroller) } },
  { name: 'tail grows after re-sticking', apply: t => { const item = text('42 one more'); t.items.push(item); appendChildNode(t.content, item) } },
  { name: 'spinner tick at the end', apply: t => retext(t.status, '✹ thinking'), writeCap: COLS },
]

console.log('the held ground: the compose walk reuses the previous frame under a filled box')
{
  const ctx = makeContext()
  runScene('§1 cockpit harness — incremental compose equals a from-scratch compose at every step, and a tick writes its own row', buildCockpit(ctx), buildCockpit(ctx), cockpitSteps)
}
{
  const ctx = makeContext()
  runScene('§4 health-shaped harness — rows scroll one at a time through the fast path, then a row unfolds, folds, shrinks and grows', buildHealth(ctx), buildHealth(ctx), healthSteps)
}
{
  const ctx = makeContext()
  runScene('§5 full-width transcript harness — the region scrolls under a held ground, then rows unfold and fold', buildTranscript(ctx), buildTranscript(ctx), transcriptSteps)
}

if (!HARNESS_ONLY) {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
    process.exit(2)
  }
  const { runArtifactArena } = await import('../streaming/artifactArena.ts')
  const { nodeBinPath } = await import('../lib/nodeBin.ts')
  const { ptyDriverPython } = await import('../lib/captureDriver.ts')

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

  {
    const cols = 120
    const rows = 44
    console.log(`§6 the health screen in a ${cols}x${rows} PTY — ninety-five arrow presses scroll the list through the fast path, then the row unfolds and folds`)
    const scratchDir = mkdtempSync(join(tmpdir(), 'ground-reuse-health-'))
    const home = join(scratchDir, 'home')
    const configDir = join(home, '.mercury')
    mkdirSync(configDir, { recursive: true })
    const cwd = join(scratchDir, 'cwd')
    mkdirSync(cwd)
    writeFileSync(join(configDir, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
    const ESC = '\x1b'
    const DOWN = `${ESC}[B`
    const shot = (mark: string, ticks: number): Record<string, unknown> => ({ afterPrevTicks: ticks, data: '', mark })
    const sends: Record<string, unknown>[] = [
      { afterPrevTicks: 12, data: '', mark: 'early' },
      { afterPrevTicks: 240, data: '', mark: 'done' },
      { afterPrevTicks: 1, data: `${ESC}[H` },
      ...Array.from({ length: 95 }, () => ({ afterPrevTicks: 1, data: DOWN })),
      shot('selected', 6),
      { afterPrevTicks: 1, data: '\r' },
      shot('unfolded', 8),
      shot('unfolded-reference', 14),
      { afterPrevTicks: 1, data: '\r' },
      shot('folded', 8),
      { afterPrevTicks: 1, data: DOWN },
      { afterPrevTicks: 1, data: '\r' },
      shot('next-unfolded', 8),
      shot('next-reference', 14),
    ]
    const roundTrip = (afterMark: string): Record<string, unknown>[] => [{ afterMark, afterMs: 300, cols, rows: rows + 1 }, { afterMark, afterMs: 1500, cols, rows }]
    const out = join(scratchDir, 'grid.json')
    const cfgPath = join(scratchDir, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify({ argv: [nodeBinPath(), DIST, 'health'], cwd, cols, rows, total: 480, sends, out, stableTicks: 6, resizes: [...roundTrip('unfolded'), ...roundTrip('next-unfolded')] }))
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_UPDATE_NOTICE: '0',
      MERCURY_OPERATOR: 'sam',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      BROWSER: '/usr/bin/true',
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'Apple_Terminal',
      LANG: 'en_US.UTF-8',
      COLORTERM: 'truecolor',
      TMPDIR: tmpdir(),
    }
    const r = spawnSync(ptyDriverPython('the health screen'), [join(ROOT, 'scripts/ui/vshot.py'), cfgPath], { cwd, env, encoding: 'utf8', timeout: 480 * 200 + 120_000 })
    check('health: the capture ran', r.status === 0 && existsSync(out), `rc=${r.status} ${(r.stderr ?? '').trim().slice(-200)}`)
    type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
    type Mark = { label: string; grid: Cell[][] }
    const marks = existsSync(out) ? ((JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }).marks ?? []) : []
    const byLabel = new Map(marks.map(m => [m.label, m]))
    const wanted = ['selected', 'unfolded', 'unfolded-reference', 'folded', 'next-unfolded', 'next-reference']
    check(`health: every mark landed (${marks.map(m => m.label).join(',')})`, wanted.every(l => byLabel.has(l)))
    const bodyOf = (label: string): string[] => {
      const grid = byLabel.get(label)?.grid ?? []
      const plain = grid.map(row => row.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
      const from = plain.findIndex(l => l.includes(' checks'))
      let to = -1
      for (let i = plain.length - 1; i >= 0; i--) if (plain[i]!.includes('╰')) { to = i; break }
      if (from < 0 || to <= from) return []
      return grid.slice(from, to + 1).map(row => row.map(c => `${c.c || ' '}|${c.fg}|${c.bg}|${c.bold ? 1 : 0}${c.rev ? 1 : 0}`).join('\t'))
    }
    const plainOf = (label: string): string[] => (byLabel.get(label)?.grid ?? []).map(row => row.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
    const firstRowDiff = (a: string[], b: string[]): string => {
      if (a.length !== b.length) return `${a.length} rows vs ${b.length}`
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `row ${i}: ${a[i]!.split('\t').map(c => c[0]).join('').trimEnd().slice(0, 60)} vs ${b[i]!.split('\t').map(c => c[0]).join('').trimEnd().slice(0, 60)}`
      return ''
    }
    const selected = bodyOf('selected')
    const unfolded = bodyOf('unfolded')
    check(`health: the popup body was found (${selected.length} rows)`, selected.length > 20)
    check('health: the unfold changed the screen', unfolded.length > 0 && firstRowDiff(selected, unfolded) !== '')
    check('health: the unfolded screen equals its from-scratch reference, cell for cell', unfolded.length > 0 && firstRowDiff(unfolded, bodyOf('unfolded-reference')) === '', firstRowDiff(unfolded, bodyOf('unfolded-reference')))
    check('health: folding restores the selected screen, cell for cell', firstRowDiff(selected, bodyOf('folded')) === '', firstRowDiff(selected, bodyOf('folded')))
    const next = bodyOf('next-unfolded')
    check('health: the next row unfolds and equals its from-scratch reference, cell for cell', next.length > 0 && firstRowDiff(next, bodyOf('next-reference')) === '', firstRowDiff(next, bodyOf('next-reference')))
    const stale = [...plainOf('unfolded'), ...plainOf('next-unfolded')].filter(l => /(info|ok|off)[a-z]*─|ok[a-z]{1,3}\s|[A-Z]{4,}[a-z]─/.test(l))
    check('health: no row carries a previous row\'s tail or a stale letter before a rule', stale.length === 0, stale.slice(0, 2).join(' | '))
  }
}

if (failures > 0) {
  console.error(`\n❌ ${failures} GROUND-REUSE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL GROUND-REUSE PROOFS PASS')
