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
    const c = child as CellLayoutNode
    c.parent = this
    this.children.splice(index, 0, c)
    markSubtreeDirty(this)
  }

  removeChild(child: LayoutNode): void {
    const c = child as CellLayoutNode
    const i = this.children.indexOf(c)
    if (i >= 0) {
      this.children.splice(i, 1)
      c.parent = null
      markSubtreeDirty(this)
    }
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
    for (const c of [...this.children]) c.freeRecursive()
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
    return edgeValue(this.border, edge as 'left' | 'right' | 'top' | 'bottom')
  }
  getComputedPadding(edge: LayoutEdge): number {
    return edgeValue(this.padding, edge as 'left' | 'right' | 'top' | 'bottom')
  }


  calculateLayout(width?: number, _height?: number): void {
    _visited = 0
    _measured = 0
    _cacheHits = 0
    _generation++
    const size = layoutInternal(
      this,
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
    roundPass(this, 0, 0)
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
  const axis = mainAxis(self)
  const row = axis === 'row'
  const pbH = padBorderH(self)
  const pbV = padBorderV(self)
  const mainSize = row ? availW : availH
  const crossSize = row ? availH : availW
  const mainMode = row ? wMode : hMode
  const crossMode = row ? hMode : wMode
  const mainPB = row ? pbH : pbV
  const crossPB = row ? pbV : pbH
  const innerMain = mainSize !== undefined ? Math.max(0, mainSize - mainPB) : undefined
  const innerCross = crossSize !== undefined ? Math.max(0, crossSize - crossPB) : undefined

  const ownerW = availW
  const ownerH = availH

  const mainGap = mainGapOf(self, axis)
  const crossGap = crossGapOf(self, axis)
  const isWrapStyle = self.flexWrap !== 'nowrap'

  for (const c of self.children) {
    if (c.display === LayoutDisplay.None) zeroSubtree(c)
  }
  const flow = self.children.filter(
    c => c.positionType !== 'absolute' && c.display !== LayoutDisplay.None,
  )
  const absolutes = self.children.filter(
    c => c.positionType === 'absolute' && c.display !== LayoutDisplay.None,
  )

  const clampMain = (c: CellLayoutNode, v: number) =>
    row ? clampW(c, v, ownerW) : clampH(c, v, ownerH)
  const mainMarginOf = (c: CellLayoutNode) => (row ? marginH(c) : marginV(c))
  const crossMarginOf = (c: CellLayoutNode) => (row ? marginV(c) : marginH(c))

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
        row && innerMain !== undefined && hasMeasureFuncInSubtree(child)
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
        crossAvail = Math.max(0, innerCross - crossMarginOf(child))
        crossModeB =
          crossIsExact && resolvedAlign(child, self) === 'stretch'
            ? 'exactly'
            : 'at-most'
      } else {
        crossAvail = undefined
        crossModeB = 'undefined'
      }
      const size = layoutInternal(
        child,
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

  const lineCrossSizes: number[] = []
  const lineConsumedMain: number[] = []
  let maxLineMain = 0
  for (const line of lines) {
    const gaps = mainGap * Math.max(0, line.length - 1)
    const lineBasis =
      line.reduce((s, i) => s + i.basis + i.mainMargin, 0) + gaps

    let flexAvail = innerMain
    if (flexAvail === undefined) {
      const mainOwner = row ? callerOwnerW : callerOwnerH
      const maxM = resolve(row ? self.styleMaxWidth : self.styleMaxHeight, mainOwner)
      const minM = resolve(row ? self.styleMinWidth : self.styleMinHeight, mainOwner)
      if (maxM !== undefined && lineBasis > maxM - mainPB) {
        flexAvail = Math.max(0, maxM - mainPB)
      } else if (minM !== undefined && lineBasis < minM - mainPB) {
        flexAvail = Math.max(0, minM - mainPB)
      }
    }
    resolveFlexibleLengths(line, flexAvail, lineBasis, clampMain)

    let lineCross = 0
    let consumed = gaps
    for (const item of line) {
      const child = item.node
      const align = resolvedAlign(child, self)
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
      const size = layoutInternal(
        child,
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

  const isScroll = self.overflow === 'scroll'
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
  const outW = clampW(self, row ? finalMain : finalCross, callerOwnerW)
  const outH = clampH(self, row ? finalCross : finalMain, callerOwnerH)

  if (!performLayout) return { width: outW, height: outH }

  placeChildren(
    self,
    row,
    outW,
    outH,
    mainPB,
    crossPB,
    lines,
    isWrapStyle,
    lineCrossSizes,
    crossMode,
    ownerW,
    ownerH,
    performLayout,
    lineConsumedMain,
    mainGap,
    crossGap,
    absolutes,
  )

  return { width: outW, height: outH }
}

function placeChildren(
  self: CellLayoutNode,
  row: boolean,
  outW: number,
  outH: number,
  mainPB: number,
  crossPB: number,
  lines: Item[][],
  isWrapStyle: boolean,
  lineCrossSizes: number[],
  crossMode: LayoutMeasureMode,
  ownerW: number | undefined,
  ownerH: number | undefined,
  performLayout: boolean,
  lineConsumedMain: number[],
  mainGap: number,
  crossGap: number,
  absolutes: CellLayoutNode[],
): void {
  const actualInnerMain = (row ? outW : outH) - mainPB
  const actualInnerCross = (row ? outH : outW) - crossPB
  const mainLeadPB = row
    ? edgeValue(self.padding, 'left') + edgeValue(self.border, 'left')
    : edgeValue(self.padding, 'top') + edgeValue(self.border, 'top')
  const crossLeadPB = row
    ? edgeValue(self.padding, 'top') + edgeValue(self.border, 'top')
    : edgeValue(self.padding, 'left') + edgeValue(self.border, 'left')
  const reversed = isReverse(self)
  const mainContainerSize = row ? outW : outH
  const crossContainerSize = row ? outH : outW
  const wrapReverse = self.flexWrap === 'wrap-reverse'

  if (lines.length === 1 && !isWrapStyle) {
    lineCrossSizes[0] = actualInnerCross
  }

  if (isWrapStyle || crossMode !== 'exactly') {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!
      const lineCross = lineCrossSizes[li]!
      for (const item of line) {
        const child = item.node
        const align = resolvedAlign(child, self)
        const crossStyleResolved = row
          ? resolve(child.styleHeight, ownerH)
          : resolve(child.styleWidth, ownerW)
        if (align !== 'stretch' || crossStyleResolved !== undefined) continue
        const target = Math.max(0, lineCross - item.crossMargin)
        if (item.crossSize === target) continue
        layoutInternal(
          child,
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
    switch (self.justifyContent) {
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

      const align = resolvedAlign(child, self)
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
          break
      }

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

  for (const abs of absolutes) {
    layoutAbsoluteChild(self, abs, outW, outH)
  }
}

function layoutAbsoluteChild(self: CellLayoutNode, child: CellLayoutNode, outW: number, outH: number): void {
  const bl = edgeValue(self.border, 'left')
  const br = edgeValue(self.border, 'right')
  const bt = edgeValue(self.border, 'top')
  const bb = edgeValue(self.border, 'bottom')

  const innerW = outW - bl - br
  const innerH = outH - bt - bb
  const left = insetValue(child.position, 'left', innerW)
  const right = insetValue(child.position, 'right', innerW)
  const top = insetValue(child.position, 'top', innerH)
  const bottom = insetValue(child.position, 'bottom', innerH)

  let w = resolve(child.styleWidth, innerW)
  let h = resolve(child.styleHeight, innerH)
  if (w === undefined && left !== undefined && right !== undefined) {
    w = Math.max(0, outW - bl - br - left - right - marginH(child))
  }
  if (h === undefined && top !== undefined && bottom !== undefined) {
    h = Math.max(0, outH - bt - bb - top - bottom - marginV(child))
  }
  if (w !== undefined) w = clampW(child, w, innerW)
  if (h !== undefined) h = clampH(child, h, innerH)

  const size = layoutInternal(
    child,
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
      edgeValue(self.padding, 'left') +
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
      edgeValue(self.padding, 'top') +
      bt +
      edgeValue(child.margin, 'top')
  }
  child.final = { left: x, top: y, width: size.width, height: size.height }
}

export function createCellLayoutNode(): LayoutNode {
  return new CellLayoutNode()
}


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
      }
      break
    }
  }
}
