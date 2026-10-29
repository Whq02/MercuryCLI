
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
