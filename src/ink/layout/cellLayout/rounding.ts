import type { LayoutMeasureFunc } from '../node.js'

export interface FinalRect {
  left: number
  top: number
  width: number
  height: number
}

type Placed = {
  children: Placed[]
  measureFunc: LayoutMeasureFunc | null
  final: FinalRect
  rounded: FinalRect
}

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

export function roundPass(self: Placed, parentAbsLeft: number, parentAbsTop: number): void {
  const absLeft = parentAbsLeft + self.final.left
  const absTop = parentAbsTop + self.final.top
  const text = self.measureFunc !== null
  const fracW = !nearWhole(self.final.width)
  const fracH = !nearWhole(self.final.height)
  self.rounded = {
    left: roundGrid(self.final.left, false, text),
    top: roundGrid(self.final.top, false, text),
    width:
      roundGrid(absLeft + self.final.width, text && fracW, text && !fracW) -
      roundGrid(absLeft, false, text),
    height:
      roundGrid(absTop + self.final.height, text && fracH, text && !fracH) -
      roundGrid(absTop, false, text),
  }
  for (const c of self.children) roundPass(c, absLeft, absTop)
}
