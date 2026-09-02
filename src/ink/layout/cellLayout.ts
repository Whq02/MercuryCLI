// ============================================================================
//  Mercury Cell Layout — the owned terminal layout engine.
//
//  Implements exactly the LayoutNode contract (node.ts) — the flex subset
//  Mercury's terminal UI uses — as an engine built from the CSS
//  flexbox model, the frozen scene corpus (scripts/ink-runtime/goldens/
//  layout-corpus.json), and black-box probes of the previous engine's
//  ratified semantics. It does NOT import or derive from the retired
//  yoga port.
//
//  Ratified semantic pins:
//    • width-only constraint space — calculateLayout ignores the height
//      param (the production adapter always passed height=undefined); the
//      width param is EXACT at the root;
//    • defaults are Yoga-classic: flexDirection column · alignItems stretch ·
//      flexShrink 0 · justify flex-start · nowrap · relative;
//    • percent dimensions resolve against the owner's BORDER-BOX width/height;
//    • edge precedence: exact edge > start/end > horizontal/vertical > all;
//    • absolute insets are border-edge based; an axis with no inset takes the
//      static flow position (border + padding); both insets + auto size ⇒
//      stretch between them;
//    • pixel-grid rounding happens on ABSOLUTE edges after layout (child
//      rects derive from rounded absolute edges, so widths compensate —
//      22/3 ⇒ 7,8,7); floats live inside the pass only;
//    • getComputed* return NaN before the first calculateLayout (the
//      renderer's documented guard);
//    • display:none zeroes the whole subtree;
//    • measure results are cached by constraint key and survive repeated
//      calculateLayout calls until markDirty — measurement writes ONLY the
//      immutable measure cache, never final layout (the historical
//      measure-contamination class is structurally impossible).
// ============================================================================
import { appendFileSync } from 'node:fs'
import {
  type LayoutAlign,
  LayoutDisplay,
  type LayoutEdge,
  type LayoutFlexDirection,
  type LayoutGutter,
  type LayoutJustify,
  type LayoutMeasureFunc,
  LayoutMeasureMode,
  type LayoutNode,
  type LayoutOverflow,
  type LayoutPositionType,
  type LayoutWrap,
} from './node.js'

//
// Values

type DimValue =
  | { unit: 'auto' }
  | { unit: 'point'; value: number }
  | { unit: 'percent'; value: number }

const AUTO: DimValue = { unit: 'auto' }

function resolve(v: DimValue | undefined, basis: number | undefined): number | undefined {
  if (!v || v.unit === 'auto') return undefined
  if (v.unit === 'point') return v.value
  return basis === undefined || Number.isNaN(basis) ? undefined : (v.value * basis) / 100
}

/** A non-finite dimension (Ink passes height={Infinity} meaning
 *  "unconstrained") is treated as auto — the ratified parse pin. */
function pointOrAuto(value: number): DimValue {
  return Number.isFinite(value) ? { unit: 'point', value } : AUTO
}

/** Grid rounding with the public Yoga PixelGrid semantics: snap within 1e-4
 *  of a grid line, then forceCeil/forceFloor, else round half-up. */
function roundGrid(v: number, forceCeil: boolean, forceFloor: boolean): number {
  let frac = v - Math.floor(v)
  if (frac < 0) frac += 1
  if (frac < 0.0001) return Math.floor(v)
  if (frac > 0.9999) return Math.ceil(v)
  if (forceCeil) return Math.ceil(v)
  if (forceFloor) return Math.floor(v)
  return Math.floor(v) + (frac >= 0.4999 ? 1 : 0)
}

function nearWhole(v: number): boolean {
  const frac = v - Math.floor(v)
  return frac < 0.0001 || frac > 0.9999
}

// Per-edge scalar store with the ratified precedence:
// exact edge > start/end > horizontal/vertical > all. (LTR is pinned —
// start=left, end=right.)
type EdgeStore = Partial<Record<LayoutEdge, number>>

function edgeValue(store: EdgeStore, edge: 'left' | 'right' | 'top' | 'bottom'): number {
  if (store[edge] !== undefined) return store[edge]!
  if (edge === 'left' && store.start !== undefined) return store.start
  if (edge === 'right' && store.end !== undefined) return store.end
  const axis = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  if (store[axis] !== undefined) return store[axis]!
  return store.all ?? 0
}

// Position insets keep "defined?" semantics and allow percent.
type InsetStore = Partial<Record<LayoutEdge, DimValue>>

function insetValue(
  store: InsetStore,
  edge: 'left' | 'right' | 'top' | 'bottom',
  basis: number | undefined,
): number | undefined {
  const pick =
    store[edge] ??
    (edge === 'left' ? store.start : edge === 'right' ? store.end : undefined) ??
    store[edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'] ??
    store.all
  return resolve(pick, basis)
}

//
// Profiling counters (parity with the previous engine's diagnostics surface).

let _visited = 0
let _measured = 0
let _cacheHits = 0
let _liveNodes = 0
let _generation = 0

export function getCellLayoutCounters(): {
  visited: number
  measured: number
  cacheHits: number
  live: number
} {
  return { visited: _visited, measured: _measured, cacheHits: _cacheHits, live: _liveNodes }
}

//
// The node

type Axis = 'row' | 'column'

type SizingEntry = {
  availW: number | undefined
  wMode: LayoutMeasureMode
  availH: number | undefined
  hMode: LayoutMeasureMode
  ownerWidth: number | undefined
  ownerHeight: number | undefined
  forceW: boolean
  forceH: boolean
  resultW: number
  resultH: number
}

/** Public canUseCachedMeasurement, one axis. */
function axisReusable(
  mode: LayoutMeasureMode,
  avail: number | undefined,
  lastMode: LayoutMeasureMode,
  lastAvail: number | undefined,
  lastResult: number,
): boolean {
  if (mode === lastMode && avail === lastAvail) return true
  if (mode === 'exactly' && avail !== undefined && lastResult === avail) return true
  if (
    mode === 'at-most' &&
    lastMode === 'undefined' &&
    avail !== undefined &&
    lastResult <= avail
  ) {
    return true
  }
  if (
    mode === 'at-most' &&
    lastMode === 'at-most' &&
    avail !== undefined &&
    lastAvail !== undefined &&
    lastAvail > avail &&
    lastResult <= avail
  ) {
    return true
  }
  return false
}

interface FinalRect {
  left: number
  top: number
  width: number
  height: number
}

export class CellLayoutNode implements LayoutNode {
  // Tree
  private children: CellLayoutNode[] = []
  private parent: CellLayoutNode | null = null

  // Style (Yoga-classic defaults)
  private styleWidth: DimValue = AUTO
  private styleHeight: DimValue = AUTO
  private styleMinWidth: DimValue = AUTO
  private styleMinHeight: DimValue = AUTO
  private styleMaxWidth: DimValue = AUTO
  private styleMaxHeight: DimValue = AUTO
  private flexDirection: LayoutFlexDirection = 'column'
  private flexGrow = 0
  private flexShrink = 0
  private flexBasis: DimValue = AUTO
  private flexWrap: LayoutWrap = 'nowrap'
  private alignItems: LayoutAlign = 'stretch'
  private alignSelf: LayoutAlign = 'auto'
  private justifyContent: LayoutJustify = 'flex-start'
  private display: LayoutDisplay = LayoutDisplay.Flex
  private positionType: LayoutPositionType = 'relative'
  private overflow: LayoutOverflow = 'visible'
  private margin: EdgeStore = {}
  private padding: EdgeStore = {}
  private border: EdgeStore = {}
  private gap: Partial<Record<LayoutGutter, number>> = {}
  private position: InsetStore = {}

  // Measurement — the ONLY thing a measure pass may write. Immutable records
  // keyed by constraint; final layout lives in `final` and is written only by
  // the layout pass.
  private measureFunc: LayoutMeasureFunc | null = null
  private measureCache = new Map<string, { width: number; height: number }>()

  // Subtree-contamination stamp: a measure pass leaves children holding
  // measure-constraint geometry; a layout-pass cache hit THIS generation must
  // recompute instead of skipping (the ratified _measRecGen guard).
  private measRecGen = -1

  // Flex basis cache: same-generation, keyed by the full constraint context
  // (the ratified basis-measurement contract).
  private fbGen = -1
  private fbBasis = 0
  private fbAvailMain: number | undefined
  private fbAvailCross: number | undefined
  private fbCrossExact = false

  // Two-tier result cache (cleared on any subtree dirt), the ratified
  // pass-reuse contract: MEASURE calls may reuse any cached measurement (or
  // the last layout); LAYOUT calls reuse only the LAST LAYOUT entry — that
  // is whose geometry the subtree currently holds (random-15 vs xrandom-103
  // minimals). Reuse follows the public canUseCachedMeasurement rules, per
  // axis: exact constraint equality · exact-request-matches-old-result ·
  // at-most-over-unspecified-still-fits · stricter-at-most-still-valid.
  private measureEntries: SizingEntry[] = []
  private layoutEntry: SizingEntry | null = null

  // Final layout (floats, relative to the parent's border box) + the
  // rounded projection getComputed* serves.
  private final: FinalRect = { left: 0, top: 0, width: 0, height: 0 }
  private rounded: FinalRect = { left: NaN, top: NaN, width: NaN, height: NaN }

  constructor() {
    _liveNodes++
  }

  // -- Tree ------------------------------------------------------------------

  insertChild(child: LayoutNode, index: number): void {
    const c = child as CellLayoutNode
    c.parent = this
    this.children.splice(index, 0, c)
    this.markSubtreeDirty()
  }

  removeChild(child: LayoutNode): void {
    const c = child as CellLayoutNode
    const i = this.children.indexOf(c)
    if (i >= 0) {
      this.children.splice(i, 1)
      c.parent = null
      this.markSubtreeDirty()
    }
  }

  getChildCount(): number {
    return this.children.length
  }

  getParent(): LayoutNode | null {
    return this.parent
  }

  // -- Dirtiness --------------------------------------------------------------

  /** Content changed (measure results stale): clear measure + sizing here,
   *  sizing on every ancestor. */
  markDirty(): void {
    this.measureCache.clear()
    this.markSubtreeDirty()
  }

  /** Structure/style changed: sizing caches along the ancestor chain are
   *  stale; measure caches (pure content) survive. */
  private markSubtreeDirty(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: CellLayoutNode | null = this
    while (node) {
      node.measureEntries.length = 0
      node.layoutEntry = null
      node = node.parent
    }
  }

  // -- Style setters -----------------------------------------------------------

  setWidth(value: number): void {
    this.styleWidth = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setWidthPercent(value: number): void {
    this.styleWidth = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setWidthAuto(): void {
    this.styleWidth = AUTO
    this.markSubtreeDirty()
  }
  setHeight(value: number): void {
    this.styleHeight = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setHeightPercent(value: number): void {
    this.styleHeight = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setHeightAuto(): void {
    this.styleHeight = AUTO
    this.markSubtreeDirty()
  }
  setMinWidth(value: number): void {
    this.styleMinWidth = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setMinWidthPercent(value: number): void {
    this.styleMinWidth = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setMinHeight(value: number): void {
    this.styleMinHeight = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setMinHeightPercent(value: number): void {
    this.styleMinHeight = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setMaxWidth(value: number): void {
    this.styleMaxWidth = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setMaxWidthPercent(value: number): void {
    this.styleMaxWidth = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setMaxHeight(value: number): void {
    this.styleMaxHeight = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setMaxHeightPercent(value: number): void {
    this.styleMaxHeight = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setFlexDirection(dir: LayoutFlexDirection): void {
    this.flexDirection = dir
    this.markSubtreeDirty()
  }
  setFlexGrow(value: number): void {
    this.flexGrow = value
    this.markSubtreeDirty()
  }
  setFlexShrink(value: number): void {
    this.flexShrink = value
    this.markSubtreeDirty()
  }
  setFlexBasis(value: number): void {
    this.flexBasis = pointOrAuto(value)
    this.markSubtreeDirty()
  }
  setFlexBasisPercent(value: number): void {
    this.flexBasis = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setFlexWrap(wrap: LayoutWrap): void {
    this.flexWrap = wrap
    this.markSubtreeDirty()
  }
  setAlignItems(align: LayoutAlign): void {
    this.alignItems = align
    this.markSubtreeDirty()
  }
  setAlignSelf(align: LayoutAlign): void {
    this.alignSelf = align
    this.markSubtreeDirty()
  }
  setJustifyContent(justify: LayoutJustify): void {
    this.justifyContent = justify
    this.markSubtreeDirty()
  }
  setDisplay(display: LayoutDisplay): void {
    this.display = display
    this.markSubtreeDirty()
  }
  getDisplay(): LayoutDisplay {
    return this.display
  }
  setPositionType(type: LayoutPositionType): void {
    this.positionType = type
    this.markSubtreeDirty()
  }
  setPosition(edge: LayoutEdge, value: number): void {
    this.position[edge] = { unit: 'point', value }
    this.markSubtreeDirty()
  }
  setPositionPercent(edge: LayoutEdge, value: number): void {
    this.position[edge] = { unit: 'percent', value }
    this.markSubtreeDirty()
  }
  setOverflow(overflow: LayoutOverflow): void {
    this.overflow = overflow
    this.markSubtreeDirty()
  }
  setMargin(edge: LayoutEdge, value: number): void {
    this.margin[edge] = value
    this.markSubtreeDirty()
  }
  setPadding(edge: LayoutEdge, value: number): void {
    this.padding[edge] = value
    this.markSubtreeDirty()
  }
  setBorder(edge: LayoutEdge, value: number): void {
    this.border[edge] = value
    this.markSubtreeDirty()
  }
  setGap(gutter: LayoutGutter, value: number): void {
    this.gap[gutter] = value
    this.markSubtreeDirty()
  }

  setMeasureFunc(fn: LayoutMeasureFunc): void {
    this.measureFunc = fn
    this.measureCache.clear()
    this.markSubtreeDirty()
  }
  unsetMeasureFunc(): void {
    this.measureFunc = null
    this.measureCache.clear()
    this.markSubtreeDirty()
  }

  // -- Lifecycle ---------------------------------------------------------------

  free(): void {
    if (this.parent) this.parent.removeChild(this)
    _liveNodes = Math.max(0, _liveNodes - 1)
  }
  freeRecursive(): void {
    for (const c of [...this.children]) c.freeRecursive()
    this.free()
  }

  // -- Computed reads ------------------------------------------------------------

  getComputedLeft(): number {
    return this.rounded.left
  }
  getComputedTop(): number {
    return this.rounded.top
  }
  getComputedWidth(): number {
    return this.rounded.width
  }
  getComputedHeight(): number {
    return this.rounded.height
  }
  getComputedBorder(edge: LayoutEdge): number {
    return edgeValue(this.border, edge as 'left' | 'right' | 'top' | 'bottom')
  }
  getComputedPadding(edge: LayoutEdge): number {
    return edgeValue(this.padding, edge as 'left' | 'right' | 'top' | 'bottom')
  }

  // -- Layout entry -----------------------------------------------------------------

  calculateLayout(width?: number, _height?: number): void {
    // The ratified constraint space is width-only; the width param is EXACT
    // at the root (the node's own style width overrides it inside — the
    // standard style-over-avail rule). Height is always content-driven.
    // Root margins offset the root; they never shrink the box.
    _visited = 0
    _measured = 0
    _cacheHits = 0
    _generation++
    const size = this.layoutInternal(
      width,
      width === undefined ? 'undefined' : 'exactly',
      undefined,
      'undefined',
      width,
      undefined,
      true,
    )
    this.final = {
      ...this.final,
      left: edgeValue(this.margin, 'left'),
      top: edgeValue(this.margin, 'top'),
      width: size.width,
      height: size.height,
    }
    this.roundPass(0, 0)
  }

  // -- Internals ----------------------------------------------------------------------

  private mainAxis(): Axis {
    return this.flexDirection === 'row' || this.flexDirection === 'row-reverse'
      ? 'row'
      : 'column'
  }
  private isReverse(): boolean {
    return this.flexDirection === 'row-reverse' || this.flexDirection === 'column-reverse'
  }

  private edgesH(store: EdgeStore): number {
    return edgeValue(store, 'left') + edgeValue(store, 'right')
  }
  private edgesV(store: EdgeStore): number {
    return edgeValue(store, 'top') + edgeValue(store, 'bottom')
  }

  private clampW(v: number, ownerW: number | undefined): number {
    const min = resolve(this.styleMinWidth, ownerW)
    const max = resolve(this.styleMaxWidth, ownerW)
    let out = v
    if (max !== undefined) out = Math.min(out, max)
    if (min !== undefined) out = Math.max(out, min)
    return Math.max(0, out)
  }
  private clampH(v: number, ownerH: number | undefined): number {
    const min = resolve(this.styleMinHeight, ownerH)
    const max = resolve(this.styleMaxHeight, ownerH)
    let out = v
    if (max !== undefined) out = Math.min(out, max)
    if (min !== undefined) out = Math.max(out, min)
    return Math.max(0, out)
  }

  private marginH(): number {
    return this.edgesH(this.margin)
  }
  private marginV(): number {
    return this.edgesV(this.margin)
  }
  private padBorderH(): number {
    return this.edgesH(this.padding) + this.edgesH(this.border)
  }
  private padBorderV(): number {
    return this.edgesV(this.padding) + this.edgesV(this.border)
  }

  private resolvedAlign(parent: CellLayoutNode): LayoutAlign {
    return this.alignSelf === 'auto' ? parent.alignItems : this.alignSelf
  }

  private hasMeasureFuncInSubtree(): boolean {
    if (this.measureFunc) return true
    for (const c of this.children) {
      if (c.hasMeasureFuncInSubtree()) return true
    }
    return false
  }

  /**
   * Size (and optionally lay out) this node — the single layout pass of the
   * ratified architecture. availableWidth/Height constrain the BORDER BOX
   * (margins handled by the caller); a defined style dimension OVERRIDES the
   * incoming constraint unless that axis was FORCED by the parent (the
   * flex-resolved main size); min/max then bound the VALUE, keeping the
   * mode. ownerWidth/ownerHeight are the percent bases. Geometry (children's
   * final rects) is written only when performLayout is true — cache reuse is
   * two-tier (measure entries vs the single layout entry).
   */
  private layoutInternal(
    availableWidth: number | undefined,
    widthMode: LayoutMeasureMode,
    availableHeight: number | undefined,
    heightMode: LayoutMeasureMode,
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    performLayout: boolean,
    forceWidth = false,
    forceHeight = false,
  ): { width: number; height: number } {
    _visited++

    if (this.display === LayoutDisplay.None) {
      this.zeroSubtree()
      return { width: 0, height: 0 }
    }

    // Style dims override the incoming constraint (unless forced), then
    // min/max bound the value.
    if (!forceWidth) {
      const styleW = resolve(this.styleWidth, ownerWidth)
      if (styleW !== undefined) {
        availableWidth = styleW
        widthMode = 'exactly'
      }
    }
    if (!forceHeight) {
      const styleH = resolve(this.styleHeight, ownerHeight)
      if (styleH !== undefined) {
        availableHeight = styleH
        heightMode = 'exactly'
      }
    }
    if (availableWidth !== undefined) {
      availableWidth = this.clampW(availableWidth, ownerWidth)
    }
    if (availableHeight !== undefined) {
      availableHeight = this.clampH(availableHeight, ownerHeight)
    }

    // Cache reuse. A hit restores the cached dimensions into live geometry.
    {
      const reusable = (e: SizingEntry | null): e is SizingEntry =>
        e !== null &&
        e.ownerWidth === ownerWidth &&
        e.ownerHeight === ownerHeight &&
        e.forceW === forceWidth &&
        e.forceH === forceHeight &&
        axisReusable(widthMode, availableWidth, e.wMode, e.availW, e.resultW) &&
        axisReusable(heightMode, availableHeight, e.hMode, e.availH, e.resultH)
      const hit = (e: SizingEntry): { width: number; height: number } => {
        _cacheHits++
        this.final = { ...this.final, width: e.resultW, height: e.resultH }
        if (performLayout) traceContamination(this, e.resultW, e.resultH)
        return { width: e.resultW, height: e.resultH }
      }
      if (
        reusable(this.layoutEntry) &&
        (!performLayout || this.measRecGen !== _generation)
      ) {
        return hit(this.layoutEntry)
      }
      if (!performLayout) {
        for (const e of this.measureEntries) {
          if (reusable(e)) return hit(e)
        }
      }
    }

    let out: { width: number; height: number }
    if (this.measureFunc && this.children.length === 0) {
      // Measure leaf: the func's answer stands under non-exact modes (an
      // at-most bound flows IN as a constraint, never caps the reply); an
      // exact axis is imposed.
      const pbH = this.padBorderH()
      const pbV = this.padBorderV()
      const innerW =
        widthMode === 'undefined' || availableWidth === undefined
          ? undefined
          : Math.max(0, availableWidth - pbH)
      const measured = this.measure(innerW, widthMode)
      out = {
        width:
          widthMode === 'exactly'
            ? availableWidth!
            : this.clampW(measured.width + pbH, ownerWidth),
        height:
          heightMode === 'exactly'
            ? availableHeight!
            : this.clampH(measured.height + pbV, ownerHeight),
      }
    } else if (this.children.length === 0) {
      // Childless plain leaf sizes to padding+border.
      out = {
        width:
          widthMode === 'exactly'
            ? availableWidth!
            : this.clampW(this.padBorderH(), ownerWidth),
        height:
          heightMode === 'exactly'
            ? availableHeight!
            : this.clampH(this.padBorderV(), ownerHeight),
      }
    } else {
      out = this.layoutContainer(
        availableWidth,
        widthMode,
        availableHeight,
        heightMode,
        ownerWidth,
        ownerHeight,
        performLayout,
      )
    }

    this.final = { ...this.final, width: out.width, height: out.height }
    if (this.children.length > 0) {
      this.measRecGen = performLayout ? -1 : _generation
    }
    this.storeSizing(
      availableWidth,
      widthMode,
      availableHeight,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      out,
      performLayout,
    )
    return out
  }

  private storeSizing(
    availW: number | undefined,
    wMode: LayoutMeasureMode,
    availH: number | undefined,
    hMode: LayoutMeasureMode,
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    forceW: boolean,
    forceH: boolean,
    out: { width: number; height: number },
    fromLayout: boolean,
  ): void {
    const entry: SizingEntry = {
      availW,
      wMode,
      availH,
      hMode,
      ownerWidth,
      ownerHeight,
      forceW,
      forceH,
      resultW: out.width,
      resultH: out.height,
    }
    if (fromLayout) {
      this.layoutEntry = entry
    } else {
      if (this.measureEntries.length >= 8) this.measureEntries.shift()
      this.measureEntries.push(entry)
    }
  }

  private measure(
    width: number | undefined,
    mode: LayoutMeasureMode,
  ): { width: number; height: number } {
    const key = `${width}|${mode}`
    const hit = this.measureCache.get(key)
    if (hit) {
      _cacheHits++
      return hit
    }
    _measured++
    const raw = this.measureFunc!(width ?? Number.NaN, mode)
    const result = { width: raw.width, height: raw.height }
    this.measureCache.set(key, result)
    return result
  }

  private zeroSubtree(): void {
    this.final = { left: 0, top: 0, width: 0, height: 0 }
    this.rounded = { left: 0, top: 0, width: 0, height: 0 }
    for (const c of this.children) c.zeroSubtree()
  }

  private mainGap(axis: Axis): number {
    return (axis === 'row' ? this.gap.column : this.gap.row) ?? this.gap.all ?? 0
  }
  private crossGap(axis: Axis): number {
    return (axis === 'row' ? this.gap.row : this.gap.column) ?? this.gap.all ?? 0
  }

  /** The container algorithm — the ratified single-pass flex model:
   *  basis → lines → per-line flex resolution (CSS flexbox §9.7 with partial
   *  factors and violation freezing) → one child layout (forced exact main ×
   *  ruled cross) → content sizing (fit-content; wrap>1-lines fills an
   *  at-most bound; scroll clamps) → positioning + re-stretch. */
  private layoutContainer(
    availW: number | undefined,
    wMode: LayoutMeasureMode,
    availH: number | undefined,
    hMode: LayoutMeasureMode,
    callerOwnerW: number | undefined,
    callerOwnerH: number | undefined,
    performLayout: boolean,
  ): { width: number; height: number } {
    const axis = this.mainAxis()
    const row = axis === 'row'
    const pbH = this.padBorderH()
    const pbV = this.padBorderV()
    const mainSize = row ? availW : availH
    const crossSize = row ? availH : availW
    const mainMode = row ? wMode : hMode
    const crossMode = row ? hMode : wMode
    const mainPB = row ? pbH : pbV
    const crossPB = row ? pbV : pbH
    const innerMain = mainSize !== undefined ? Math.max(0, mainSize - mainPB) : undefined
    const innerCross = crossSize !== undefined ? Math.max(0, crossSize - crossPB) : undefined

    // Children's percent bases: this node's incoming values — an indefinite
    // axis keeps child percents indefinite (never the grandparent's size).
    const ownerW = availW
    const ownerH = availH

    const mainGap = this.mainGap(axis)
    const crossGap = this.crossGap(axis)
    const isWrapStyle = this.flexWrap !== 'nowrap'

    const flow = this.children.filter(
      c => c.positionType !== 'absolute' && c.display !== LayoutDisplay.None,
    )
    const absolutes = this.children.filter(
      c => c.positionType === 'absolute' && c.display !== LayoutDisplay.None,
    )

    const clampMain = (c: CellLayoutNode, v: number) =>
      row ? c.clampW(v, ownerW) : c.clampH(v, ownerH)
    const mainMarginOf = (c: CellLayoutNode) => (row ? c.marginH() : c.marginV())
    const crossMarginOf = (c: CellLayoutNode) => (row ? c.marginV() : c.marginH())

    type Item = {
      node: CellLayoutNode
      basis: number
      mainMargin: number
      crossMargin: number
      targetMain: number
      crossSize: number
    }

    // Flex basis per child (the ratified basis-measurement contract):
    //   1. explicit flexBasis resolves against the AVAILABLE inner main;
    //   2. else the child's main-axis style dimension (vs the owner);
    //   3. else MEASURE: main = at-most(innerMain) ONLY when the main axis
    //      is ROW and the child's subtree contains a measure func (height is
    //      never constrained during basis measurement); cross = the child's
    //      style (exact), else exact(innerCross) for stretch children under
    //      an exact cross, else at-most(innerCross), else undefined.
    const crossIsExact = crossMode === 'exactly'
    const items: Item[] = flow.map(child => {
      const mk = (basis: number): Item => ({
        node: child,
        basis,
        mainMargin: mainMarginOf(child),
        crossMargin: crossMarginOf(child),
        targetMain: basis,
        crossSize: 0,
      })
      if (
        child.fbGen === _generation &&
        child.fbAvailMain === innerMain &&
        child.fbAvailCross === innerCross &&
        child.fbCrossExact === crossIsExact
      ) {
        return mk(child.fbBasis)
      }
      let basis = resolve(child.flexBasis, innerMain)
      if (basis !== undefined) {
        basis = Math.max(0, basis)
      } else {
        basis = row
          ? resolve(child.styleWidth, ownerW)
          : resolve(child.styleHeight, ownerH)
        if (basis !== undefined) basis = Math.max(0, basis)
      }
      if (basis === undefined) {
        const mainConstrained =
          row && innerMain !== undefined && child.hasMeasureFuncInSubtree()
        const mainAvail = mainConstrained ? innerMain : undefined
        const mainModeB: LayoutMeasureMode = mainConstrained ? 'at-most' : 'undefined'
        let crossAvail: number | undefined
        let crossModeB: LayoutMeasureMode
        const crossStyle = row
          ? resolve(child.styleHeight, ownerH)
          : resolve(child.styleWidth, ownerW)
        if (crossStyle !== undefined) {
          crossAvail = Math.max(0, crossStyle)
          crossModeB = 'exactly'
        } else if (innerCross !== undefined) {
          // The child's cross margins come OUT of its available cross space,
          // exactly as the final per-line layout hands it (childCross =
          // innerCross - crossMargin below). Measuring the basis at the
          // UNREDUCED cross let a margined child's wrapping text measure
          // wider than it would render: the un-wrapped (shorter) basis then
          // starved the forced main size and the shrink cascade dropped the
          // box's first row at paint (the apollo review card @80 — the
          // faces harness is the regression pin).
          crossAvail = Math.max(0, innerCross - crossMarginOf(child))
          crossModeB =
            crossIsExact && child.resolvedAlign(this) === 'stretch'
              ? 'exactly'
              : 'at-most'
        } else {
          crossAvail = undefined
          crossModeB = 'undefined'
        }
        const size = child.layoutInternal(
          row ? mainAvail : crossAvail,
          row ? mainModeB : crossModeB,
          row ? crossAvail : mainAvail,
          row ? crossModeB : mainModeB,
          ownerW,
          ownerH,
          false,
        )
        basis = row ? size.width : size.height
      }
      child.fbGen = _generation
      child.fbBasis = basis
      child.fbAvailMain = innerMain
      child.fbAvailCross = innerCross
      child.fbCrossExact = crossIsExact
      return mk(basis)
    })

    // Lines: split on the min/max-clamped hypothetical main size.
    const lines: Item[][] = []
    if (!isWrapStyle || innerMain === undefined) {
      if (items.length > 0) lines.push(items)
    } else {
      let line: Item[] = []
      let lineLen = 0
      for (const item of items) {
        const hypo = Math.max(0, clampMain(item.node, item.basis))
        const outer = hypo + item.mainMargin
        const withGap = line.length > 0 ? outer + mainGap : outer
        if (line.length > 0 && lineLen + withGap > innerMain + 1e-9) {
          lines.push(line)
          line = [item]
          lineLen = outer
        } else {
          line.push(item)
          lineLen += withGap
        }
      }
      if (line.length > 0) lines.push(line)
    }

    // Per line: resolve flexible lengths (CSS flexbox §9.7: partial flex factors,
    // violation-based freezing) and lay each child out once.
    const lineCrossSizes: number[] = []
    const lineConsumedMain: number[] = []
    let maxLineMain = 0
    for (const line of lines) {
      const gaps = mainGap * Math.max(0, line.length - 1)
      const lineBasis =
        line.reduce((s, i) => s + i.basis + i.mainMargin, 0) + gaps

      // Flex bound: the inner main; an indefinite container flexes against
      // its own min/max main when the basis total violates them.
      let flexAvail = innerMain
      if (flexAvail === undefined) {
        const mainOwner = row ? callerOwnerW : callerOwnerH
        const maxM = resolve(row ? this.styleMaxWidth : this.styleMaxHeight, mainOwner)
        const minM = resolve(row ? this.styleMinWidth : this.styleMinHeight, mainOwner)
        if (maxM !== undefined && lineBasis > maxM - mainPB) {
          flexAvail = Math.max(0, maxM - mainPB)
        } else if (minM !== undefined && lineBasis < minM - mainPB) {
          flexAvail = Math.max(0, minM - mainPB)
        }
      }
      this.resolveFlexibleLengths(line, flexAvail, lineBasis, clampMain)

      // Lay out each child: forced exact main × ruled cross.
      let lineCross = 0
      let consumed = gaps
      for (const item of line) {
        const child = item.node
        const align = child.resolvedAlign(this)
        const crossStyleResolved = row
          ? resolve(child.styleHeight, ownerH)
          : resolve(child.styleWidth, ownerW)
        let childCross: number | undefined
        let childCrossMode: LayoutMeasureMode = 'undefined'
        if (crossStyleResolved !== undefined) {
          childCross = crossStyleResolved
          childCrossMode = 'exactly'
        } else if (
          align === 'stretch' &&
          !isWrapStyle &&
          innerCross !== undefined &&
          crossMode === 'exactly'
        ) {
          childCross = Math.max(0, innerCross - item.crossMargin)
          childCrossMode = 'exactly'
        } else if (!isWrapStyle && innerCross !== undefined) {
          childCross = Math.max(0, innerCross - item.crossMargin)
          childCrossMode = 'at-most'
        }
        const size = child.layoutInternal(
          row ? item.targetMain : childCross,
          row ? 'exactly' : childCrossMode,
          row ? childCross : item.targetMain,
          row ? childCrossMode : 'exactly',
          ownerW,
          ownerH,
          performLayout,
          row,
          !row,
        )
        item.crossSize = row ? size.height : size.width
        lineCross = Math.max(lineCross, item.crossSize + item.crossMargin)
        consumed += item.targetMain + item.mainMargin
      }
      lineCrossSizes.push(lineCross)
      lineConsumedMain.push(consumed)
      maxLineMain = Math.max(maxLineMain, consumed)
    }
    const totalLinesCross =
      lineCrossSizes.reduce((s, c) => s + c, 0) +
      crossGap * Math.max(0, lines.length - 1)

    // Container dimensions: fit-content (an at-most bound is NOT a hard
    // clamp) — except scroll overflow clamps, and a wrap container that
    // actually broke into multiple lines under an at-most main FILLS it.
    const isScroll = this.overflow === 'scroll'
    const contentMain = maxLineMain + mainPB
    const finalMain =
      mainMode === 'exactly'
        ? mainSize!
        : mainMode === 'at-most' && isScroll
          ? Math.max(Math.min(mainSize!, contentMain), mainPB)
          : isWrapStyle && lines.length > 1 && mainMode === 'at-most'
            ? mainSize!
            : contentMain
    const contentCross = totalLinesCross + crossPB
    const finalCross =
      crossMode === 'exactly'
        ? crossSize!
        : crossMode === 'at-most' && isScroll
          ? Math.max(Math.min(crossSize!, contentCross), crossPB)
          : contentCross
    const outW = this.clampW(row ? finalMain : finalCross, callerOwnerW)
    const outH = this.clampH(row ? finalCross : finalMain, callerOwnerH)

    if (!performLayout) return { width: outW, height: outH }

    // -- Positioning ---------------------------------------------------------

    const actualInnerMain = (row ? outW : outH) - mainPB
    const actualInnerCross = (row ? outH : outW) - crossPB
    const mainLeadPB = row
      ? edgeValue(this.padding, 'left') + edgeValue(this.border, 'left')
      : edgeValue(this.padding, 'top') + edgeValue(this.border, 'top')
    const crossLeadPB = row
      ? edgeValue(this.padding, 'top') + edgeValue(this.border, 'top')
      : edgeValue(this.padding, 'left') + edgeValue(this.border, 'left')
    const reversed = this.isReverse()
    const mainContainerSize = row ? outW : outH
    const crossContainerSize = row ? outH : outW
    const wrapReverse = this.flexWrap === 'wrap-reverse'

    // Single-line nowrap: the one line spans the actual inner cross.
    if (lines.length === 1 && !isWrapStyle) {
      lineCrossSizes[0] = actualInnerCross
    }

    // Re-stretch once line crosses are known — needed for wrap lines and for
    // containers whose cross was not exact during the child pass.
    if (isWrapStyle || crossMode !== 'exactly') {
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!
        const lineCross = lineCrossSizes[li]!
        for (const item of line) {
          const child = item.node
          const align = child.resolvedAlign(this)
          const crossStyleResolved = row
            ? resolve(child.styleHeight, ownerH)
            : resolve(child.styleWidth, ownerW)
          if (align !== 'stretch' || crossStyleResolved !== undefined) continue
          const target = Math.max(0, lineCross - item.crossMargin)
          if (item.crossSize === target) continue
          child.layoutInternal(
            row ? item.targetMain : target,
            'exactly',
            row ? target : item.targetMain,
            'exactly',
            ownerW,
            ownerH,
            performLayout,
            row,
            !row,
          )
          item.crossSize = target
        }
      }
    }

    let lineCrossPos = crossLeadPB
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!
      const lineCross = lineCrossSizes[li]!
      const consumedMain = lineConsumedMain[li]!
      const freeMain = actualInnerMain - consumedMain
      const remainingMain = Math.max(0, freeMain)
      let mainOffset = mainLeadPB
      let betweenMain = mainGap
      switch (this.justifyContent) {
        case 'flex-start':
          break
        case 'center':
          mainOffset += freeMain / 2
          break
        case 'flex-end':
          mainOffset += freeMain
          break
        case 'space-between':
          if (line.length > 1) betweenMain += remainingMain / (line.length - 1)
          break
        case 'space-around':
          if (line.length > 0) {
            betweenMain += remainingMain / line.length
            mainOffset += remainingMain / line.length / 2
          }
          break
        case 'space-evenly':
          if (line.length > 0) {
            betweenMain += remainingMain / (line.length + 1)
            mainOffset += remainingMain / (line.length + 1)
          }
          break
      }

      const effectiveLineCrossPos = wrapReverse
        ? crossContainerSize - lineCrossPos - lineCross
        : lineCrossPos

      let pos = mainOffset
      for (const item of line) {
        const child = item.node
        const mMainLead = row
          ? edgeValue(child.margin, 'left')
          : edgeValue(child.margin, 'top')
        const mMainTrail = row
          ? edgeValue(child.margin, 'right')
          : edgeValue(child.margin, 'bottom')
        const mCrossLead = row
          ? edgeValue(child.margin, 'top')
          : edgeValue(child.margin, 'left')

        const mainPos = reversed
          ? mainContainerSize - (pos + mMainLead) - item.targetMain
          : pos + mMainLead

        const align = child.resolvedAlign(this)
        let crossPos = effectiveLineCrossPos + mCrossLead
        const crossFree = lineCross - item.crossSize - item.crossMargin
        switch (align) {
          case 'flex-start':
          case 'stretch':
            if (wrapReverse) crossPos += crossFree
            break
          case 'center':
            crossPos += crossFree / 2
            break
          case 'flex-end':
            if (!wrapReverse) crossPos += crossFree
            break
          default:
            // A literal 'auto' resolution behaves as unflipped flex-start.
            break
        }

        // Relative-position offsets (left/top positive; right/bottom
        // negative fallbacks).
        let relX = 0
        let relY = 0
        if (child.positionType === 'relative') {
          const l = insetValue(child.position, 'left', outW)
          const r = insetValue(child.position, 'right', outW)
          const t = insetValue(child.position, 'top', outH)
          const b = insetValue(child.position, 'bottom', outH)
          relX = l !== undefined ? l : r !== undefined ? -r : 0
          relY = t !== undefined ? t : b !== undefined ? -b : 0
        }

        if (row) {
          child.final = { ...child.final, left: mainPos + relX, top: crossPos + relY }
        } else {
          child.final = { ...child.final, left: crossPos + relX, top: mainPos + relY }
        }
        pos += mMainLead + item.targetMain + mMainTrail + betweenMain
      }

      lineCrossPos += lineCross + crossGap
    }

    // Absolute children.
    for (const abs of absolutes) {
      this.layoutAbsoluteChild(abs, outW, outH)
    }

    return { width: outW, height: outH }
  }

  /** CSS flexbox §9.7 "Resolving Flexible Lengths" — the ratified variant:
   *  inflexible items freeze at their clamped basis; free space derives from
   *  the INITIAL free minus what frozen items consumed beyond their bases;
   *  partial (<1) flex-factor sums scale the distributed space; min/max
   *  violators freeze by the sign of the total violation. */
  private resolveFlexibleLengths(
    line: Array<{ node: CellLayoutNode; basis: number; targetMain: number }>,
    flexAvail: number | undefined,
    lineBasis: number,
    clampMain: (c: CellLayoutNode, v: number) => number,
  ): void {
    const n = line.length
    const frozen: boolean[] = new Array(n).fill(false)
    const initialFree = flexAvail !== undefined ? flexAvail - lineBasis : 0
    for (let i = 0; i < n; i++) {
      const item = line[i]!
      const inflexible =
        flexAvail === undefined ||
        (initialFree >= 0 ? item.node.flexGrow === 0 : item.node.flexShrink === 0)
      if (inflexible) {
        item.targetMain = Math.max(0, clampMain(item.node, item.basis))
        frozen[i] = true
      } else {
        item.targetMain = item.basis
      }
    }
    const unclamped: number[] = new Array(n)
    for (let iter = 0; iter <= n; iter++) {
      let frozenDelta = 0
      let totalGrow = 0
      let totalShrinkScaled = 0
      let unfrozenCount = 0
      for (let i = 0; i < n; i++) {
        const item = line[i]!
        if (frozen[i]) {
          frozenDelta += item.targetMain - item.basis
        } else {
          totalGrow += item.node.flexGrow
          totalShrinkScaled += item.node.flexShrink * item.basis
          unfrozenCount++
        }
      }
      if (unfrozenCount === 0) break
      let remaining = initialFree - frozenDelta
      if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
        const scaled = initialFree * totalGrow
        if (scaled < remaining) remaining = scaled
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        let totalShrink = 0
        for (let i = 0; i < n; i++) {
          if (!frozen[i]) totalShrink += line[i]!.node.flexShrink
        }
        if (totalShrink < 1) {
          const scaled = initialFree * totalShrink
          if (scaled > remaining) remaining = scaled
        }
      }
      let totalViolation = 0
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue
        const item = line[i]!
        let t = item.basis
        if (remaining > 0 && totalGrow > 0) {
          t += (remaining * item.node.flexGrow) / totalGrow
        } else if (remaining < 0 && totalShrinkScaled > 0) {
          t += (remaining * (item.node.flexShrink * item.basis)) / totalShrinkScaled
        }
        unclamped[i] = t
        const clamped = Math.max(0, clampMain(item.node, t))
        item.targetMain = clamped
        totalViolation += clamped - t
      }
      if (totalViolation === 0) break
      let anyFrozen = false
      for (let i = 0; i < n; i++) {
        if (frozen[i]) continue
        const v = line[i]!.targetMain - unclamped[i]!
        if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
          frozen[i] = true
          anyFrozen = true
        }
      }
      if (!anyFrozen) break
    }
  }

  private layoutAbsoluteChild(child: CellLayoutNode, outW: number, outH: number): void {
    const bl = edgeValue(this.border, 'left')
    const br = edgeValue(this.border, 'right')
    const bt = edgeValue(this.border, 'top')
    const bb = edgeValue(this.border, 'bottom')

    // Percent bases for an absolute child resolve against the container's
    // border-INNER box (borders subtracted, padding not — probed pin,
    // random-40 minimal: 99% of a bordered 20 ⇒ 18).
    const innerW = outW - bl - br
    const innerH = outH - bt - bb
    const left = insetValue(child.position, 'left', innerW)
    const right = insetValue(child.position, 'right', innerW)
    const top = insetValue(child.position, 'top', innerH)
    const bottom = insetValue(child.position, 'bottom', innerH)

    let w = resolve(child.styleWidth, innerW)
    let h = resolve(child.styleHeight, innerH)
    if (w === undefined && left !== undefined && right !== undefined) {
      w = Math.max(0, outW - bl - br - left - right - child.marginH())
    }
    if (h === undefined && top !== undefined && bottom !== undefined) {
      h = Math.max(0, outH - bt - bb - top - bottom - child.marginV())
    }
    if (w !== undefined) w = child.clampW(w, innerW)
    if (h !== undefined) h = child.clampH(h, innerH)

    // Auto-sized axes of an absolute child are MAX-CONTENT — measured under
    // undefined constraints, never wrapped by the container (probed pin,
    // random-40 minimal).
    const size = child.layoutInternal(
      w,
      w !== undefined ? 'exactly' : 'undefined',
      h,
      h !== undefined ? 'exactly' : 'undefined',
      outW,
      outH,
      true,
      w !== undefined,
      h !== undefined,
    )

    let x: number
    if (left !== undefined) {
      x = bl + left + edgeValue(child.margin, 'left')
    } else if (right !== undefined) {
      x = outW - br - right - size.width - edgeValue(child.margin, 'right')
    } else {
      x =
        edgeValue(this.padding, 'left') +
        bl +
        edgeValue(child.margin, 'left')
    }
    let y: number
    if (top !== undefined) {
      y = bt + top + edgeValue(child.margin, 'top')
    } else if (bottom !== undefined) {
      y = outH - bb - bottom - size.height - edgeValue(child.margin, 'bottom')
    } else {
      y =
        edgeValue(this.padding, 'top') +
        bt +
        edgeValue(child.margin, 'top')
    }
    child.final = { left: x, top: y, width: size.width, height: size.height }
  }

  /** Pixel-grid rounding (the ratified pin — Yoga's public PixelGrid rule):
   *  POSITIONS round the RELATIVE offset (text nodes floor it, so wrapped
   *  text never starts past its column); DIMENSIONS derive from rounded
   *  absolute edges so adjacent spans compensate (22/3 ⇒ 7,8,7; text width
   *  ceils when fractional / floors when integral). Values within 1e-4 of a
   *  grid line snap to it; the half rounds up. Recursion carries UNROUNDED
   *  float absolutes. */
  private roundPass(parentAbsLeft: number, parentAbsTop: number): void {
    const absLeft = parentAbsLeft + this.final.left
    const absTop = parentAbsTop + this.final.top
    const text = this.measureFunc !== null
    const fracW = !nearWhole(this.final.width)
    const fracH = !nearWhole(this.final.height)
    this.rounded = {
      left: roundGrid(this.final.left, false, text),
      top: roundGrid(this.final.top, false, text),
      width:
        roundGrid(absLeft + this.final.width, text && fracW, text && !fracW) -
        roundGrid(absLeft, false, text),
      height:
        roundGrid(absTop + this.final.height, text && fracH, text && !fracH) -
        roundGrid(absTop, false, text),
    }
    for (const c of this.children) c.roundPass(absLeft, absTop)
  }
}

export function createCellLayoutNode(): LayoutNode {
  return new CellLayoutNode()
}

//
// Forensics (INK_YOGA_TRACE=<path>, the historical env name): observe the
// skip-with-contaminated-children invariant directly — a layout-pass cache
// hit that restores a node whose live CHILD geometry is wider/taller than the
// restored box logs one JSONL event. The standing ui prover
// (render-idle-lane-stability) asserts zero events on the idle Helm home.
// Free when the env is unset.

let _traceFile: string | undefined | null = null
function traceContamination(node: CellLayoutNode, w: number, h: number): void {
  if (_traceFile === null) {
    _traceFile =
      typeof process !== 'undefined' ? process.env['INK_YOGA_TRACE'] : undefined
  }
  if (!_traceFile) return
  const n = node as unknown as {
    children: Array<{ final: { left: number; top: number; width: number; height: number } }>
  }
  for (const c of n.children) {
    if (c.final.left + c.final.width > w + 1e-6 || c.final.top + c.final.height > h + 1e-6) {
      // Overflow alone is legal (fit-content); contamination is a child
      // EXCEEDING the restored box after a skip. Log for the prover to judge
      // against its composed-frame evidence.
      try {
        appendFileSync(
          _traceFile,
          JSON.stringify({
            kind: 'skip-restore',
            restored: { w, h },
            child: c.final,
          }) + '\n',
        )
      } catch {
        // forensics never break layout
      }
      break
    }
  }
}
