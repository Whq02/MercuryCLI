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
import { notBuilt } from '../../pi/holes.js'

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
    notBuilt('src/ink/layout/cellLayout.ts:83')
  }


  insertChild(child: LayoutNode, index: number): void {
    return notBuilt('src/ink/layout/cellLayout.ts:88')
  }

  removeChild(child: LayoutNode): void {
    return notBuilt('src/ink/layout/cellLayout.ts:95')
  }

  getChildCount(): number {
    return notBuilt('src/ink/layout/cellLayout.ts:105')
  }

  getParent(): LayoutNode | null {
    return notBuilt('src/ink/layout/cellLayout.ts:109')
  }


  markDirty(): void {
    return notBuilt('src/ink/layout/cellLayout.ts:114')
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
    return notBuilt('src/ink/layout/cellLayout.ts:269')
  }


  getComputedLeft(): number {
    return notBuilt('src/ink/layout/cellLayout.ts:275')
  }
  getComputedTop(): number {
    return notBuilt('src/ink/layout/cellLayout.ts:278')
  }
  getComputedWidth(): number {
    return notBuilt('src/ink/layout/cellLayout.ts:281')
  }
  getComputedHeight(): number {
    return notBuilt('src/ink/layout/cellLayout.ts:284')
  }
  getComputedBorder(edge: LayoutEdge): number {
    return notBuilt('src/ink/layout/cellLayout.ts:287')
  }
  getComputedPadding(edge: LayoutEdge): number {
    return notBuilt('src/ink/layout/cellLayout.ts:290')
  }


  calculateLayout(width?: number, _height?: number): void {
    return notBuilt('src/ink/layout/cellLayout.ts:295')
  }
}

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
  return notBuilt('src/ink/layout/cellLayout.ts:479')
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
