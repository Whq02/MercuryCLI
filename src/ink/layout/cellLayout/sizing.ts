import type { LayoutMeasureMode } from '../node.js'
import type { FinalRect } from './rounding.js'

export type SizingEntry = {
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

type Sized = {
  children: Sized[]
  parent: Sized | null
  measRecGen: number
  fbGen: number
  measureEntries: SizingEntry[]
  layoutEntry: SizingEntry | null
  final: FinalRect
  rounded: FinalRect
}

export function axisReusable(
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

export function markSubtreeDirty(self: Sized): void {
  let node: Sized | null = self
  while (node) {
    node.measureEntries.length = 0
    node.layoutEntry = null
    node = node.parent
  }
}

export function storeSizing(
  self: Sized,
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
    self.layoutEntry = entry
  } else {
    if (self.measureEntries.length >= 8) self.measureEntries.shift()
    self.measureEntries.push(entry)
  }
}

export function zeroSubtree(self: Sized): void {
  self.final = { left: 0, top: 0, width: 0, height: 0 }
  self.rounded = { left: 0, top: 0, width: 0, height: 0 }
  self.measureEntries.length = 0
  self.layoutEntry = null
  self.fbGen = -1
  self.measRecGen = -1
  for (const c of self.children) zeroSubtree(c)
}
