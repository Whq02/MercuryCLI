import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  LayoutMeasureMode,
  LayoutNode,
  LayoutOverflow,
  LayoutPositionType,
  LayoutWrap,
} from '../../src/screen/renderer/layout/node.js'

type Counters = { visited: number; measured: number; cacheHits: number; live: number }
export type Engine = { create: () => LayoutNode; counters: () => Counters; trace: string; open: string | null }
export type Recorded = Map<string, string[]>

type Measure = number | `${number}%`
type Edges = Partial<Record<LayoutEdge, number>>
type Shape = 'wrap' | 'block' | 'half' | 'void'
type Detail = 'rects' | 'digests' | 'sealed'
type Spec = {
  width?: Measure | 'auto'
  height?: Measure | 'auto'
  minWidth?: Measure
  minHeight?: Measure
  maxWidth?: Measure
  maxHeight?: Measure
  direction?: LayoutFlexDirection
  grow?: number
  shrink?: number
  basis?: Measure
  wrap?: LayoutWrap
  items?: LayoutAlign
  self?: LayoutAlign
  justify?: LayoutJustify
  display?: LayoutDisplay
  place?: LayoutPositionType
  inset?: Partial<Record<LayoutEdge, Measure>>
  overflow?: LayoutOverflow
  margin?: Edges
  padding?: Edges
  border?: Edges
  gap?: Partial<Record<LayoutGutter, number>>
  text?: number
  shape?: Shape
  kids?: Spec[]
}
type Built = { path: string; node: LayoutNode; parent: Built | null; kids: Built[]; cells: { value: number } | null }
type Scene = { name: string; tree: Spec; run?: (stage: Stage) => void; detail?: Detail }
type Tally = { layouts: number; visited: number; measured: number; hits: number }

const EDGES: readonly LayoutEdge[] = ['all', 'horizontal', 'vertical', 'left', 'right', 'top', 'bottom', 'start', 'end']
const SIDES: readonly LayoutEdge[] = ['left', 'right', 'top', 'bottom']
const DIRECTIONS: readonly LayoutFlexDirection[] = ['row', 'column', 'row-reverse', 'column-reverse']
const JUSTIFIES: readonly LayoutJustify[] = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']
const ALIGNS: readonly LayoutAlign[] = ['auto', 'stretch', 'flex-start', 'center', 'flex-end']
const WRAPS: readonly LayoutWrap[] = ['nowrap', 'wrap', 'wrap-reverse']
const OVERFLOWS: readonly LayoutOverflow[] = ['visible', 'hidden', 'scroll']
const GUTTERS: readonly LayoutGutter[] = ['all', 'column', 'row']

const num = (n: number): string => (Object.is(n, -0) ? '-0' : String(n))
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 10)
const percentOf = (measure: Measure | 'auto'): number => Number.parseFloat(measure as string)
const rectOf = (node: LayoutNode): string => `${num(node.getComputedLeft())},${num(node.getComputedTop())},${num(node.getComputedWidth())},${num(node.getComputedHeight())}`
const countersOf = (c: Counters): string => `visited ${c.visited} measured ${c.measured} hits ${c.cacheHits} live ${c.live}`

let traceRead = 0
function traced(engine: Engine): string[] {
  if (!existsSync(engine.trace)) return []
  const size = statSync(engine.trace).size
  if (size <= traceRead) return []
  const bytes = Buffer.alloc(size - traceRead)
  const file = openSync(engine.trace, 'r')
  try {
    readSync(file, bytes, 0, bytes.length, traceRead)
  } finally {
    closeSync(file)
  }
  traceRead = size
  return bytes.toString('utf8').split('\n').filter(line => line !== '')
}

function counted(tally: Tally, c: Counters): void {
  tally.layouts++
  tally.visited += c.visited
  tally.measured += c.measured
  tally.hits += c.cacheHits
}

function sealed(name: string, lines: string[], detail: Detail, engine: Engine, tally: Tally, more = ''): string[] {
  if (detail !== 'sealed' || engine.open === name) return lines
  return [`sealed: ${tally.layouts} layouts · visited ${tally.visited} measured ${tally.measured} hits ${tally.hits}${more} · ${lines.length} lines ${digest(lines.join('\n'))}`]
}

function measureOf(shape: Shape, cells: { value: number }): (width: number, mode: LayoutMeasureMode) => { width: number; height: number } {
  return (width, mode) => {
    const n = cells.value
    if (shape === 'block') return { width: n, height: 2 }
    if (shape === 'half') return { width: n + 0.5, height: 1.5 }
    if (shape === 'void') return { width: Number.NaN, height: Number.NaN }
    if (mode === 'undefined' || !Number.isFinite(width) || width <= 0) return { width: n, height: n === 0 ? 0 : 1 }
    const w = Math.max(1, Math.floor(width))
    if (mode === 'exactly') return { width: w, height: Math.max(1, Math.ceil(n / w)) }
    if (n <= w) return { width: n, height: n === 0 ? 0 : 1 }
    return { width: w, height: Math.ceil(n / w) }
  }
}

function dress(node: LayoutNode, s: Spec): void {
  const sized = (value: Measure | 'auto' | undefined, exact: (v: number) => void, share: (v: number) => void, auto?: () => void): void => {
    if (value === undefined) return
    if (value === 'auto') auto?.()
    else if (typeof value === 'string') share(percentOf(value))
    else exact(value)
  }
  sized(s.width, v => node.setWidth(v), v => node.setWidthPercent(v), () => node.setWidthAuto())
  sized(s.height, v => node.setHeight(v), v => node.setHeightPercent(v), () => node.setHeightAuto())
  sized(s.minWidth, v => node.setMinWidth(v), v => node.setMinWidthPercent(v))
  sized(s.minHeight, v => node.setMinHeight(v), v => node.setMinHeightPercent(v))
  sized(s.maxWidth, v => node.setMaxWidth(v), v => node.setMaxWidthPercent(v))
  sized(s.maxHeight, v => node.setMaxHeight(v), v => node.setMaxHeightPercent(v))
  if (s.direction !== undefined) node.setFlexDirection(s.direction)
  if (s.grow !== undefined) node.setFlexGrow(s.grow)
  if (s.shrink !== undefined) node.setFlexShrink(s.shrink)
  sized(s.basis, v => node.setFlexBasis(v), v => node.setFlexBasisPercent(v))
  if (s.wrap !== undefined) node.setFlexWrap(s.wrap)
  if (s.items !== undefined) node.setAlignItems(s.items)
  if (s.self !== undefined) node.setAlignSelf(s.self)
  if (s.justify !== undefined) node.setJustifyContent(s.justify)
  if (s.display !== undefined) node.setDisplay(s.display)
  if (s.place !== undefined) node.setPositionType(s.place)
  for (const [edge, value] of Object.entries(s.inset ?? {}) as Array<[LayoutEdge, Measure]>) {
    if (typeof value === 'string') node.setPositionPercent(edge, percentOf(value))
    else node.setPosition(edge, value)
  }
  if (s.overflow !== undefined) node.setOverflow(s.overflow)
  for (const [edge, value] of Object.entries(s.margin ?? {}) as Array<[LayoutEdge, number]>) node.setMargin(edge, value)
  for (const [edge, value] of Object.entries(s.padding ?? {}) as Array<[LayoutEdge, number]>) node.setPadding(edge, value)
  for (const [edge, value] of Object.entries(s.border ?? {}) as Array<[LayoutEdge, number]>) node.setBorder(edge, value)
  for (const [gutter, value] of Object.entries(s.gap ?? {}) as Array<[LayoutGutter, number]>) node.setGap(gutter, value)
}

class Stage {
  readonly lines: string[] = []
  readonly tally: Tally = { layouts: 0, visited: 0, measured: 0, hits: 0 }
  private readonly all: Built[] = []
  private readonly byPath = new Map<string, Built>()
  private readonly asks: string[] = []
  private added = 0
  private said = ''

  constructor(
    private readonly engine: Engine,
    private readonly detail: Detail,
  ) {}

  build(spec: Spec, path: string, parent: Built | null): Built {
    const node = this.engine.create()
    const built: Built = { path, node, parent, kids: [], cells: null }
    this.all.push(built)
    this.byPath.set(path, built)
    dress(node, spec)
    if (spec.text !== undefined) {
      built.cells = { value: spec.text }
      const answer = measureOf(spec.shape ?? 'wrap', built.cells)
      node.setMeasureFunc((width, mode) => {
        this.asks.push(`${path}(${num(width)}|${mode})`)
        return answer(width, mode)
      })
    }
    ;(spec.kids ?? []).forEach((kid, at) => {
      const child = this.build(kid, `${path}.${at}`, built)
      built.kids.push(child)
      node.insertChild(child.node, at)
    })
    return built
  }

  private at(path: string): Built {
    const built = this.byPath.get(path)
    if (built === undefined) throw new Error(`no node at ${path}`)
    return built
  }

  node(path: string): LayoutNode {
    return this.at(path).node
  }

  paths(): string[] {
    return this.all.map(built => built.path)
  }

  texts(): string[] {
    return this.all.filter(built => built.cells !== null).map(built => built.path)
  }

  note(line: string): void {
    if (this.detail === 'rects') this.lines.push(line)
    else this.said = this.said === '' ? line : `${this.said}; ${line}`
  }

  private rects(): string {
    return this.all.map(({ path, node }) => `${path}=${rectOf(node)}`).join(' ')
  }

  read(label: string): void {
    this.lines.push(`read ${label}: ${this.rects()}`)
  }

  layout(width?: number, height?: number, at = 'r'): void {
    this.asks.length = 0
    this.node(at).calculateLayout(width, height)
    counted(this.tally, this.engine.counters())
    const head = `layout ${at} ${width === undefined ? '-' : num(width)} ${height === undefined ? '-' : num(height)}: ${countersOf(this.engine.counters())}`
    const rects = this.rects()
    const asks = this.asks.join(' ')
    if (this.detail === 'rects') {
      this.lines.push(head, `  rects ${rects}`)
      if (this.asks.length > 0) this.lines.push(`  asks ${asks}`)
    } else {
      this.lines.push(`${this.said === '' ? '' : `${this.said} · `}${head} · rects ${digest(rects)} · asks ${this.asks.length} ${digest(asks)}`)
      this.said = ''
    }
    for (const line of traced(this.engine)) this.lines.push(`  trace ${line}`)
  }

  facts(path: string): void {
    const { node } = this.at(path)
    const parent = node.getParent()
    const owner = parent === null ? 'none' : (this.all.find(built => built.node === parent)?.path ?? 'unlisted')
    const sides = (read: (edge: LayoutEdge) => number): string => EDGES.map(edge => `${edge}:${num(read(edge))}`).join(' ')
    this.lines.push(
      `facts ${path}: parent ${owner} kids ${node.getChildCount()} display ${node.getDisplay()}`,
      `  border ${sides(edge => node.getComputedBorder(edge))}`,
      `  padding ${sides(edge => node.getComputedPadding(edge))}`,
    )
  }

  retext(path: string, cells: number): void {
    const built = this.at(path)
    if (built.cells === null) throw new Error(`${path} measures no text`)
    built.cells.value = cells
    built.node.markDirty()
  }

  add(parent: string, index: number, spec: Spec): string {
    const owner = this.at(parent)
    const path = `${parent}+${this.added++}`
    const built = this.build(spec, path, owner)
    owner.kids.push(built)
    owner.node.insertChild(built.node, index)
    return path
  }

  detach(path: string): void {
    const built = this.at(path)
    if (built.parent === null) return
    built.parent.node.removeChild(built.node)
    built.parent.kids.splice(built.parent.kids.indexOf(built), 1)
    built.parent = null
  }

  attach(path: string, parent: string, index: number): void {
    const built = this.at(path)
    const owner = this.at(parent)
    owner.kids.push(built)
    built.parent = owner
    owner.node.insertChild(built.node, index)
  }

  within(path: string, inside: string): boolean {
    for (let cur: Built | null = this.at(path); cur !== null; cur = cur.parent) if (cur.path === inside) return true
    return false
  }

  private forget(built: Built): void {
    for (const kid of [...built.kids]) this.forget(kid)
    this.all.splice(this.all.indexOf(built), 1)
    this.byPath.delete(built.path)
  }

  drop(path: string): void {
    const built = this.at(path)
    if (built.parent !== null) built.parent.kids.splice(built.parent.kids.indexOf(built), 1)
    built.node.freeRecursive()
    this.forget(built)
  }

  free(path: string): void {
    this.node(path).free()
    this.lines.push(`freed ${path}: live ${this.engine.counters().live}`)
  }

  close(): void {
    for (const built of [...this.all].reverse()) built.node.free()
    this.all.length = 0
    this.byPath.clear()
    this.lines.push(`closed: live ${this.engine.counters().live}`)
  }
}

const box = (spec: Spec, ...kids: Spec[]): Spec => (kids.length > 0 ? { ...spec, kids } : spec)
const row = (spec: Spec, ...kids: Spec[]): Spec => box({ direction: 'row', ...spec }, ...kids)
const column = (spec: Spec, ...kids: Spec[]): Spec => box({ direction: 'column', ...spec }, ...kids)
const cell = (width: number, height: number, more: Spec = {}): Spec => ({ width, height, ...more })
const text = (cells: number, more: Spec = {}): Spec => ({ text: cells, ...more })
const absolute = (inset: Spec['inset'], more: Spec = {}): Spec => ({ place: 'absolute', inset, ...more })
const cells = (count: number, width: number, height: number): Spec[] => Array.from({ length: count }, () => cell(width, height))

function directionScenes(): Scene[] {
  const scenes: Scene[] = []
  for (const direction of DIRECTIONS)
    for (const justify of JUSTIFIES)
      scenes.push({
        name: `direction ${direction}, justify ${justify}`,
        tree: box({ width: 41, height: 13, direction, justify }, cell(6, 2), cell(9, 3), cell(4, 1)),
        run: stage => {
          stage.layout(80)
          stage.node('r').setGap('all', 2)
          stage.layout(80)
        },
      })
  for (const items of ALIGNS)
    for (const direction of ['row', 'column'] as const)
      scenes.push({
        name: `align-items ${items} in a ${direction}`,
        tree: box(
          { width: 31, height: 11, direction, items },
          cell(5, 2),
          cell(5, 4, { self: 'flex-end' }),
          direction === 'row' ? { width: 5 } : { height: 2 },
          cell(4, 3, { self: 'center' }),
          cell(3, 3, { self: 'stretch' }),
          cell(2, 2, { self: 'flex-start' }),
          text(7, { self: 'auto' }),
        ),
      })
  for (const justify of JUSTIFIES)
    scenes.push({
      name: `justify ${justify} with one child, none, and too many`,
      tree: column(
        { width: 20 },
        row({ height: 3, justify }, cell(7, 1)),
        row({ height: 3, justify }),
        row({ height: 3, justify }, cell(9, 1), cell(9, 1), cell(9, 1)),
        column({ height: 7, justify }, cell(3, 4), cell(3, 4)),
      ),
    })
  return scenes
}

function flexScenes(): Scene[] {
  return [
    { name: 'grow shares the free cells', tree: row({ width: 61, height: 4 }, { grow: 1, height: 2 }, { grow: 2, height: 2 }, { grow: 1, width: 10, height: 2 }) },
    { name: 'grow below one keeps part of the free cells', tree: row({ width: 40, height: 2 }, { grow: 0.25, height: 1 }, { grow: 0.5, height: 1 }, cell(4, 1)) },
    { name: 'grow stopped by a maximum freezes and hands the rest on', tree: row({ width: 60, height: 2 }, { grow: 1, maxWidth: 10 }, { grow: 1 }, { grow: 2, maxWidth: 12 }, { grow: 1, minWidth: 30 }) },
    { name: 'shrink in proportion to the basis', tree: row({ width: 30, height: 4 }, cell(20, 2, { shrink: 1 }), cell(20, 2, { shrink: 3 }), cell(10, 2, { shrink: 0 })) },
    { name: 'shrink below one keeps part of the overflow', tree: row({ width: 20, height: 2 }, cell(20, 1, { shrink: 0.25 }), cell(20, 1, { shrink: 0.5 })) },
    { name: 'shrink stopped by a minimum freezes and hands the rest on', tree: row({ width: 30, height: 2 }, cell(20, 1, { shrink: 1, minWidth: 18 }), cell(20, 1, { shrink: 1 }), cell(20, 1, { shrink: 2, minWidth: 5 })) },
    { name: 'shrink with a zero basis among the shrinking', tree: row({ width: 10, height: 2 }, { shrink: 1, basis: 0 }, cell(30, 1, { shrink: 1 }), text(40, { shrink: 1 })) },
    { name: 'basis in cells, in percent, negative and unset', tree: row({ width: 50, height: 4 }, { basis: 10, grow: 1, height: 2 }, { basis: '20%', grow: 1, height: 2 }, { basis: -5, height: 2, width: 9 }, { basis: Number.NaN, width: 8, height: 2 }) },
    { name: 'basis in percent of a main size nobody gave', tree: row({ height: 4 }, { basis: '50%', width: 7 }, { basis: '50%' }, text(11, { basis: '10%' })), run: stage => stage.layout(undefined) },
    { name: 'basis beats width in a row and height in a column', tree: column({ width: 30, height: 20 }, row({ height: 3 }, cell(10, 1, { basis: 4 }), cell(10, 1)), cell(5, 6, { basis: 2 }), cell(5, 6)) },
    { name: 'grow and shrink in a column', tree: column({ width: 20, height: 20 }, { grow: 1 }, cell(4, 6, { shrink: 1 }), { grow: 3, minHeight: 2 }, cell(4, 30, { shrink: 2 })) },
    { name: 'a column whose height nobody gave, held by a minimum and a maximum', tree: column({ width: 20 }, column({ minHeight: 10 }, { grow: 1 }, cell(3, 2)), column({ maxHeight: 4 }, cell(3, 3, { shrink: 1 }), cell(3, 3, { shrink: 1 })), row({ minWidth: 30 }, { grow: 1, height: 1 }, cell(3, 1))) },
    { name: 'a row whose width nobody gave, held by a maximum and a minimum', tree: column({ items: 'flex-start' }, row({ maxWidth: 12 }, cell(8, 1, { shrink: 1 }), cell(8, 1, { shrink: 1 })), row({ minWidth: 40 }, cell(8, 1, { grow: 1 }), cell(8, 1)), row({ maxWidth: 12, padding: { all: 1 }, border: { all: 1 } }, cell(8, 1, { shrink: 1 }), text(20, { shrink: 1 })), row({ maxWidth: '50%', minWidth: '10%' }, cell(8, 1, { shrink: 1 }))), run: stage => { stage.layout(undefined); stage.layout(30) } },
    { name: 'every child frozen at once', tree: row({ width: 30, height: 2 }, cell(5, 1), cell(5, 1), cell(5, 1)) },
    { name: 'violations of both signs in one round', tree: row({ width: 40, height: 2 }, { grow: 1, minWidth: 25 }, { grow: 1, maxWidth: 5 }, { grow: 1 }, { grow: 1, maxWidth: 3 }) },
    { name: 'a round that freezes nothing though a child was clamped', tree: row({ width: 40, height: 2 }, { grow: 1, minWidth: 30 }, { grow: 1, maxWidth: 3 }, { grow: 1, maxWidth: 3 }) },
    { name: 'grow below one beside a child its minimum already widened', tree: row({ width: 40, height: 2 }, cell(10, 1, { minWidth: 30 }), { grow: 0.5, height: 1 }, { grow: 0.25, height: 1 }) },
    { name: 'a basis of no number among the shrinking', tree: row({ width: 40, height: 2 }, cell(10, 1, { shrink: 1 }), { basis: 'none%' as Measure, shrink: 1, height: 1 }, cell(50, 1, { shrink: 1 })) },
    { name: 'an overflow a maximum already took, beside a child that grows by half', tree: row({ width: 20, height: 2 }, cell(30, 1, { maxWidth: 16 }), cell(4, 1, { grow: 0.5, shrink: 1 })) },
    { name: 'free cells a minimum already took, beside a child that shrinks by half', tree: row({ width: 40, height: 2 }, cell(10, 1, { minWidth: 30 }), cell(10, 1, { grow: 1, shrink: 0.5 })) },
    { name: 'half a free cell left by a minimum', tree: row({ width: 40, height: 2 }, cell(10, 1, { minWidth: 29.5 }), cell(10, 1, { grow: 1, shrink: 0.9 })) },
    { name: 'three quarters of a cell left by a maximum among the shrinking', tree: row({ width: 20, height: 2 }, cell(30, 1, { maxWidth: 9.25 }), cell(10, 1, { shrink: 1 })) },
    { name: 'violations of both signs that sum to half a cell', tree: row({ width: 10, height: 2 }, { basis: 0, grow: 1, minWidth: 5.75, height: 1 }, { basis: 0, grow: 1, maxWidth: 4.75, height: 1 }) },
    { name: 'a basis and a width below zero on children that grow', tree: column({ width: 50 }, row({ height: 2 }, { basis: -5, grow: 1, height: 1 }, { basis: 10, grow: 1, height: 1 }), row({ height: 2 }, { width: -5, grow: 1, height: 1 }, { width: 10, grow: 1, height: 1 })) },
    { name: 'a row whose width nobody gave, held by a maximum and a minimum, padded on one side', tree: column({ items: 'flex-start' }, row({ maxWidth: 12, padding: { left: 3 } }, cell(5, 1, { shrink: 1 }), cell(5, 1, { shrink: 1 })), row({ maxWidth: 2, padding: { left: 3 } }, cell(5, 1, { shrink: 1 }), cell(5, 1, { shrink: 1 })), row({ minWidth: 40, padding: { left: 3 } }, cell(19, 1, { shrink: 1 }), cell(19, 1, { shrink: 1 })), row({ minWidth: 40, padding: { left: 3 } }, cell(8, 1, { grow: 1 }), cell(8, 1)), row({ minWidth: 3, padding: { left: 3 } }, cell(2, 1, { grow: 1, margin: { left: -5 } }))), run: stage => stage.layout(undefined) },
    { name: 'grow and shrink of zero among the flexible', tree: row({ width: 40, height: 2 }, cell(10, 1, { grow: 0, shrink: 0 }), cell(10, 1, { grow: 1, shrink: 0 }), cell(50, 1, { grow: 0, shrink: 1 })) },
  ]
}

function boundScenes(): Scene[] {
  return [
    { name: 'minimum and maximum in cells and percent', tree: row({ width: 64, height: 16 }, { width: '50%', maxWidth: 20, height: 4 }, { width: 4, minWidth: 10, height: '50%' }, { width: '25%', minWidth: '30%', height: 4 }, { grow: 1, maxHeight: 2, minHeight: 1 }, { width: 3, maxWidth: '2%', height: 1 }) },
    { name: 'a minimum above a maximum wins', tree: row({ width: 30, height: 10 }, { width: 10, minWidth: 12, maxWidth: 6, height: 2, minHeight: 5, maxHeight: 3 }, { grow: 1, minWidth: 40, maxWidth: 10 }) },
    { name: 'the root held by its own minimum and maximum', tree: column({ minWidth: 20, maxWidth: 30, minHeight: 3, maxHeight: 5 }, text(100)), run: stage => { stage.layout(undefined); stage.layout(10); stage.layout(25); stage.layout(80) } },
    { name: 'percent of a parent whose size nobody gave', tree: column({}, { width: '50%', height: '50%' }, row({}, { width: '50%', height: 2 }, text(9))), run: stage => { stage.layout(undefined); stage.layout(40) } },
    { name: 'maximum height on a column of text, as the alternate screen sets it', tree: column({ width: 20 }, text(90), text(90), text(90)), run: stage => { stage.layout(20); stage.node('r').setMaxHeight(8); stage.layout(20); stage.node('r').setMaxHeight(Number.NaN); stage.layout(20) } },
    { name: 'sizes that are no number fall back to auto', tree: row({ width: 30, height: 6 }, { width: Number.NaN, height: Number.POSITIVE_INFINITY, grow: 1 }, { width: Number.NEGATIVE_INFINITY, minWidth: Number.NaN, maxWidth: Number.POSITIVE_INFINITY, height: 2 }, { width: 5, height: 2, minHeight: Number.NaN, maxHeight: Number.NaN, basis: Number.POSITIVE_INFINITY }), run: stage => { stage.layout(30); stage.node('r.2').setWidthAuto(); stage.node('r.2').setHeightAuto(); stage.layout(30) } },
    { name: 'negative and fractional sizes', tree: row({ width: 20.5, height: 6.25 }, cell(-4, 2), cell(3.5, 1.75), cell(2.4999, 1.5001), { grow: 1, height: 0.9999 }, { grow: 1, height: 0.00005 }, text(5, { width: 2.5 })) },
    { name: 'a width given to the layout and none', tree: row({}, text(12), cell(4, 2)), run: stage => { stage.layout(undefined); stage.layout(40); stage.layout(undefined); stage.layout(Number.NaN); stage.layout(-3); stage.layout(0); stage.layout(7.5, 99) } },
  ]
}

function boxScenes(): Scene[] {
  const everyFact = (stage: Stage, width: number): void => {
    stage.layout(width)
    for (const path of stage.paths()) stage.facts(path)
  }
  const scenes: Scene[] = [
    { name: 'padding, border, gap and margins by edge', tree: column({ width: 40, height: 14, padding: { all: 1 }, border: { all: 1 }, gap: { all: 1 } }, { height: 2, margin: { left: 2, right: 1 } }, { height: 2, margin: { start: 3 } }, { height: 2, margin: { horizontal: 2, vertical: 1 } }, { height: 1, margin: { end: 4, top: 1 } }, { height: 1, margin: { all: 1, left: 5 } }), run: stage => everyFact(stage, 80) },
    { name: 'every edge word on padding and border, read back by every edge word', tree: row({ width: 50 }, ...EDGES.map(edge => box({ padding: { [edge]: 2 }, border: { [edge]: 1 } }, cell(3, 1)))), run: stage => everyFact(stage, 50) },
    { name: 'every edge word on a margin, in a row and in a column', tree: column({ width: 60 }, row({}, ...EDGES.map(edge => cell(3, 1, { margin: { [edge]: 2 } }))), column({}, ...EDGES.map(edge => cell(3, 1, { margin: { [edge]: 1 } })))) },
    { name: 'edge words that outrank each other', tree: row({ width: 50 }, box({ padding: { all: 1, horizontal: 2, left: 3, start: 4 }, border: { all: 1, vertical: 0, end: 2, right: 3 }, margin: { all: 1, horizontal: 2, start: 5, end: 6 } }, cell(3, 1)), box({ padding: { vertical: 2, top: 0 }, margin: { vertical: 1, bottom: 3, left: 0 } }, cell(3, 1))), run: stage => everyFact(stage, 50) },
    { name: 'gaps by gutter in a wrapping row and a wrapping column', tree: row({ width: 60 }, row({ width: 30, height: 12, wrap: 'wrap', gap: { column: 2, row: 1 } }, ...cells(6, 8, 2)), column({ width: 30, height: 7, wrap: 'wrap', gap: { column: 2, row: 1 } }, ...cells(6, 8, 2))) },
    { name: 'a gap of all under a gap by gutter', tree: column({ width: 40 }, row({ gap: { all: 3 } }, cell(4, 1), cell(4, 1)), row({ gap: { all: 3, column: 1 } }, cell(4, 1), cell(4, 1)), column({ gap: { all: 3, row: 0 } }, cell(4, 1), cell(4, 1)), column({ gap: { column: 5 } }, cell(4, 1), cell(4, 1))) },
    { name: 'a gap of all under the gutter between wrapped lines', tree: column({ width: 40 }, row({ width: 10, wrap: 'wrap', gap: { all: 3, row: 1 } }, ...cells(3, 6, 1)), column({ height: 4, wrap: 'wrap', gap: { all: 3, column: 1 } }, ...cells(3, 2, 3))) },
    { name: 'a wrap at the very edge of its tolerance', tree: row({ width: 20, wrap: 'wrap' }, cell(10, 1), cell(20 + 1e-9 - 10, 1)) },
    { name: 'a wrap decided by five billionths of a cell', tree: row({ width: 20, wrap: 'wrap' }, cell(10, 1), cell(10.000000005, 1)) },
    { name: 'padding and border larger than the box', tree: row({ width: 6, height: 3, padding: { all: 3 }, border: { all: 2 } }, cell(4, 2), text(9)) },
    { name: 'a leaf with nothing but padding and border', tree: row({ width: 30 }, { padding: { all: 2 }, border: { all: 1 } }, { padding: { left: 3 }, minWidth: 10 }, { border: { top: 1 }, height: 4, width: 2 }, text(6, { padding: { all: 1 }, border: { all: 1 } })) },
    { name: 'margins on the root', tree: box({ width: 20, height: 4, margin: { left: 3, top: 2, right: 1, bottom: 1 } }, cell(5, 1, { margin: { all: 1 } })) },
    { name: 'negative margins and gaps', tree: row({ width: 30, height: 6, gap: { all: -1 } }, cell(8, 2, { margin: { left: -2 } }), cell(8, 2, { margin: { top: -1, right: -3 } }), cell(8, 2)) },
  ]
  for (const wrap of WRAPS)
    for (const direction of DIRECTIONS)
      scenes.push({
        name: `wrap ${wrap} in ${direction}`,
        tree: box({ width: 21, height: 13, direction, wrap, items: direction.startsWith('row') ? 'stretch' : 'flex-start' }, ...Array.from({ length: 5 }, (_, at) => cell(7, 2 + (at % 2), at === 3 ? { self: 'center' } : at === 4 ? { self: 'flex-end' } : {}))),
      })
  scenes.push(
    { name: 'wrap whose lines stretch their children', tree: row({ width: 20, wrap: 'wrap' }, { width: 8 }, cell(8, 3), cell(8, 1), { width: 8 }, text(30, { width: 8 })) },
    { name: 'wrap at a width nobody gave stays on one line', tree: row({ wrap: 'wrap' }, ...cells(3, 30, 1)), run: stage => { stage.layout(undefined); stage.layout(50) } },
    { name: 'wrap that measures as wide as it may when it breaks', tree: column({ width: 40, items: 'flex-start' }, row({ wrap: 'wrap' }, ...cells(3, 15, 1)), row({ wrap: 'wrap' }, ...cells(2, 15, 1))) },
    { name: 'wrap with gaps that decide the break', tree: row({ width: 20, wrap: 'wrap', gap: { column: 2 } }, cell(9, 1), cell(9, 1), cell(9, 1), cell(20, 1), cell(21, 1), cell(1, 1)) },
    { name: 'wrap whose children grow and shrink line by line', tree: row({ width: 20, wrap: 'wrap' }, cell(12, 1, { grow: 1 }), cell(12, 1, { grow: 1 }), cell(30, 1, { shrink: 1 }), cell(5, 1), cell(5, 1, { grow: 2 }), cell(40, 2)) },
    { name: 'wrap with margins and a minimum that widen a child', tree: row({ width: 20, wrap: 'wrap' }, cell(6, 1, { margin: { horizontal: 2 } }), cell(6, 1, { minWidth: 9 }), cell(6, 1, { maxWidth: 2 }), cell(6, 1), cell(6, 1)) },
  )
  return scenes
}

function placedScenes(): Scene[] {
  return [
    { name: 'absolute by left and top, right and bottom, percent', tree: column({ width: 40, height: 10 }, { height: 3 }, absolute({ left: 5, top: 2 }, { width: 10, height: 2 }), absolute({ right: 1, bottom: 1 }, { width: 8, height: 2 }), absolute({ left: '50%', top: '25%' }, { width: 6, height: 2 }), absolute({ right: '10%', bottom: '10%' }, { width: '25%', height: '50%' }), { height: 3 }) },
    { name: 'absolute stretched between two insets', tree: box({ width: 40, height: 10, border: { all: 1 }, padding: { all: 2 } }, absolute({ left: 2, right: 3 }, { height: 1 }), absolute({ top: 1, bottom: 2 }, { width: 4 }), absolute({ left: 1, right: 1, top: 1, bottom: 1 }), absolute({ left: 30, right: 30 }, { height: 1, margin: { all: 1 } }), absolute({ top: 4, bottom: 4, left: 0 }, { minHeight: 5, maxWidth: 3, width: 9 })) },
    { name: 'absolute with no inset sits at the padding corner', tree: box({ width: 30, height: 8, border: { all: 1 }, padding: { left: 2, top: 1 } }, cell(4, 1), absolute({}, { width: 5, height: 2, margin: { left: 1, top: 1 } }), absolute({}, {}), absolute({}, { text: 12 })) },
    { name: 'absolute by the words start, end, horizontal, vertical and all', tree: box({ width: 40, height: 12 }, absolute({ start: 3, vertical: 2 }, { width: 4, height: 1 }), absolute({ end: 3, top: 0 }, { width: 4, height: 1 }), absolute({ horizontal: 5, vertical: 1 }), absolute({ all: 2 }), absolute({ all: '10%' }, { width: 3 })) },
    { name: 'absolute measured text and a tree inside it', tree: box({ width: 30, height: 9 }, absolute({ right: 0, top: 0 }, { text: 14 }), absolute({ left: 2, bottom: 0 }, { text: 50, width: 12 }), absolute({ left: 0, top: 3 }, row({}, text(5), cell(3, 1), { grow: 1 })), absolute({ left: 1, right: 1, top: 5 }, row({}, text(40), { grow: 1 }))) },
    { name: 'absolute held by minimum and maximum', tree: box({ width: 30, height: 9 }, absolute({ left: 0, top: 0 }, { width: 40, maxWidth: 10, height: 1, minHeight: 3 }), absolute({ left: 0, right: 0 }, { maxWidth: '50%', height: 1 }), absolute({ top: 0, bottom: 0 }, { maxHeight: '50%', width: 1 })) },
    { name: 'absolute by right and bottom with margins and a border', tree: box({ width: 30, height: 9, border: { all: 1 }, padding: { all: 1 } }, absolute({ right: 2, bottom: 1 }, { width: 4, height: 2, margin: { right: 1, bottom: 1, left: 3, top: 3 } }), absolute({ right: 0 }, { text: 8 }), absolute({ bottom: 0 }, { text: 8 })) },
    { name: 'relative insets move a child and leave its neighbours', tree: row({ width: 30, height: 9 }, cell(5, 2, { inset: { left: 2, top: 1 } }), cell(5, 2, { inset: { right: 2, bottom: 1 } }), cell(5, 2, { inset: { left: 1, right: 9, top: 1, bottom: 9 } }), cell(5, 2, { inset: { left: '10%', top: '50%' } }), cell(5, 2, { inset: { all: 1 } }), cell(4, 1, { place: 'relative' })) },
    { name: 'relative insets in a column, by start and end', tree: column({ width: 30, height: 12 }, cell(5, 2, { inset: { start: 2 } }), cell(5, 2, { inset: { end: 2 } }), cell(5, 2, { inset: { horizontal: 3, vertical: 1 } }), cell(5, 2, { inset: { right: '10%', bottom: '25%' } })) },
    { name: 'an inset that is no number, as an unset edge arrives', tree: row({ width: 30, height: 9 }, cell(5, 2, { inset: { left: Number.NaN } }), cell(5, 2), absolute({ top: Number.NaN, left: 3 }, { width: 2, height: 2 })) },
    { name: 'absolute inside absolute inside a scrolling box', tree: box({ width: 30, height: 9, overflow: 'scroll' }, cell(10, 20), absolute({ left: 1, top: 1 }, box({ width: 20, height: 6 }, absolute({ right: 0, bottom: 0 }, { width: 3, height: 3 }), cell(30, 30)))) },
    { name: 'an absolute child is no part of the flow in a row, a column and a wrap', tree: column({ width: 30 }, row({ justify: 'space-between' }, cell(4, 1), absolute({ left: 9, top: 0 }, { width: 2, height: 1 }), cell(4, 1)), row({ wrap: 'wrap' }, cell(20, 1), absolute({}, { width: 20, height: 5 }), cell(20, 1))) },
    { name: 'display none in the flow, among absolutes, and with a subtree', tree: row({ width: 30, height: 6 }, cell(8, 2), cell(8, 2, { display: 'none' }), cell(8, 2), absolute({ left: 0, top: 0 }, { width: 3, height: 3, display: 'none' }), column({ display: 'none' }, text(10), box(cell(4, 4), cell(1, 1)))), run: stage => { stage.read('before any layout'); stage.layout(80); stage.node('r.1').setDisplay('flex'); stage.node('r.0').setDisplay('none'); stage.read('hidden before the next layout'); stage.layout(80); stage.node('r.4').setDisplay('flex'); stage.layout(80); stage.node('r.4').setDisplay('none'); stage.read('a subtree hidden'); stage.layout(80); stage.node('r').setDisplay('none'); stage.layout(80); stage.node('r').setDisplay('flex'); stage.layout(80) } },
    { name: 'overflow hidden and scroll hold their own size', tree: column({ width: 24, height: 9 }, box({ height: 3, overflow: 'hidden' }, cell(10, 8)), box({ height: 3, overflow: 'scroll' }, cell(10, 8)), box({ overflow: 'scroll', grow: 1 }, cell(40, 8))) },
    { name: 'a scrolling box measured at most', tree: row({ width: 24, height: 9, items: 'flex-start' }, column({ overflow: 'scroll' }, cell(40, 20)), row({ overflow: 'scroll', padding: { all: 1 } }, cell(40, 20)), column({ overflow: 'hidden' }, cell(40, 20)), column({ overflow: 'scroll' }, cell(2, 2)), row({ overflow: 'scroll', padding: { all: 6 } })) },
    { name: 'a scrolling box given less than its own padding on one side', tree: row({ width: 20, height: 4, items: 'flex-start' }, column({ overflow: 'scroll', padding: { top: 6 } }, cell(1, 1)), row({ overflow: 'scroll', padding: { top: 6 } }, cell(1, 1))) },
    { name: 'children put under a hidden root, one new and one laid out before, then laid out', tree: column({ width: 10 }, cell(5, 2), cell(3, 1)), run: stage => { stage.layout(10); stage.detach('r.1'); stage.node('r').setDisplay('none'); stage.add('r', 1, cell(4, 2)); stage.attach('r.1', 'r', 2); stage.read('under a hidden root, before its layout'); stage.layout(10); stage.node('r').setDisplay('flex'); stage.layout(10) } },
    { name: 'a scrolling column as tall as it may be, as the transcript is', tree: column({ width: 40, height: 12 }, text(30), column({ grow: 1, shrink: 1, overflow: 'scroll' }, column({ shrink: 0 }, text(200), text(300), cell(10, 4))), cell(40, 2)), run: stage => { stage.layout(40); stage.retext('r.1.0.0', 500); stage.layout(40); stage.layout(40); stage.node('r').setWidth(30); stage.layout(30) } },
  ]
}

function textScenes(): Scene[] {
  return [
    { name: 'text alone at its own width', tree: column({}, text(12), text(45), text(3), text(0)), run: stage => { stage.layout(undefined); stage.layout(80); stage.layout(20); stage.layout(1) } },
    { name: 'text wrapping in a narrow column', tree: column({ width: 10 }, text(34), text(8), text(10), text(11)) },
    { name: 'text in a row beside a growing box', tree: row({ width: 40 }, text(25), box({ grow: 1 }, text(30))) },
    { name: 'text in a row that must shrink', tree: row({ width: 20 }, text(25, { shrink: 1 }), text(25, { shrink: 1 }), text(4)) },
    { name: 'text in a row that may not shrink', tree: row({ width: 20 }, text(25), text(25)) },
    { name: 'text under every alignment', tree: row({ width: 30, height: 6 }, ...ALIGNS.map(self => text(7, { self })), text(7, { self: 'stretch', height: 2 })) },
    { name: 'text under every alignment in a column', tree: column({ width: 30 }, ...ALIGNS.map(self => text(40, { self })), text(40, { self: 'stretch', width: 12 })) },
    { name: 'text with padding, border and margins', tree: column({ width: 30 }, text(40, { padding: { all: 1 }, border: { all: 1 } }), text(40, { margin: { all: 2 } }), text(40, { padding: { left: 28 } }), text(40, { padding: { horizontal: 20 } })) },
    { name: 'text held by a minimum and a maximum', tree: column({ width: 30, items: 'flex-start' }, text(4, { minWidth: 9, minHeight: 2 }), text(50, { maxWidth: 12, maxHeight: 2 }), text(50, { maxWidth: '50%' }), text(4, { minWidth: '50%' })) },
    { name: 'text of a fixed block, as raw output is', tree: column({ width: 30 }, text(12, { shape: 'block' }), text(50, { shape: 'block' }), row({}, text(12, { shape: 'block' }), text(30, { shape: 'block', shrink: 1 }))) },
    { name: 'text whose measure answers half cells', tree: row({ width: 30 }, text(6, { shape: 'half' }), text(6, { shape: 'half', grow: 1 }), text(3, { shape: 'half', margin: { left: 0.25 } })) },
    { name: 'text whose measure answers no number', tree: row({ width: 30 }, text(6, { shape: 'void' }), cell(4, 1), text(6, { shape: 'void', shrink: 1 }), text(6, { shape: 'void', grow: 1 })) },
    { name: 'text at fractions of a cell', tree: row({ width: 31, height: 5 }, text(40, { grow: 1 }), text(40, { grow: 1 }), text(40, { grow: 1 })), run: stage => { stage.layout(31); stage.node('r').setJustifyContent('center'); stage.node('r.0').setFlexGrow(0); stage.node('r.0').setWidthPercent(33.3); stage.layout(31) } },
    { name: 'boxes at fractions of a cell', tree: row({ width: 10, height: 5, justify: 'space-evenly', items: 'center' }, cell(1, 2), cell(2, 2), cell(2, 2), box({ width: '33.3%', height: '33.3%' }, cell(0.5, 0.5))) },
    { name: 'boxes and text at the edges of a cell', tree: row({ width: 40, height: 4 }, cell(0.4998, 1), cell(0.4999, 1), cell(0.5, 1), cell(1.00005, 1), cell(1.99995, 1), text(3, { width: 2.00005 }), text(3, { width: 2.99995, margin: { left: 0.4999 } }), text(3, { margin: { left: 0.5, top: 0.5 }, height: 1.5 })) },
    { name: 'the thresholds of the grid, each met exactly', tree: column({ width: 40 }, row({}, cell(0.4999, 1), cell(3, 1)), row({}, cell(0.0001, 1), cell(3, 1)), row({}, cell(0.9999, 1), cell(3, 1)), row({}, text(3, { width: 0.0001 }), cell(3, 1)), row({}, text(3, { width: 0.9999 }), cell(3, 1)), row({}, text(3, { width: 3.0005 }), cell(3, 1)), row({}, text(3, { margin: { left: 0.9999 } }), cell(3, 1)), row({}, text(3, { margin: { left: 0.0001 } }), cell(3, 1)), row({}, text(3, { margin: { left: 0.0005 } }), text(3, { margin: { left: 0.9995 } })), column({}, cell(1, 0.4999), cell(1, 3)), column({}, text(3, { height: 0.0001 }), text(3, { height: 0.9999 }), text(3, { height: 3.0005 }), text(3, { margin: { top: 0.9999 } }))) },
    { name: 'a child at the very edge of what a reused layout lets pass', tree: column({ width: 20 }, row({ width: 10, height: 1 }, cell(10 + 1e-6, 1)), row({ width: 10, height: 1 }, cell(4, 1 + 1e-6))), run: stage => { for (const at of ['r.0', 'r.0', 'r.1', 'r.1']) stage.layout(10, undefined, at) } },
    { name: 'a child wider than its parent by five millionths, seen when the layout is reused', tree: row({ width: 10, height: 1 }, cell(10.000005, 1)), run: stage => { stage.layout(10); stage.layout(10) } },
    { name: 'a child taller than its parent by five millionths, seen when the layout is reused', tree: row({ width: 10, height: 1 }, cell(4, 1.000005)), run: stage => { stage.layout(10); stage.layout(10) } },
    { name: 'a measured node that has children is laid out by its children', tree: column({ width: 30 }, text(50, { kids: [cell(4, 2), text(9)] }), text(50)) },
    { name: 'text asked at many widths, kept, and asked again', tree: column({ items: 'flex-start' }, text(23), row({}, text(9), text(31))), run: stage => { for (const width of [80, 60, 40, 30, 23, 22, 12, 30, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 80]) { stage.node('r').setWidth(width); stage.layout(width) } } },
    { name: 'text asked under the word undefined, then at most', tree: row({}, text(23), text(9)), run: stage => { stage.layout(undefined); stage.layout(80); stage.layout(20); stage.layout(undefined) } },
    { name: 'a size measured with no height given, asked again at most its own height', tree: column({ width: 12, height: 10, items: 'flex-start' }, column({}, text(4), cell(4, 9))), run: stage => { stage.layout(12); stage.node('r').setFlexDirection('row'); stage.layout(12) } },
    { name: 'a size measured at most a width, asked again at most the width it took', tree: column({ width: 30, items: 'flex-start' }, column({}, text(23), cell(2, 1))), run: stage => { stage.layout(30); stage.node('r').setPadding('left', 7); stage.layout(30) } },
    { name: 'the same layout asked again costs one visit', tree: column({ width: 40 }, text(100), row({}, text(30), box({ grow: 1 }, text(5)))), run: stage => { stage.layout(40); stage.layout(40); stage.layout(40, 7); stage.layout(41); stage.layout(40) } },
    { name: 'text changed and marked, then put back', tree: column({ width: 40 }, text(10), row({}, text(30), box({ grow: 1 }, text(5)))), run: stage => { stage.layout(40); stage.retext('r.1.0', 55); stage.layout(40); stage.layout(72); stage.retext('r.1.0', 30); stage.layout(40); stage.retext('r.0', 10); stage.layout(40) } },
    { name: 'a measure taken away and given back', tree: column({ width: 30 }, text(50), text(8)), run: stage => { stage.layout(30); stage.node('r.0').unsetMeasureFunc(); stage.layout(30); stage.node('r.0').setMeasureFunc(() => ({ width: 7, height: 3 })); stage.layout(30); stage.node('r.0').setMeasureFunc(() => ({ width: 99, height: 1 })); stage.layout(30); stage.layout(30); const asked = stage.node('r.1'); asked.setMeasureFunc(function (this: unknown) { return { width: this === asked ? 5 : 50, height: 2 } }); stage.note('a measure that answers 5 wide when it is called on its own node'); stage.layout(30) } },
  ]
}

function everySetter(): Array<[string, (node: LayoutNode) => void]> {
  const out: Array<[string, (node: LayoutNode) => void]> = [
    ['width 9', n => n.setWidth(9)], ['width 50%', n => n.setWidthPercent(50)], ['width auto', n => n.setWidthAuto()],
    ['height 4', n => n.setHeight(4)], ['height 50%', n => n.setHeightPercent(50)], ['height auto', n => n.setHeightAuto()],
    ['min-width 12', n => n.setMinWidth(12)], ['min-width 10%', n => n.setMinWidthPercent(10)], ['min-width 0', n => n.setMinWidth(0)],
    ['min-height 3', n => n.setMinHeight(3)], ['min-height 20%', n => n.setMinHeightPercent(20)], ['min-height 0', n => n.setMinHeight(0)],
    ['max-width 7', n => n.setMaxWidth(7)], ['max-width 90%', n => n.setMaxWidthPercent(90)], ['max-width unset', n => n.setMaxWidth(Number.NaN)],
    ['max-height 2', n => n.setMaxHeight(2)], ['max-height 90%', n => n.setMaxHeightPercent(90)], ['max-height unset', n => n.setMaxHeight(Number.NaN)],
    ['grow 1', n => n.setFlexGrow(1)], ['shrink 1', n => n.setFlexShrink(1)], ['basis 11', n => n.setFlexBasis(11)], ['basis 30%', n => n.setFlexBasisPercent(30)], ['basis unset', n => n.setFlexBasis(Number.NaN)],
    ['grow 0', n => n.setFlexGrow(0)], ['shrink 0', n => n.setFlexShrink(0)],
    ['position absolute', n => n.setPositionType('absolute')], ['left 2', n => n.setPosition('left', 2)], ['top 10%', n => n.setPositionPercent('top', 10)], ['left unset', n => n.setPosition('left', Number.NaN)], ['position relative', n => n.setPositionType('relative')],
    ['display none', n => n.setDisplay('none')], ['display flex', n => n.setDisplay('flex')],
  ]
  for (const direction of DIRECTIONS) out.push([`direction ${direction}`, n => n.setFlexDirection(direction)])
  for (const wrap of WRAPS) out.push([`wrap ${wrap}`, n => n.setFlexWrap(wrap)])
  for (const align of ALIGNS) out.push([`align-items ${align}`, n => n.setAlignItems(align)], [`align-self ${align}`, n => n.setAlignSelf(align)])
  for (const justify of JUSTIFIES) out.push([`justify ${justify}`, n => n.setJustifyContent(justify)])
  for (const overflow of OVERFLOWS) out.push([`overflow ${overflow}`, n => n.setOverflow(overflow)])
  for (const edge of EDGES) out.push([`margin ${edge} 1`, n => n.setMargin(edge, 1)], [`padding ${edge} 1`, n => n.setPadding(edge, 1)], [`border ${edge} 1`, n => n.setBorder(edge, 1)], [`inset ${edge} 1`, n => n.setPosition(edge, 1)], [`inset ${edge} 5%`, n => n.setPositionPercent(edge, 5)])
  for (const gutter of GUTTERS) out.push([`gap ${gutter} 1`, n => n.setGap(gutter, 1)])
  return out
}

function treeScenes(): Scene[] {
  const deep = (levels: number, leaf: Spec): Spec => (levels === 0 ? leaf : box({ direction: levels % 2 === 0 ? 'row' : 'column', padding: levels % 3 === 0 ? { all: 1 } : {}, grow: levels % 2 }, deep(levels - 1, leaf), cell(2, 1)))
  const setOnce = (at: string) => (stage: Stage): void => {
    stage.layout(40)
    for (const [label, change] of everySetter()) {
      change(stage.node(at))
      stage.note(`set ${label}`)
      stage.layout(40)
    }
  }
  return [
    { name: 'nothing but a root', tree: {}, run: stage => { stage.read('before any layout'); stage.facts('r'); stage.layout(undefined); stage.layout(80); stage.layout(80, 24) } },
    { name: 'twelve levels deep', tree: column({ width: 60 }, deep(12, text(90))), run: stage => { stage.layout(60); stage.layout(60); stage.node('r').setWidth(44); stage.layout(44); stage.retext(stage.texts()[0]!, 12); stage.layout(44) } },
    { name: 'twenty-four levels deep', tree: deep(24, text(30)), run: stage => { stage.layout(100); stage.layout(100); stage.retext(stage.texts()[0]!, 300); stage.layout(100) }, detail: 'digests' },
    { name: 'three hundred siblings', tree: column({ width: 80 }, ...Array.from({ length: 300 }, (_, at) => (at % 3 === 0 ? text(20 + at) : cell(10 + (at % 7), 1)))), run: stage => { stage.layout(80); stage.layout(80); stage.retext('r.150', 500); stage.layout(80); stage.node('r.7').setHeight(3); stage.layout(80) }, detail: 'digests' },
    { name: 'the cockpit: rails beside a growing column', tree: row({ width: 150, height: 40 }, column({ width: 24, shrink: 0 }, text(20), { grow: 1 }), column({ grow: 1 }, { height: 3, border: { all: 1 } }, box({ grow: 1, padding: { all: 1 } }, text(200)), { height: 5 }), { width: 30, shrink: 0 }), run: stage => { for (const [width, height] of [[150, 40], [100, 40], [80, 24], [150, 40]] as const) { stage.node('r').setWidth(width); stage.node('r').setHeight(height); stage.layout(width, height) } } },
    { name: 'a child put in, moved and taken out', tree: column({ width: 30 }, text(40), row({}, cell(4, 1), cell(5, 1)), cell(6, 2)), run: stage => { stage.layout(30); const added = stage.add('r.1', 1, text(12)); stage.layout(30); stage.add('r', 0, cell(3, 3)); stage.add('r', 99, cell(2, 2)); stage.add('r', -1, cell(1, 1)); stage.layout(30); stage.detach(added); stage.read('a child taken out, before the next layout'); stage.layout(30); stage.attach(added, 'r', 2); stage.layout(30); stage.drop('r.1'); stage.layout(30); stage.drop(added); stage.layout(30); for (const path of stage.paths()) stage.facts(path) } },
    { name: 'a child given to a second parent without leaving the first', tree: row({ width: 30 }, column({}, cell(4, 1)), column({}, cell(5, 2))), run: stage => { stage.layout(30); stage.node('r.1').insertChild(stage.node('r.0.0'), 0); stage.facts('r.0.0'); stage.facts('r.0'); stage.facts('r.1'); stage.layout(30); stage.node('r.0').removeChild(stage.node('r.1.0')); stage.layout(30); stage.node('r.0').removeChild(stage.node('r.0.0')); stage.facts('r.0.0'); stage.layout(30); stage.node('r.1').removeChild(stage.node('r.0.0')); stage.layout(30) } },
    { name: 'a node freed twice, and freed while its parent holds it', tree: column({ width: 10 }, cell(3, 1), cell(4, 1)), run: stage => { stage.layout(10); stage.free('r.0'); stage.facts('r'); stage.layout(10); stage.free('r.0'); stage.free('r.1'); stage.free('r'); stage.free('r'); stage.free('r'); stage.layout(10) } },
    { name: 'a subtree laid out as its own root, then under its parent', tree: column({ width: 40, items: 'flex-start' }, row({}, text(12), cell(3, 2)), text(20)), run: stage => { stage.layout(undefined, undefined, 'r.0'); stage.layout(40); stage.layout(18, undefined, 'r.0'); stage.layout(40); stage.layout(40, undefined, 'r.1'); stage.layout(40) } },
    { name: 'two roots laid out in turn', tree: row({ width: 20 }, text(30), cell(4, 1)), run: stage => { const other = stage.add('r', 2, column({ width: 9 }, text(30))); stage.detach(other); stage.layout(20); stage.layout(9, undefined, other); stage.layout(20); stage.layout(9, undefined, other); stage.retext('r.0', 5); stage.layout(9, undefined, other); stage.layout(20) } },
    { name: 'a parent measured again in the pass that lays it out', tree: column({ width: 30, items: 'flex-start' }, row({ wrap: 'wrap' }, text(12), text(14), text(9)), column({}, text(50), row({}, text(20), text(20)))), run: stage => { stage.layout(30); stage.layout(30); stage.node('r').setAlignItems('stretch'); stage.layout(30); stage.node('r').setWidth(22); stage.layout(22) } },
    { name: 'a stretch that needs a second pass', tree: row({ width: 30 }, text(40, { width: 10 }), column({}, text(8)), { width: 3 }, column({ self: 'center' }, text(8))), run: stage => { stage.layout(30); stage.layout(30); stage.node('r').setFlexDirection('column'); stage.layout(30) } },
    { name: 'words the vocabulary does not hold', tree: column({ width: 40, height: 12 }, row({ height: 3 }, cell(4, 1), cell(5, 2)), row({ height: 3 }, cell(4, 1), cell(5, 2, { inset: { left: 2, top: 1 } })), cell(6, 2)), run: stage => { stage.layout(40); const words: Array<[string, (node: LayoutNode, word: never) => void, string]> = [['justify', (n, word) => n.setJustifyContent(word), 'r.0'], ['align-items', (n, word) => n.setAlignItems(word), 'r.0'], ['align-self', (n, word) => n.setAlignSelf(word), 'r.0.1'], ['direction', (n, word) => n.setFlexDirection(word), 'r.0'], ['wrap', (n, word) => n.setFlexWrap(word), 'r.0'], ['position', (n, word) => n.setPositionType(word), 'r.1.1'], ['overflow', (n, word) => n.setOverflow(word), 'r.1'], ['display', (n, word) => n.setDisplay(word), 'r.2']]; for (const [label, set, at] of words) { set(stage.node(at), 'unheard' as never); stage.note(`${at}: ${label} unheard`); stage.layout(40) } stage.facts('r.2') } },
    { name: 'every setter once on a box three levels down', tree: row({ width: 40, height: 10 }, cell(6, 2), column({}, column({}, text(15), cell(3, 1)), cell(2, 1)), cell(5, 3)), run: setOnce('r.1.0') },
    { name: 'every setter once on a text', tree: row({ width: 40, height: 10 }, cell(6, 2), column({}, text(15), cell(3, 1)), cell(5, 3)), run: setOnce('r.1.0') },
    { name: 'every setter once on the root', tree: row({ width: 40, height: 10 }, cell(6, 2), column({}, text(15), cell(3, 1)), cell(5, 3)), run: setOnce('r') },
  ]
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function randomSpec(rnd: () => number, depth: number): Spec {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
  const whole = (max: number, from = 0): number => from + Math.floor(rnd() * max)
  const measure = (max: number, from = 0): Measure => (rnd() < 0.25 ? (`${whole(100, 5)}%` as const) : rnd() < 0.1 ? whole(max, from) + 0.5 : whole(max, from))
  const edges = (max: number): Edges => (rnd() < 0.5 ? { all: whole(max) } : { [pick(EDGES)]: whole(max), [pick(SIDES)]: whole(max) })
  const spec: Spec = {}
  if (rnd() < 0.8) spec.direction = pick(DIRECTIONS)
  if (rnd() < 0.5) spec.justify = pick(JUSTIFIES)
  if (rnd() < 0.5) spec.items = pick(ALIGNS)
  if (rnd() < 0.15) spec.self = pick(ALIGNS)
  if (rnd() < 0.25) spec.wrap = pick(WRAPS)
  if (rnd() < 0.4) spec.width = measure(60, 4)
  if (rnd() < 0.3) spec.height = measure(20, 2)
  if (rnd() < 0.35) spec.grow = pick([0, 1, 1, 2, 0.5])
  if (rnd() < 0.35) spec.shrink = pick([0, 1, 1, 2, 0.5])
  if (rnd() < 0.2) spec.basis = rnd() < 0.2 ? Number.NaN : measure(30)
  if (rnd() < 0.3) spec.padding = edges(3)
  if (rnd() < 0.3) spec.margin = edges(3)
  if (rnd() < 0.2) spec.border = rnd() < 0.7 ? { all: 1 } : edges(2)
  if (rnd() < 0.25) spec.gap = { [pick(GUTTERS)]: whole(3) }
  if (rnd() < 0.15) spec.minWidth = measure(15)
  if (rnd() < 0.15) spec.maxWidth = rnd() < 0.2 ? Number.NaN : measure(40, 20)
  if (rnd() < 0.1) spec.minHeight = measure(6)
  if (rnd() < 0.1) spec.maxHeight = measure(12, 2)
  if (rnd() < 0.12) spec.overflow = pick(OVERFLOWS)
  if (rnd() < 0.08) spec.inset = { [pick(SIDES)]: measure(4) }
  if (depth > 0 && rnd() < 0.85) {
    spec.kids = Array.from({ length: 1 + whole(4) }, () => {
      if (rnd() < 0.3) return { text: 1 + whole(70), ...(rnd() < 0.3 ? { shrink: 1 } : {}), ...(rnd() < 0.1 ? { shape: pick(['block', 'half'] as const) } : {}) }
      const kid = randomSpec(rnd, depth - 1)
      if (rnd() < 0.12) {
        kid.place = 'absolute'
        kid.inset = rnd() < 0.5 ? { left: measure(10), top: measure(4) } : { [pick(SIDES)]: measure(6), [pick(SIDES)]: measure(6), ...(rnd() < 0.3 ? { [pick(EDGES)]: measure(3) } : {}) }
        if (rnd() < 0.6) kid.width = kid.width ?? 8
        if (rnd() < 0.6) kid.height = kid.height ?? 2
      }
      if (rnd() < 0.08) kid.display = 'none'
      return kid
    })
  } else if (rnd() < 0.5) spec.text = 1 + whole(80)
  return spec
}

function randomChange(rnd: () => number): [string, (node: LayoutNode) => void] {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
  const whole = (max: number, from = 0): number => from + Math.floor(rnd() * max)
  const edge = pick(EDGES)
  const side = pick(SIDES)
  const gutter = pick(GUTTERS)
  const direction = pick(DIRECTIONS)
  const wrap = pick(WRAPS)
  const align = pick(ALIGNS)
  const justify = pick(JUSTIFIES)
  const overflow = pick(OVERFLOWS)
  const place = pick(['absolute', 'relative'] as const)
  const flex = pick([0, 1, 2, 0.5])
  const value = whole(30, 1)
  const share = whole(100, 5)
  const small = whole(4)
  const changes: Array<[string, (node: LayoutNode) => void]> = [
    [`width ${value}`, n => n.setWidth(value)], [`width ${share}%`, n => n.setWidthPercent(share)], ['width auto', n => n.setWidthAuto()],
    [`height ${small + 1}`, n => n.setHeight(small + 1)], [`height ${share}%`, n => n.setHeightPercent(share)], ['height auto', n => n.setHeightAuto()],
    [`min-width ${small * 3}`, n => n.setMinWidth(small * 3)], [`min-width ${share}%`, n => n.setMinWidthPercent(share)],
    [`min-height ${small}`, n => n.setMinHeight(small)], [`min-height ${share}%`, n => n.setMinHeightPercent(share)],
    [`max-width ${value}`, n => n.setMaxWidth(value)], [`max-width ${share}%`, n => n.setMaxWidthPercent(share)], ['max-width unset', n => n.setMaxWidth(Number.NaN)],
    [`max-height ${small + 2}`, n => n.setMaxHeight(small + 2)], [`max-height ${share}%`, n => n.setMaxHeightPercent(share)], ['max-height unset', n => n.setMaxHeight(Number.NaN)],
    [`direction ${direction}`, n => n.setFlexDirection(direction)], [`grow ${flex}`, n => n.setFlexGrow(flex)], [`shrink ${flex}`, n => n.setFlexShrink(flex)],
    [`basis ${value}`, n => n.setFlexBasis(value)], [`basis ${share}%`, n => n.setFlexBasisPercent(share)], ['basis unset', n => n.setFlexBasis(Number.NaN)],
    [`wrap ${wrap}`, n => n.setFlexWrap(wrap)], [`align-items ${align}`, n => n.setAlignItems(align)], [`align-self ${align}`, n => n.setAlignSelf(align)], [`justify ${justify}`, n => n.setJustifyContent(justify)],
    [`position ${place}`, n => n.setPositionType(place)], [`inset ${side} ${small}`, n => n.setPosition(side, small)], [`inset ${side} ${share}%`, n => n.setPositionPercent(side, share)], [`inset ${side} unset`, n => n.setPosition(side, Number.NaN)],
    [`overflow ${overflow}`, n => n.setOverflow(overflow)], [`margin ${edge} ${small}`, n => n.setMargin(edge, small)], [`padding ${edge} ${small}`, n => n.setPadding(edge, small)], [`border ${edge} ${small % 2}`, n => n.setBorder(edge, small % 2)],
    [`gap ${gutter} ${small}`, n => n.setGap(gutter, small)],
  ]
  return pick(changes)
}

function changedScene(seed: number, steps: number, detail: Detail): Scene {
  return {
    name: `a random tree changed ${steps} times, seed ${seed}`,
    detail,
    tree: {},
    run: stage => {
      const rnd = lcg(0x1a40 + seed * 7919)
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
      const whole = (max: number, from = 0): number => from + Math.floor(rnd() * max)
      let columns = pick([24, 40, 80, 80, 120])
      const top = stage.add('r', 0, { width: columns, ...randomSpec(rnd, 3) })
      stage.detach(top)
      const lay = (): void => {
        const roll = rnd()
        if (roll < 0.06) stage.layout(undefined, undefined, top)
        else if (roll < 0.12) stage.layout(pick([24, 40, 80, 120]), undefined, top)
        else stage.layout(columns, undefined, top)
      }
      lay()
      for (let step = 0; step < steps; step++) {
        const roll = rnd()
        const paths = stage.paths().filter(path => path !== 'r')
        const inner = paths.filter(path => path !== top)
        const target = pick(paths)
        if (roll < 0.1) stage.note('nothing changed')
        else if (roll < 0.22) {
          columns = pick([24, 40, 80, 120, 31])
          stage.node(top).setWidth(columns)
          stage.note(`the root is ${columns} wide`)
        } else if (roll < 0.5) {
          const [label, change] = randomChange(rnd)
          change(stage.node(target))
          stage.note(`${target}: ${label}`)
        } else if (roll < 0.64) {
          const texts = stage.texts()
          if (texts.length === 0) stage.note('no text to change')
          else {
            const at = pick(texts)
            const count = whole(90)
            stage.retext(at, count)
            stage.note(`${at}: text of ${count}`)
          }
        } else if (roll < 0.76) {
          const index = whole(4)
          const added = stage.add(target, index, rnd() < 0.4 ? { text: 1 + whole(60) } : randomSpec(rnd, 1))
          stage.note(`${added}: put in at ${index}`)
        } else if (roll < 0.84 && inner.length > 0) {
          const gone = pick(inner)
          stage.drop(gone)
          stage.note(`${gone}: freed with its subtree`)
        } else if (roll < 0.92) {
          const hidden = stage.node(target).getDisplay() === 'none'
          stage.node(target).setDisplay(hidden ? 'flex' : 'none')
          stage.note(`${target}: display ${hidden ? 'flex' : 'none'}`)
        } else if (inner.length > 1) {
          const moved = pick(inner)
          const home = pick(paths.filter(path => !stage.within(path, moved)))
          const index = whole(3)
          stage.detach(moved)
          stage.attach(moved, home, index)
          stage.note(`${moved}: moved under ${home} at ${index}`)
        } else stage.note('nothing to move')
        lay()
      }
    },
  }
}

export function recordCorpus(engine: Engine): Recorded {
  const first: Scene = { name: 'the first layout of the process, with no width given', tree: row({}, cell(4, 2), text(9), column({}, cell(3, 1))), run: stage => stage.layout(undefined) }
  const scenes: Scene[] = [first, ...directionScenes(), ...flexScenes(), ...boundScenes(), ...boxScenes(), ...placedScenes(), ...textScenes(), ...treeScenes()]
  for (let seed = 0; seed < 40; seed++) scenes.push(changedScene(seed, 14, 'digests'))
  for (let seed = 40; seed < 640; seed++) scenes.push(changedScene(seed, 14, 'sealed'))
  const out: Recorded = new Map()
  for (const scene of scenes) {
    const detail = scene.detail ?? 'rects'
    const stage = new Stage(engine, engine.open === scene.name ? 'rects' : detail)
    stage.build(scene.tree, 'r', null)
    if (scene.run === undefined) stage.layout(80)
    else scene.run(stage)
    stage.close()
    if (out.has(scene.name)) throw new Error(`two scenes are named ${scene.name}`)
    out.set(scene.name, sealed(scene.name, stage.lines, detail, engine, stage.tally))
  }
  return out
}

type Arg = number | string | null
type Op = [verb: number, node: number, ...rest: Arg[]]
type Reel = { screen: string; ops: Op[] }

const NUMBER_WORDS = new Set(['NaN', 'Infinity', '-Infinity', '-0'])
const amount = (arg: Arg | undefined): number | undefined => (arg === null || arg === undefined ? undefined : Number(arg))
const valueOf = (arg: Arg): number | string | undefined => (arg === null ? undefined : typeof arg === 'string' && !NUMBER_WORDS.has(arg) ? arg : Number(arg))

export function replayScreens(engine: Engine, text: string): Recorded {
  const out: Recorded = new Map()
  const [head, ...rows] = text.split(/\r?\n/).filter(row => row !== '')
  if (head === undefined) return out
  const verbs = (JSON.parse(head) as { verbs: string[] }).verbs
  for (const row of rows) {
    const reel = JSON.parse(row) as Reel
    const name = `the layout calls of ${reel.screen}`
    const open = engine.open === name
    const nodes = new Map<number, LayoutNode>()
    const live: number[] = []
    const epochs = new Map<number, number>()
    const told = new Map<number, Map<string, readonly [number, number]>>()
    const lines: string[] = []
    const tally: Tally = { layouts: 0, visited: 0, measured: 0, hits: 0 }
    let asked = 0
    let unanswered = 0
    const nodeOf = (id: number): LayoutNode => {
      let node = nodes.get(id)
      if (node === undefined) {
        node = engine.create()
        nodes.set(id, node)
        live.push(id)
      }
      return node
    }
    const gone = (id: number): void => {
      const at = live.indexOf(id)
      if (at >= 0) live.splice(at, 1)
    }
    const epochOf = (id: number): number => epochs.get(id) ?? 0
    const turn = (id: number): void => void epochs.set(id, epochOf(id) + 1)
    {
      const turns = new Map<number, number>()
      for (const op of reel.ops) {
        const id = op[1]
        const verb = verbs[op[0]]
        if (verb === 'markDirty' || verb === 'setMeasureFunc' || verb === 'unsetMeasureFunc') turns.set(id, (turns.get(id) ?? 0) + 1)
        if (verb !== 'answer') continue
        const table = told.get(id) ?? new Map<string, readonly [number, number]>()
        told.set(id, table)
        table.set(`${turns.get(id) ?? 0}|${num(Number(op[2]))}|${op[3]}`, [Number(op[4]), Number(op[5])])
      }
    }
    for (const op of reel.ops) {
      const [, id, a, b] = op
      const verb = verbs[op[0]]
      if (verb === undefined) throw new Error(`${reel.screen}: no verb ${op[0]}`)
      if (verb === 'answer') continue
      const node = nodeOf(id)
      if (verb === 'calculateLayout') {
        asked = 0
        node.calculateLayout(amount(a), amount(b))
        counted(tally, engine.counters())
        const rects = live.map(each => `${each}=${rectOf(nodes.get(each)!)}`).join(' ')
        const head = `layout ${tally.layouts} of node ${id} at ${a ?? '-'}: ${countersOf(engine.counters())} asked ${asked} nodes ${live.length}`
        if (open) lines.push(head, `  rects ${rects}`)
        else lines.push(`${head} rects ${digest(rects)}`)
        for (const line of traced(engine)) lines.push(`  trace ${line}`)
      } else if (verb === 'insertChild') node.insertChild(nodeOf(Number(a)), Number(b))
      else if (verb === 'removeChild') node.removeChild(nodeOf(Number(a)))
      else if (verb === 'setMeasureFunc') {
        turn(id)
        node.setMeasureFunc((width, mode) => {
          asked++
          const known = told.get(id)?.get(`${epochOf(id)}|${num(width)}|${mode}`)
          if (known === undefined) {
            unanswered++
            return { width: 0, height: 0 }
          }
          return { width: known[0], height: known[1] }
        })
      } else if (verb === 'unsetMeasureFunc') {
        turn(id)
        node.unsetMeasureFunc()
      } else if (verb === 'markDirty') {
        turn(id)
        node.markDirty()
      } else if (verb === 'free' || verb === 'freeRecursive') {
        if (verb === 'free') node.free()
        else node.freeRecursive()
        for (const freed of op.slice(2)) gone(Number(freed))
        gone(id)
      } else {
        const call = (node as unknown as Record<string, (...args: unknown[]) => void>)[verb]
        if (!verb.startsWith('set') || typeof call !== 'function') throw new Error(`${reel.screen}: the layout node has no ${verb}`)
        call.apply(node, op.slice(2).map(valueOf))
      }
    }
    for (const id of [...live].reverse()) nodes.get(id)!.free()
    lines.push(`closed: live ${engine.counters().live} · questions with no recorded answer ${unanswered}`)
    if (out.has(name)) throw new Error(`two screens are named ${reel.screen}`)
    out.set(name, sealed(name, lines, 'sealed', engine, tally, ` · questions with no recorded answer ${unanswered}`))
  }
  return out
}
