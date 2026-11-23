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
import { AUTO, type DimValue, type EdgeStore, edgeValue, type InsetStore, insetValue, pointOrAuto, resolve } from './cellLayout/values.js'
import { clampH, clampW, crossGapOf, hasMeasureFuncInSubtree, isReverse, mainAxis, mainGapOf, marginH, marginV, padBorderH, padBorderV, resolvedAlign } from './cellLayout/box.js'
import { axisReusable, markSubtreeDirty, type SizingEntry, storeSizing, zeroSubtree } from './cellLayout/sizing.js'
import { resolveFlexibleLengths } from './cellLayout/flex.js'
import { type FinalRect, roundPass } from './cellLayout/rounding.js'
import { passedOver } from '../../utils/passedOver.js'
import { hostEnv } from '../../utils/hostEnv.js'

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

class CellLayoutNode implements LayoutNode {
  children: CellLayoutNode[] = []
  parent: CellLayoutNode | null = null

  styleWidth: DimValue = AUTO
  styleHeight: DimValue = AUTO
  styleMinWidth: DimValue = AUTO
  styleMinHeight: DimValue = AUTO
  styleMaxWidth: DimValue = AUTO
  styleMaxHeight: DimValue = AUTO
  flexDirection: LayoutFlexDirection = 'column'
  flexGrow = 0
  flexShrink = 0
  flexBasis: DimValue = AUTO
  flexWrap: LayoutWrap = 'nowrap'
  alignItems: LayoutAlign = 'stretch'
  alignSelf: LayoutAlign = 'auto'
  justifyContent: LayoutJustify = 'flex-start'
  display: LayoutDisplay = LayoutDisplay.Flex
  positionType: LayoutPositionType = 'relative'
  overflow: LayoutOverflow = 'visible'
  margin: EdgeStore = {}
  padding: EdgeStore = {}
  border: EdgeStore = {}
  gap: Partial<Record<LayoutGutter, number>> = {}
  position: InsetStore = {}

  measureFunc: LayoutMeasureFunc | null = null
  measureCache = new Map<string, { width: number; height: number }>()

  measRecGen = -1

  fbGen = -1
  fbBasis = 0
  fbAvailMain: number | undefined
  fbAvailCross: number | undefined
  fbCrossExact = false

  measureEntries: SizingEntry[] = []
  layoutEntry: SizingEntry | null = null

  final: FinalRect = { left: 0, top: 0, width: 0, height: 0 }
  rounded: FinalRect = { left: NaN, top: NaN, width: NaN, height: NaN }

  constructor() {
    _liveNodes++
  }


  insertChild(child: LayoutNode, index: number): void {
    const node = child as CellLayoutNode
    node.parent = this
    this.children.splice(index, 0, node)
    markSubtreeDirty(this)
  }

  removeChild(child: LayoutNode): void {
    const node = child as CellLayoutNode
    const at = this.children.indexOf(node)
    if (at < 0) return
    this.children.splice(at, 1)
    node.parent = null
    markSubtreeDirty(this)
  }

  getChildCount(): number {
    return this.children.length
  }

  getParent(): LayoutNode | null {
    return this.parent
  }


  markDirty(): void {
    this.measureCache.clear()
    markSubtreeDirty(this)
  }


  setWidth(value: number): void {
    this.styleWidth = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setWidthPercent(value: number): void {
    this.styleWidth = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setWidthAuto(): void {
    this.styleWidth = AUTO
    markSubtreeDirty(this)
  }
  setHeight(value: number): void {
    this.styleHeight = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setHeightPercent(value: number): void {
    this.styleHeight = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setHeightAuto(): void {
    this.styleHeight = AUTO
    markSubtreeDirty(this)
  }
  setMinWidth(value: number): void {
    this.styleMinWidth = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setMinWidthPercent(value: number): void {
    this.styleMinWidth = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setMinHeight(value: number): void {
    this.styleMinHeight = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setMinHeightPercent(value: number): void {
    this.styleMinHeight = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setMaxWidth(value: number): void {
    this.styleMaxWidth = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setMaxWidthPercent(value: number): void {
    this.styleMaxWidth = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setMaxHeight(value: number): void {
    this.styleMaxHeight = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setMaxHeightPercent(value: number): void {
    this.styleMaxHeight = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setFlexDirection(dir: LayoutFlexDirection): void {
    this.flexDirection = dir
    markSubtreeDirty(this)
  }
  setFlexGrow(value: number): void {
    this.flexGrow = value
    markSubtreeDirty(this)
  }
  setFlexShrink(value: number): void {
    this.flexShrink = value
    markSubtreeDirty(this)
  }
  setFlexBasis(value: number): void {
    this.flexBasis = pointOrAuto(value)
    markSubtreeDirty(this)
  }
  setFlexBasisPercent(value: number): void {
    this.flexBasis = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setFlexWrap(wrap: LayoutWrap): void {
    this.flexWrap = wrap
    markSubtreeDirty(this)
  }
  setAlignItems(align: LayoutAlign): void {
    this.alignItems = align
    markSubtreeDirty(this)
  }
  setAlignSelf(align: LayoutAlign): void {
    this.alignSelf = align
    markSubtreeDirty(this)
  }
  setJustifyContent(justify: LayoutJustify): void {
    this.justifyContent = justify
    markSubtreeDirty(this)
  }
  setDisplay(display: LayoutDisplay): void {
    this.display = display
    if (display === LayoutDisplay.None) zeroSubtree(this)
    markSubtreeDirty(this)
  }
  getDisplay(): LayoutDisplay {
    return this.display
  }
  setPositionType(type: LayoutPositionType): void {
    this.positionType = type
    markSubtreeDirty(this)
  }
  setPosition(edge: LayoutEdge, value: number): void {
    this.position[edge] = { unit: 'point', value }
    markSubtreeDirty(this)
  }
  setPositionPercent(edge: LayoutEdge, value: number): void {
    this.position[edge] = { unit: 'percent', value }
    markSubtreeDirty(this)
  }
  setOverflow(overflow: LayoutOverflow): void {
    this.overflow = overflow
    markSubtreeDirty(this)
  }
  setMargin(edge: LayoutEdge, value: number): void {
    this.margin[edge] = value
    markSubtreeDirty(this)
  }
  setPadding(edge: LayoutEdge, value: number): void {
    this.padding[edge] = value
    markSubtreeDirty(this)
  }
  setBorder(edge: LayoutEdge, value: number): void {
    this.border[edge] = value
    markSubtreeDirty(this)
  }
  setGap(gutter: LayoutGutter, value: number): void {
    this.gap[gutter] = value
    markSubtreeDirty(this)
  }

  setMeasureFunc(fn: LayoutMeasureFunc): void {
    this.measureFunc = fn
    this.measureCache.clear()
    markSubtreeDirty(this)
  }
  unsetMeasureFunc(): void {
    this.measureFunc = null
    this.measureCache.clear()
    markSubtreeDirty(this)
  }


  free(): void {
    if (this.parent) this.parent.removeChild(this)
    _liveNodes = Math.max(0, _liveNodes - 1)
  }
  freeRecursive(): void {
    for (const child of [...this.children]) child.freeRecursive()
    this.free()
  }


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
    return edgeValue(this.border, edge as Side)
  }
  getComputedPadding(edge: LayoutEdge): number {
    return edgeValue(this.padding, edge as Side)
  }


  calculateLayout(width?: number, _height?: number): void {
    _visited = 0
    _measured = 0
    _cacheHits = 0
    _generation++
    const out = layoutInternal(this, width, width === undefined ? 'undefined' : 'exactly', undefined, 'undefined', width, undefined, true)
    this.final = { left: edgeValue(this.margin, 'left'), top: edgeValue(this.margin, 'top'), width: out.width, height: out.height }
    roundPass(this, 0, 0)
  }
}

type Side = Parameters<typeof edgeValue>[1]

function layoutInternal(
  self: CellLayoutNode,
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

  if (self.display === LayoutDisplay.None) {
    zeroSubtree(self)
    return { width: 0, height: 0 }
  }

  if (!forceWidth) {
    const styleW = resolve(self.styleWidth, ownerWidth)
    if (styleW !== undefined) {
      availableWidth = styleW
      widthMode = 'exactly'
    }
  }
  if (!forceHeight) {
    const styleH = resolve(self.styleHeight, ownerHeight)
    if (styleH !== undefined) {
      availableHeight = styleH
      heightMode = 'exactly'
    }
  }
  if (availableWidth !== undefined) {
    availableWidth = clampW(self, availableWidth, ownerWidth)
  }
  if (availableHeight !== undefined) {
    availableHeight = clampH(self, availableHeight, ownerHeight)
  }

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
      self.final = { ...self.final, width: e.resultW, height: e.resultH }
      if (performLayout) traceContamination(self, e.resultW, e.resultH)
      return { width: e.resultW, height: e.resultH }
    }
    if (
      reusable(self.layoutEntry) &&
      (!performLayout || self.measRecGen !== _generation)
    ) {
      return hit(self.layoutEntry)
    }
    if (!performLayout) {
      for (const e of self.measureEntries) {
        if (reusable(e)) return hit(e)
      }
    }
  }

  let out: { width: number; height: number }
  if (self.measureFunc && self.children.length === 0) {
    const pbH = padBorderH(self)
    const pbV = padBorderV(self)
    const innerW =
      widthMode === 'undefined' || availableWidth === undefined
        ? undefined
        : Math.max(0, availableWidth - pbH)
    const measured = measure(self, innerW, widthMode)
    out = {
      width:
        widthMode === 'exactly'
          ? availableWidth!
          : clampW(self, measured.width + pbH, ownerWidth),
      height:
        heightMode === 'exactly'
          ? availableHeight!
          : clampH(self, measured.height + pbV, ownerHeight),
    }
  } else if (self.children.length === 0) {
    out = {
      width:
        widthMode === 'exactly'
          ? availableWidth!
          : clampW(self, padBorderH(self), ownerWidth),
      height:
        heightMode === 'exactly'
          ? availableHeight!
          : clampH(self, padBorderV(self), ownerHeight),
    }
  } else {
    out = layoutContainer(
      self,
      availableWidth,
      widthMode,
      availableHeight,
      heightMode,
      ownerWidth,
      ownerHeight,
      performLayout,
    )
  }

  self.final = { ...self.final, width: out.width, height: out.height }
  if (self.children.length > 0) {
    self.measRecGen = performLayout ? -1 : _generation
  }
  storeSizing(
    self,
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

function measure(
  self: CellLayoutNode,
  width: number | undefined,
  mode: LayoutMeasureMode,
): { width: number; height: number } {
  const key = `${width}|${mode}`
  const hit = self.measureCache.get(key)
  if (hit) {
    _cacheHits++
    return hit
  }
  _measured++
  const raw = self.measureFunc!(width ?? Number.NaN, mode)
  const result = { width: raw.width, height: raw.height }
  self.measureCache.set(key, result)
  return result
}

type Item = {
  node: CellLayoutNode
  basis: number
  mainMargin: number
  crossMargin: number
  targetMain: number
  crossSize: number
}

type Flow = {
  self: CellLayoutNode
  row: boolean
  ownerW: number | undefined
  ownerH: number | undefined
  mainInner: number | undefined
  crossInner: number | undefined
  crossExact: boolean
  wraps: boolean
  gapMain: number
  gapCross: number
}

type Line = { items: Item[]; used: number; cross: number }

type Offer = [size: number | undefined, mode: LayoutMeasureMode]

const styledMain = (flow: Flow, child: CellLayoutNode): number | undefined => (flow.row ? resolve(child.styleWidth, flow.ownerW) : resolve(child.styleHeight, flow.ownerH))
const styledCross = (flow: Flow, child: CellLayoutNode): number | undefined => (flow.row ? resolve(child.styleHeight, flow.ownerH) : resolve(child.styleWidth, flow.ownerW))
const clampMain = (flow: Flow, child: CellLayoutNode, size: number): number => (flow.row ? clampW(child, size, flow.ownerW) : clampH(child, size, flow.ownerH))

function askChild(flow: Flow, child: CellLayoutNode, main: Offer, cross: Offer, performLayout: boolean, forceMain: boolean): { main: number; cross: number } {
  if (flow.row) {
    const out = layoutInternal(child, main[0], main[1], cross[0], cross[1], flow.ownerW, flow.ownerH, performLayout, forceMain, false)
    return { main: out.width, cross: out.height }
  }
  const out = layoutInternal(child, cross[0], cross[1], main[0], main[1], flow.ownerW, flow.ownerH, performLayout, false, forceMain)
  return { main: out.height, cross: out.width }
}

function crossOffer(flow: Flow, item: Item, forBasis: boolean): Offer {
  const styled = styledCross(flow, item.node)
  if (styled !== undefined) return [forBasis ? Math.max(0, styled) : styled, 'exactly']
  if (flow.crossInner === undefined || (!forBasis && flow.wraps)) return [undefined, 'undefined']
  const stretched = flow.crossExact && resolvedAlign(item.node, flow.self) === 'stretch'
  return [Math.max(0, flow.crossInner - item.crossMargin), stretched ? 'exactly' : 'at-most']
}

function basisOf(flow: Flow, item: Item): number {
  const child = item.node
  if (child.fbGen === _generation && child.fbAvailMain === flow.mainInner && child.fbAvailCross === flow.crossInner && child.fbCrossExact === flow.crossExact) return child.fbBasis
  const styled = resolve(child.flexBasis, flow.mainInner) ?? styledMain(flow, child)
  let basis: number
  if (styled !== undefined) {
    basis = Math.max(0, styled)
  } else {
    const underWidth = flow.row && flow.mainInner !== undefined && hasMeasureFuncInSubtree(child)
    const main: Offer = underWidth ? [flow.mainInner, 'at-most'] : [undefined, 'undefined']
    basis = askChild(flow, child, main, crossOffer(flow, item, true), false, false).main
  }
  child.fbGen = _generation
  child.fbBasis = basis
  child.fbAvailMain = flow.mainInner
  child.fbAvailCross = flow.crossInner
  child.fbCrossExact = flow.crossExact
  return basis
}

function linesOf(flow: Flow, items: Item[]): Item[][] {
  if (items.length === 0) return []
  if (!flow.wraps || flow.mainInner === undefined) return [items]
  const lines: Item[][] = []
  let line: Item[] = []
  let taken = 0
  for (const item of items) {
    const length = clampMain(flow, item.node, item.basis) + item.mainMargin
    const more = line.length > 0 ? flow.gapMain + length : length
    if (line.length > 0 && taken + more > flow.mainInner + 1e-9) {
      lines.push(line)
      line = [item]
      taken = length
    } else {
      line.push(item)
      taken += more
    }
  }
  lines.push(line)
  return lines
}

function roomFor(flow: Flow, basisTotal: number, ownerMain: number | undefined, padBorderMain: number): number | undefined {
  if (flow.mainInner !== undefined) return flow.mainInner
  const self = flow.self
  const max = resolve(flow.row ? self.styleMaxWidth : self.styleMaxHeight, ownerMain)
  if (max !== undefined && basisTotal > max - padBorderMain) return Math.max(0, max - padBorderMain)
  const min = resolve(flow.row ? self.styleMinWidth : self.styleMinHeight, ownerMain)
  if (min !== undefined && basisTotal < min - padBorderMain) return Math.max(0, min - padBorderMain)
  return undefined
}

function settleLine(flow: Flow, items: Item[], ownerMain: number | undefined, padBorderMain: number, performLayout: boolean): Line {
  const gaps = flow.gapMain * (items.length - 1)
  let basisTotal = 0
  for (const item of items) basisTotal = basisTotal + item.basis + item.mainMargin
  basisTotal += gaps
  resolveFlexibleLengths(items, roomFor(flow, basisTotal, ownerMain, padBorderMain), basisTotal, (child, size) => clampMain(flow, child, size))
  let used = gaps
  let cross = 0
  for (const item of items) {
    item.crossSize = askChild(flow, item.node, [item.targetMain, 'exactly'], crossOffer(flow, item, false), performLayout, true).cross
    used += item.targetMain + item.mainMargin
    cross = Math.max(cross, item.crossSize + item.crossMargin)
  }
  return { items, used, cross }
}

function ownSize(self: CellLayoutNode, mode: LayoutMeasureMode, offered: number | undefined, content: number, padBorder: number, fillsWrapped: boolean): number {
  if (mode === 'exactly') return offered!
  if (mode === 'at-most' && self.overflow === 'scroll') return Math.max(padBorder, Math.min(offered!, content))
  if (fillsWrapped && mode === 'at-most') return offered!
  return content
}

function layoutContainer(
  self: CellLayoutNode,
  availW: number | undefined,
  wMode: LayoutMeasureMode,
  availH: number | undefined,
  hMode: LayoutMeasureMode,
  callerOwnerW: number | undefined,
  callerOwnerH: number | undefined,
  performLayout: boolean,
): { width: number; height: number } {
  const axis = mainAxis(self)
  const row = axis === 'row'
  const padBorderW = padBorderH(self)
  const padBorderHt = padBorderV(self)
  const innerW = availW === undefined ? undefined : Math.max(0, availW - padBorderW)
  const innerH = availH === undefined ? undefined : Math.max(0, availH - padBorderHt)
  const flow: Flow = {
    self,
    row,
    ownerW: availW,
    ownerH: availH,
    mainInner: row ? innerW : innerH,
    crossInner: row ? innerH : innerW,
    crossExact: (row ? hMode : wMode) === 'exactly',
    wraps: self.flexWrap !== 'nowrap',
    gapMain: mainGapOf(self, axis),
    gapCross: crossGapOf(self, axis),
  }
  const items: Item[] = []
  const absolutes: CellLayoutNode[] = []
  for (const child of self.children) {
    if (child.display === LayoutDisplay.None) zeroSubtree(child)
    else if (child.positionType === 'absolute') absolutes.push(child)
    else items.push({ node: child, basis: 0, mainMargin: row ? marginH(child) : marginV(child), crossMargin: row ? marginV(child) : marginH(child), targetMain: 0, crossSize: 0 })
  }
  for (const item of items) item.basis = basisOf(flow, item)
  const padBorderMain = row ? padBorderW : padBorderHt
  const lines = linesOf(flow, items).map(line => settleLine(flow, line, row ? callerOwnerW : callerOwnerH, padBorderMain, performLayout))

  let contentMain = 0
  let contentCross = 0
  if (lines.length > 0) {
    for (const line of lines) {
      contentMain = Math.max(contentMain, line.used)
      contentCross += line.cross
    }
    contentCross += flow.gapCross * (lines.length - 1)
  }
  const contentW = (row ? contentMain : contentCross) + padBorderW
  const contentH = (row ? contentCross : contentMain) + padBorderHt
  const fillsWrapped = flow.wraps && lines.length > 1
  const width = clampW(self, ownSize(self, wMode, availW, contentW, padBorderW, row && fillsWrapped), callerOwnerW)
  const height = clampH(self, ownSize(self, hMode, availH, contentH, padBorderHt, !row && fillsWrapped), callerOwnerH)
  if (!performLayout) return { width, height }

  placeFlow(flow, lines, width, height)
  for (const child of absolutes) placeAbsolute(self, child, width, height)
  return { width, height }
}

function placeFlow(flow: Flow, lines: Line[], width: number, height: number): void {
  const { self, row } = flow
  const sizeMain = row ? width : height
  const sizeCross = row ? height : width
  const innerMain = sizeMain - (row ? padBorderH(self) : padBorderV(self))
  const innerCross = sizeCross - (row ? padBorderV(self) : padBorderH(self))
  const leadMain = row ? 'left' : 'top'
  const trailMain = row ? 'right' : 'bottom'
  const leadCross = row ? 'top' : 'left'
  const reversed = isReverse(self)
  const wrapReversed = self.flexWrap === 'wrap-reverse'
  if (!flow.wraps && lines.length === 1) lines[0]!.cross = innerCross

  if (flow.wraps || !flow.crossExact) {
    for (const line of lines) {
      for (const item of line.items) {
        if (resolvedAlign(item.node, self) !== 'stretch' || styledCross(flow, item.node) !== undefined) continue
        const stretched = Math.max(0, line.cross - item.crossMargin)
        if (stretched === item.crossSize) continue
        askChild(flow, item.node, [item.targetMain, 'exactly'], [stretched, 'exactly'], true, true)
        item.crossSize = stretched
      }
    }
  }

  let lineAt = edgeValue(self.padding, leadCross) + edgeValue(self.border, leadCross)
  for (const line of lines) {
    const linePlace = wrapReversed ? sizeCross - lineAt - line.cross : lineAt
    const count = line.items.length
    const spare = innerMain - line.used
    const shared = Math.max(0, spare)
    let at = edgeValue(self.padding, leadMain) + edgeValue(self.border, leadMain)
    let between = flow.gapMain
    if (self.justifyContent === 'center') at += spare / 2
    else if (self.justifyContent === 'flex-end') at += spare
    else if (self.justifyContent === 'space-between' && count > 1) between += shared / (count - 1)
    else if (self.justifyContent === 'space-around') {
      between += shared / count
      at += shared / count / 2
    } else if (self.justifyContent === 'space-evenly') {
      between += shared / (count + 1)
      at += shared / (count + 1)
    }
    for (const item of line.items) {
      const child = item.node
      const leading = edgeValue(child.margin, leadMain)
      const place = at + leading
      at += leading + item.targetMain + edgeValue(child.margin, trailMain) + between
      const spareCross = line.cross - item.crossSize - item.crossMargin
      const align = resolvedAlign(child, self)
      const shift = align === 'center' ? spareCross / 2 : align === 'flex-end' ? (wrapReversed ? 0 : spareCross) : align === 'flex-start' || align === 'stretch' ? (wrapReversed ? spareCross : 0) : 0
      const mainPlace = reversed ? sizeMain - place - item.targetMain : place
      const crossPlace = linePlace + edgeValue(child.margin, leadCross) + shift
      let left = row ? mainPlace : crossPlace
      let top = row ? crossPlace : mainPlace
      if (child.positionType === 'relative') {
        const insetLeft = insetValue(child.position, 'left', width)
        const insetRight = insetValue(child.position, 'right', width)
        const insetTop = insetValue(child.position, 'top', height)
        const insetBottom = insetValue(child.position, 'bottom', height)
        if (insetLeft !== undefined) left += insetLeft
        else if (insetRight !== undefined) left -= insetRight
        if (insetTop !== undefined) top += insetTop
        else if (insetBottom !== undefined) top -= insetBottom
      }
      child.final = { ...child.final, left, top }
    }
    lineAt += line.cross + flow.gapCross
  }
}

function placeAbsolute(self: CellLayoutNode, child: CellLayoutNode, width: number, height: number): void {
  const borderLeft = edgeValue(self.border, 'left')
  const borderRight = edgeValue(self.border, 'right')
  const borderTop = edgeValue(self.border, 'top')
  const borderBottom = edgeValue(self.border, 'bottom')
  const frameW = width - borderLeft - borderRight
  const frameH = height - borderTop - borderBottom
  const insetLeft = insetValue(child.position, 'left', frameW)
  const insetRight = insetValue(child.position, 'right', frameW)
  const insetTop = insetValue(child.position, 'top', frameH)
  const insetBottom = insetValue(child.position, 'bottom', frameH)
  let w = resolve(child.styleWidth, frameW)
  let h = resolve(child.styleHeight, frameH)
  if (w === undefined && insetLeft !== undefined && insetRight !== undefined) w = Math.max(0, frameW - insetLeft - insetRight - marginH(child))
  if (h === undefined && insetTop !== undefined && insetBottom !== undefined) h = Math.max(0, frameH - insetTop - insetBottom - marginV(child))
  if (w !== undefined) w = clampW(child, w, frameW)
  if (h !== undefined) h = clampH(child, h, frameH)
  const out = layoutInternal(child, w, w === undefined ? 'undefined' : 'exactly', h, h === undefined ? 'undefined' : 'exactly', width, height, true, w !== undefined, h !== undefined)
  const left =
    insetLeft !== undefined
      ? borderLeft + insetLeft + edgeValue(child.margin, 'left')
      : insetRight !== undefined
        ? width - borderRight - insetRight - out.width - edgeValue(child.margin, 'right')
        : edgeValue(self.padding, 'left') + borderLeft + edgeValue(child.margin, 'left')
  const top =
    insetTop !== undefined
      ? borderTop + insetTop + edgeValue(child.margin, 'top')
      : insetBottom !== undefined
        ? height - borderBottom - insetBottom - out.height - edgeValue(child.margin, 'bottom')
        : edgeValue(self.padding, 'top') + borderTop + edgeValue(child.margin, 'top')
  child.final = { left, top, width: out.width, height: out.height }
}

export function createCellLayoutNode(): LayoutNode {
  return new CellLayoutNode()
}


let _traceFile: string | undefined | null = null
function traceContamination(node: CellLayoutNode, w: number, h: number): void {
  if (_traceFile === null) {
    _traceFile =
      typeof process !== 'undefined' ? hostEnv()['INK_YOGA_TRACE'] : undefined
  }
  if (!_traceFile) return
  for (const c of node.children) {
    if (c.final.left + c.final.width > w + 1e-6 || c.final.top + c.final.height > h + 1e-6) {
      try {
        appendFileSync(
          _traceFile,
          JSON.stringify({
            kind: 'skip-restore',
            restored: { w, h },
            child: c.final,
          }) + '\n',
        )
      } catch (error) {
        passedOver(error)
      }
      break
    }
  }
}
