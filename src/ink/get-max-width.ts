// Content width of a layout node: computed width minus horizontal padding
// and border. The answer can EXCEED the parent's width — a column parent
// measures width on the cross axis and default stretch will not compress a
// child below its intrinsic size, while the engine's looser measuring pass
// fixes the width — so any caller wrapping against this value must first
// clamp it to the space actually on screen.

import { LayoutEdge, type LayoutNode } from './layout/node.js'

export default function getMaxWidth(layoutNode: LayoutNode): number {
  return (
    layoutNode.getComputedWidth() -
    layoutNode.getComputedPadding(LayoutEdge.Left) -
    layoutNode.getComputedPadding(LayoutEdge.Right) -
    layoutNode.getComputedBorder(LayoutEdge.Left) -
    layoutNode.getComputedBorder(LayoutEdge.Right)
  )
}
