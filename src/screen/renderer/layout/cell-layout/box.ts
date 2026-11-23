import type { LayoutAlign, LayoutFlexDirection, LayoutGutter, LayoutMeasureFunc } from '../node.js'
import { type DimValue, type EdgeStore, edgeValue, resolve } from './values.js'

type Axis = 'row' | 'column'

type Boxed = {
  children: Boxed[]
  styleMinWidth: DimValue
  styleMinHeight: DimValue
  styleMaxWidth: DimValue
  styleMaxHeight: DimValue
  flexDirection: LayoutFlexDirection
  alignItems: LayoutAlign
  alignSelf: LayoutAlign
  margin: EdgeStore
  padding: EdgeStore
  border: EdgeStore
  gap: Partial<Record<LayoutGutter, number>>
  measureFunc: LayoutMeasureFunc | null
}

export function mainAxis(self: Boxed): Axis {
  return self.flexDirection === 'row' || self.flexDirection === 'row-reverse' ? 'row' : 'column'
}
export function isReverse(self: Boxed): boolean {
  return self.flexDirection === 'row-reverse' || self.flexDirection === 'column-reverse'
}

function edgesH(store: EdgeStore): number {
  return edgeValue(store, 'left') + edgeValue(store, 'right')
}
function edgesV(store: EdgeStore): number {
  return edgeValue(store, 'top') + edgeValue(store, 'bottom')
}

export function clampW(self: Boxed, v: number, ownerW: number | undefined): number {
  const min = resolve(self.styleMinWidth, ownerW)
  const max = resolve(self.styleMaxWidth, ownerW)
  let out = v
  if (max !== undefined) out = Math.min(out, max)
  if (min !== undefined) out = Math.max(out, min)
  return Math.max(0, out)
}
export function clampH(self: Boxed, v: number, ownerH: number | undefined): number {
  const min = resolve(self.styleMinHeight, ownerH)
  const max = resolve(self.styleMaxHeight, ownerH)
  let out = v
  if (max !== undefined) out = Math.min(out, max)
  if (min !== undefined) out = Math.max(out, min)
  return Math.max(0, out)
}

export function marginH(self: Boxed): number {
  return edgesH(self.margin)
}
export function marginV(self: Boxed): number {
  return edgesV(self.margin)
}
export function padBorderH(self: Boxed): number {
  return edgesH(self.padding) + edgesH(self.border)
}
export function padBorderV(self: Boxed): number {
  return edgesV(self.padding) + edgesV(self.border)
}

export function resolvedAlign(self: Boxed, parent: Boxed): LayoutAlign {
  return self.alignSelf === 'auto' ? parent.alignItems : self.alignSelf
}

export function hasMeasureFuncInSubtree(self: Boxed): boolean {
  return self.measureFunc !== null || self.children.some(hasMeasureFuncInSubtree)
}

export function mainGapOf(self: Boxed, axis: Axis): number {
  return (axis === 'row' ? self.gap.column : self.gap.row) ?? self.gap.all ?? 0
}
export function crossGapOf(self: Boxed, axis: Axis): number {
  return (axis === 'row' ? self.gap.row : self.gap.column) ?? self.gap.all ?? 0
}
