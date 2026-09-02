// ============================================================================
//  scripts/ink-runtime/layoutScenes.ts — the shared
//  layout scene corpus.
//
//  Declarative scene specs + a builder that applies them through the
//  LayoutNode contract (src/ink/layout/node.ts) — engine-agnostic on purpose:
//  B1 freezes the yoga oracle's rectangles; B2 runs the SAME scenes through
//  Mercury Cell Layout differentially. Deterministic throughout (seeded LCG,
//  no Date/Math.random).
// ============================================================================
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
} from '../../src/ink/layout/node.js'

// ---------------------------------------------------------------------------
// Scene spec

export type NodeSpec = {
  width?: number | `${number}%` | 'auto'
  height?: number | `${number}%` | 'auto'
  minWidth?: number | `${number}%`
  minHeight?: number | `${number}%`
  maxWidth?: number | `${number}%`
  maxHeight?: number | `${number}%`
  flexDirection?: LayoutFlexDirection
  flexGrow?: number
  flexShrink?: number
  flexBasis?: number | `${number}%`
  flexWrap?: LayoutWrap
  alignItems?: LayoutAlign
  alignSelf?: LayoutAlign
  justifyContent?: LayoutJustify
  display?: LayoutDisplay
  positionType?: LayoutPositionType
  position?: Partial<Record<LayoutEdge, number | `${number}%`>>
  overflow?: LayoutOverflow
  margin?: Partial<Record<LayoutEdge, number>>
  padding?: Partial<Record<LayoutEdge, number>>
  border?: Partial<Record<LayoutEdge, number>>
  gap?: Partial<Record<LayoutGutter, number>>
  /** Deterministic fake text content: measured like measureTextNode. */
  text?: number // number of cells
  children?: NodeSpec[]
}

export type Scene = {
  name: string
  root: NodeSpec
  /** calculateLayout passes: [width, height] — undefined = unconstrained. */
  passes: Array<[number | undefined, number | undefined]>
  /**
   * Optional mutation between passes (index = after pass i): returns nodes
   * to re-measure. Used by the relayout/dirty scenes.
   */
  mutate?: (handles: BuiltNode[], passIndex: number) => void
}

export type BuiltNode = {
  node: LayoutNode
  spec: NodeSpec
  path: string
  /** For text nodes: mutable content length the measure func closes over. */
  textLen?: { value: number }
}

// ---------------------------------------------------------------------------
// Deterministic text measurement — mirrors measureTextNode's shape: an
// unconstrained width is the full run; a constrained width wraps into
// ceil(len/width) rows. Both engines receive the SAME function.

export function fakeTextMeasure(
  len: { value: number },
): (width: number, widthMode: LayoutMeasureMode) => { width: number; height: number } {
  return (width, widthMode) => {
    const n = len.value
    if (widthMode === 'undefined' || !Number.isFinite(width) || width <= 0) {
      return { width: n, height: 1 }
    }
    const w = Math.max(1, Math.floor(width))
    if (widthMode === 'exactly') {
      return { width: w, height: Math.max(1, Math.ceil(n / w)) }
    }
    // at-most
    if (n <= w) return { width: n, height: 1 }
    return { width: w, height: Math.ceil(n / w) }
  }
}

// ---------------------------------------------------------------------------
// Builder — applies a spec through the LayoutNode contract.

function applyDimension(
  node: LayoutNode,
  value: number | `${number}%` | 'auto',
  fns: { fixed: (v: number) => void; percent: (v: number) => void; auto?: () => void },
): void {
  if (value === 'auto') fns.auto?.()
  else if (typeof value === 'string') fns.percent(parseFloat(value))
  else fns.fixed(value)
}

export function buildScene(
  spec: NodeSpec,
  createNode: () => LayoutNode,
): BuiltNode[] {
  const out: BuiltNode[] = []
  function build(s: NodeSpec, path: string): BuiltNode {
    const node = createNode()
    const built: BuiltNode = { node, spec: s, path }
    out.push(built)
    applySpec(built)
    s.children?.forEach((c, i) => {
      const cb = build(c, `${path}.${i}`)
      node.insertChild(cb.node, i)
    })
    return built
  }
  function applySpec(b: BuiltNode): void {
    const { node, spec: s } = b
    if (s.width !== undefined)
      applyDimension(node, s.width, {
        fixed: v => node.setWidth(v),
        percent: v => node.setWidthPercent(v),
        auto: () => node.setWidthAuto(),
      })
    if (s.height !== undefined)
      applyDimension(node, s.height, {
        fixed: v => node.setHeight(v),
        percent: v => node.setHeightPercent(v),
        auto: () => node.setHeightAuto(),
      })
    if (s.minWidth !== undefined)
      applyDimension(node, s.minWidth, {
        fixed: v => node.setMinWidth(v),
        percent: v => node.setMinWidthPercent(v),
      })
    if (s.minHeight !== undefined)
      applyDimension(node, s.minHeight, {
        fixed: v => node.setMinHeight(v),
        percent: v => node.setMinHeightPercent(v),
      })
    if (s.maxWidth !== undefined)
      applyDimension(node, s.maxWidth, {
        fixed: v => node.setMaxWidth(v),
        percent: v => node.setMaxWidthPercent(v),
      })
    if (s.maxHeight !== undefined)
      applyDimension(node, s.maxHeight, {
        fixed: v => node.setMaxHeight(v),
        percent: v => node.setMaxHeightPercent(v),
      })
    if (s.flexDirection) node.setFlexDirection(s.flexDirection)
    if (s.flexGrow !== undefined) node.setFlexGrow(s.flexGrow)
    if (s.flexShrink !== undefined) node.setFlexShrink(s.flexShrink)
    if (s.flexBasis !== undefined)
      applyDimension(node, s.flexBasis, {
        fixed: v => node.setFlexBasis(v),
        percent: v => node.setFlexBasisPercent(v),
      })
    if (s.flexWrap) node.setFlexWrap(s.flexWrap)
    if (s.alignItems) node.setAlignItems(s.alignItems)
    if (s.alignSelf) node.setAlignSelf(s.alignSelf)
    if (s.justifyContent) node.setJustifyContent(s.justifyContent)
    if (s.display) node.setDisplay(s.display)
    if (s.positionType) node.setPositionType(s.positionType)
    if (s.position)
      for (const [edge, v] of Object.entries(s.position)) {
        if (typeof v === 'string')
          node.setPositionPercent(edge as LayoutEdge, parseFloat(v))
        else node.setPosition(edge as LayoutEdge, v as number)
      }
    if (s.overflow) node.setOverflow(s.overflow)
    if (s.margin)
      for (const [edge, v] of Object.entries(s.margin))
        node.setMargin(edge as LayoutEdge, v as number)
    if (s.padding)
      for (const [edge, v] of Object.entries(s.padding))
        node.setPadding(edge as LayoutEdge, v as number)
    if (s.border)
      for (const [edge, v] of Object.entries(s.border))
        node.setBorder(edge as LayoutEdge, v as number)
    if (s.gap)
      for (const [gutter, v] of Object.entries(s.gap))
        node.setGap(gutter as LayoutGutter, v as number)
    if (s.text !== undefined) {
      const textLen = { value: s.text }
      b.textLen = textLen
      node.setMeasureFunc(fakeTextMeasure(textLen))
    }
  }
  build(spec, 'root')
  return out
}

// ---------------------------------------------------------------------------
// Rect projection

export type SceneRects = Record<
  string,
  { left: number; top: number; width: number; height: number }
>

const r4 = (n: number) => Math.round(n * 10000) / 10000

export function readRects(handles: BuiltNode[]): SceneRects {
  const rects: SceneRects = {}
  for (const h of handles) {
    rects[h.path] = {
      left: r4(h.node.getComputedLeft()),
      top: r4(h.node.getComputedTop()),
      width: r4(h.node.getComputedWidth()),
      height: r4(h.node.getComputedHeight()),
    }
  }
  return rects
}

export function freeScene(handles: BuiltNode[]): void {
  handles[0]?.node.freeRecursive()
}

// ---------------------------------------------------------------------------
// Seeded LCG (deterministic; no Math.random by design)

export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!
}

const DIRECTIONS = ['row', 'column', 'row-reverse', 'column-reverse'] as const
const JUSTIFIES = [
  'flex-start',
  'center',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly',
] as const
const ALIGNS = ['auto', 'stretch', 'flex-start', 'center', 'flex-end'] as const
const WRAPS = ['nowrap', 'wrap', 'wrap-reverse'] as const

function randomSpec(rnd: () => number, depth: number): NodeSpec {
  const spec: NodeSpec = {}
  if (rnd() < 0.8) spec.flexDirection = pick(rnd, DIRECTIONS)
  if (rnd() < 0.5) spec.justifyContent = pick(rnd, JUSTIFIES)
  if (rnd() < 0.5) spec.alignItems = pick(rnd, ALIGNS)
  if (rnd() < 0.25) spec.flexWrap = pick(rnd, WRAPS)
  if (rnd() < 0.35) spec.width = Math.floor(rnd() * 60) + 4
  else if (rnd() < 0.15) spec.width = `${Math.floor(rnd() * 90) + 10}%` as const
  if (rnd() < 0.3) spec.height = Math.floor(rnd() * 20) + 2
  if (rnd() < 0.3) spec.flexGrow = Math.floor(rnd() * 3)
  if (rnd() < 0.2) spec.flexShrink = Math.floor(rnd() * 2)
  if (rnd() < 0.2) spec.flexBasis = Math.floor(rnd() * 30)
  if (rnd() < 0.3)
    spec.padding = { all: Math.floor(rnd() * 3) }
  if (rnd() < 0.3) spec.margin = { all: Math.floor(rnd() * 3) }
  if (rnd() < 0.2) spec.border = { all: 1 }
  if (rnd() < 0.25) spec.gap = { all: Math.floor(rnd() * 3) }
  if (rnd() < 0.15) spec.minWidth = Math.floor(rnd() * 15)
  if (rnd() < 0.15) spec.maxWidth = Math.floor(rnd() * 40) + 20
  if (rnd() < 0.1) spec.alignSelf = pick(rnd, ALIGNS)
  if (depth > 0 && rnd() < 0.85) {
    const n = 1 + Math.floor(rnd() * 3)
    spec.children = Array.from({ length: n }, () => {
      if (rnd() < 0.3) return { text: 1 + Math.floor(rnd() * 60) } as NodeSpec
      const child = randomSpec(rnd, depth - 1)
      if (rnd() < 0.12) {
        child.positionType = 'absolute'
        child.position = { left: Math.floor(rnd() * 10), top: Math.floor(rnd() * 4) }
        child.width = child.width ?? 8
        child.height = child.height ?? 2
      }
      if (rnd() < 0.08) child.display = 'none'
      return child
    })
  } else if (rnd() < 0.5) {
    spec.text = 1 + Math.floor(rnd() * 80)
  }
  return spec
}

// ---------------------------------------------------------------------------
// The corpus

export function curatedScenes(): Scene[] {
  const scenes: Scene[] = []
  const std: Array<[number | undefined, number | undefined]> = [[80, undefined]]

  // Every direction × justify over three fixed children.
  for (const dir of DIRECTIONS)
    for (const j of JUSTIFIES)
      scenes.push({
        name: `dir-${dir}-justify-${j}`,
        root: {
          width: 40,
          height: 12,
          flexDirection: dir,
          justifyContent: j,
          children: [
            { width: 6, height: 2 },
            { width: 8, height: 3 },
            { width: 4, height: 1 },
          ],
        },
        passes: std,
      })

  // Align variants (items + self override).
  for (const a of ALIGNS)
    scenes.push({
      name: `align-items-${a}`,
      root: {
        width: 30,
        height: 10,
        flexDirection: 'row',
        alignItems: a,
        children: [
          { width: 5, height: 2 },
          { width: 5, height: 4, alignSelf: 'flex-end' },
          { width: 5 }, // stretch candidate: no height
        ],
      },
      passes: std,
    })

  // Grow / shrink allocation.
  scenes.push(
    {
      name: 'grow-distribution',
      root: {
        width: 60,
        height: 4,
        flexDirection: 'row',
        children: [
          { flexGrow: 1, height: 2 },
          { flexGrow: 2, height: 2 },
          { flexGrow: 1, width: 10, height: 2 },
        ],
      },
      passes: std,
    },
    {
      name: 'shrink-overflow',
      root: {
        width: 30,
        height: 4,
        flexDirection: 'row',
        children: [
          { width: 20, flexShrink: 1, height: 2 },
          { width: 20, flexShrink: 3, height: 2 },
          { width: 10, flexShrink: 0, height: 2 },
        ],
      },
      passes: std,
    },
    {
      name: 'basis-mixed',
      root: {
        width: 50,
        height: 4,
        flexDirection: 'row',
        children: [
          { flexBasis: 10, flexGrow: 1, height: 2 },
          { flexBasis: '20%', flexGrow: 1, height: 2 },
          { width: 8, height: 2 },
        ],
      },
      passes: std,
    },
  )

  // Min/max clamps + percent dims.
  scenes.push({
    name: 'minmax-percent',
    root: {
      width: 64,
      height: 16,
      flexDirection: 'row',
      children: [
        { width: '50%', maxWidth: 20, height: 4 },
        { width: 4, minWidth: 10, height: '50%' },
        { width: '25%', minWidth: '30%', height: 4 },
        { flexGrow: 1, maxHeight: 2, minHeight: 1 },
      ],
    },
    passes: std,
  })

  // Margin/padding/border/gap incl. Start/End edges.
  scenes.push(
    {
      name: 'box-model',
      root: {
        width: 40,
        height: 12,
        flexDirection: 'column',
        padding: { all: 1 },
        border: { all: 1 },
        gap: { all: 1 },
        children: [
          { height: 2, margin: { left: 2, right: 1 } },
          { height: 2, margin: { start: 3 } },
          { height: 2, margin: { horizontal: 2, vertical: 1 } },
        ],
      },
      passes: std,
    },
    {
      name: 'gap-row-column',
      root: {
        width: 30,
        height: 12,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: { column: 2, row: 1 },
        children: Array.from({ length: 6 }, () => ({ width: 8, height: 2 })),
      },
      passes: std,
    },
  )

  // Wrap variants.
  for (const w of WRAPS)
    scenes.push({
      name: `wrap-${w}`,
      root: {
        width: 20,
        height: 12,
        flexDirection: 'row',
        flexWrap: w,
        children: Array.from({ length: 5 }, (_, i) => ({
          width: 7,
          height: 2 + (i % 2),
        })),
      },
      passes: std,
    })

  // Absolute positioning (+ percent) over relative siblings.
  scenes.push({
    name: 'absolute-overlay',
    root: {
      width: 40,
      height: 10,
      flexDirection: 'column',
      children: [
        { height: 3 },
        {
          positionType: 'absolute',
          position: { left: 5, top: 2 },
          width: 10,
          height: 2,
        },
        {
          positionType: 'absolute',
          position: { right: 1, bottom: 1 },
          width: 8,
          height: 2,
        },
        {
          positionType: 'absolute',
          position: { left: '50%', top: '25%' },
          width: 6,
          height: 2,
        },
        { height: 3 },
      ],
    },
    passes: std,
  })

  // Display none removes from flow.
  scenes.push({
    name: 'display-none-flow',
    root: {
      width: 30,
      height: 6,
      flexDirection: 'row',
      children: [
        { width: 8, height: 2 },
        { width: 8, height: 2, display: 'none' },
        { width: 8, height: 2 },
      ],
    },
    passes: std,
  })

  // Text measurement under constraints (exact/at-most both arise from
  // container shapes): unconstrained root → text at intrinsic width;
  // narrow parent → wrap; grow with measured content.
  scenes.push(
    {
      name: 'text-intrinsic',
      root: {
        flexDirection: 'column',
        children: [{ text: 12 }, { text: 45 }, { text: 3 }],
      },
      passes: [[80, undefined]],
    },
    {
      name: 'text-wrapping-narrow',
      root: {
        width: 10,
        flexDirection: 'column',
        children: [{ text: 34 }, { text: 8 }],
      },
      passes: std,
    },
    {
      name: 'text-in-row-with-grow',
      root: {
        width: 40,
        flexDirection: 'row',
        children: [{ text: 25 }, { flexGrow: 1, children: [{ text: 30 }] }],
      },
      passes: std,
    },
  )

  // Overflow metadata scenes (hidden/scroll shouldn't change static layout
  // of children, but pin it).
  scenes.push({
    name: 'overflow-hidden-scroll',
    root: {
      width: 24,
      height: 6,
      flexDirection: 'column',
      children: [
        {
          height: 3,
          overflow: 'hidden',
          children: [{ height: 8, width: 10 }],
        },
        {
          height: 3,
          overflow: 'scroll',
          children: [{ height: 8, width: 10 }],
        },
      ],
    },
    passes: std,
  })

  // Deep nesting with mixed constraints (the cockpit-rail shape: fixed rails
  // + center grow, at two breakpoints).
  scenes.push({
    name: 'cockpit-rails',
    root: {
      flexDirection: 'row',
      width: 150,
      height: 40,
      children: [
        { width: 24, flexShrink: 0, flexDirection: 'column', children: [{ text: 20 }, { flexGrow: 1 }] },
        {
          flexGrow: 1,
          flexDirection: 'column',
          children: [
            { height: 3, border: { all: 1 } },
            { flexGrow: 1, padding: { all: 1 }, children: [{ text: 200 }] },
            { height: 5 },
          ],
        },
        { width: 30, flexShrink: 0 },
      ],
    },
    passes: [
      [150, 40],
      [100, 40],
      [80, 24],
    ],
  })

  // Relayout + dirty: content change between passes (the
  // measure-contamination arm — same tree, markDirty on a text node whose
  // content changed, then re-layout at the same AND a different width).
  scenes.push({
    name: 'relayout-content-change',
    root: {
      width: 40,
      flexDirection: 'column',
      children: [
        { text: 10 },
        { flexDirection: 'row', children: [{ text: 30 }, { flexGrow: 1, children: [{ text: 5 }] }] },
      ],
    },
    passes: [
      [40, undefined],
      [40, undefined],
      [72, undefined],
      [40, undefined],
    ],
    mutate: (handles, passIndex) => {
      const texts = handles.filter(h => h.textLen)
      if (passIndex === 0) {
        // grow the middle text past the wrap threshold
        texts[1]!.textLen!.value = 55
        texts[1]!.node.markDirty()
      } else if (passIndex === 2) {
        // shrink it back — rects must return to a pure function of inputs
        texts[1]!.textLen!.value = 30
        texts[1]!.node.markDirty()
      }
    },
  })

  return scenes
}

export function randomScenes(count: number, seedBase = 0xbed0c): Scene[] {
  const scenes: Scene[] = []
  for (let i = 0; i < count; i++) {
    const rnd = lcg(seedBase + i * 7919)
    scenes.push({
      name: `random-${i}`,
      root: { width: 4 + Math.floor(rnd() * 100), ...randomSpec(rnd, 3) },
      passes: [
        [20, undefined],
        [80, undefined],
        [120, 40],
      ],
    })
  }
  return scenes
}

// Production-shaped random space: Box/Text web defaults (row, grow 0,
// shrink 1), sane prop ranges — the envelope real Mercury UI lives in.
// 600 scenes of this space are part of the standing differential.
export function productionScenes(count: number, seedBase = 0x9d0d): Scene[] {
  const scenes: Scene[] = []
  const DIRS = ['row', 'column', 'row', 'column', 'row-reverse'] as const
  const JUST = ['flex-start', 'center', 'flex-end', 'space-between'] as const
  const ALIGN = ['stretch', 'flex-start', 'center', 'flex-end'] as const
  function prodSpec(rnd: () => number, depth: number): NodeSpec {
    const pickL = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!
    const spec: NodeSpec = { flexDirection: pickL(DIRS), flexGrow: 0, flexShrink: 1 }
    if (rnd() < 0.4) spec.justifyContent = pickL(JUST)
    if (rnd() < 0.3) spec.alignItems = pickL(ALIGN)
    if (rnd() < 0.35) spec.width = 6 + Math.floor(rnd() * 60)
    if (rnd() < 0.15) spec.height = 2 + Math.floor(rnd() * 12)
    if (rnd() < 0.35) spec.flexGrow = 1
    if (rnd() < 0.3) spec.padding = { all: 1 + Math.floor(rnd() * 2) }
    if (rnd() < 0.25) spec.border = { all: 1 }
    if (rnd() < 0.25) spec.margin = { all: 1 }
    if (rnd() < 0.25) spec.gap = { all: 1 + Math.floor(rnd() * 2) }
    if (rnd() < 0.1) spec.minWidth = 4 + Math.floor(rnd() * 10)
    if (rnd() < 0.1) spec.maxWidth = 20 + Math.floor(rnd() * 40)
    if (rnd() < 0.12) spec.flexWrap = 'wrap'
    if (depth > 0 && rnd() < 0.9) {
      const n = 1 + Math.floor(rnd() * 3)
      spec.children = Array.from({ length: n }, () => {
        if (rnd() < 0.4) return { text: 3 + Math.floor(rnd() * 70), flexGrow: 0, flexShrink: 1 } as NodeSpec
        const c = prodSpec(rnd, depth - 1)
        if (rnd() < 0.08) {
          c.positionType = 'absolute'
          c.position = { left: Math.floor(rnd() * 6), top: Math.floor(rnd() * 3) }
          c.width = c.width ?? 10
          c.height = c.height ?? 3
        }
        if (rnd() < 0.06) c.display = 'none'
        return c
      })
    } else if (rnd() < 0.5) spec.text = 3 + Math.floor(rnd() * 70)
    return spec
  }
  for (let i = 0; i < count; i++) {
    const rnd = lcg(seedBase + i * 104729)
    scenes.push({
      name: `prod-${i}`,
      root: { width: 20 + Math.floor(rnd() * 120), ...prodSpec(rnd, 4) },
      passes: [
        [80, undefined],
        [30, undefined],
        [140, 50],
      ],
    })
  }
  return scenes
}

export function allScenes(): Scene[] {
  return [...curatedScenes(), ...randomScenes(48)]
}

// ---------------------------------------------------------------------------
// Run a scene through an engine factory → per-pass rects.

export function runScene(
  scene: Scene,
  createNode: () => LayoutNode,
): SceneRects[] {
  const handles = buildScene(scene.root, createNode)
  const root = handles[0]!.node
  const passRects: SceneRects[] = []
  scene.passes.forEach(([w, h], i) => {
    root.calculateLayout(w, h)
    passRects.push(readRects(handles))
    scene.mutate?.(handles, i)
  })
  freeScene(handles)
  return passRects
}
