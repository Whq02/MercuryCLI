import { createCellLayoutNode } from './cellLayout.js'
import type { LayoutNode } from './node.js'

export function createLayoutNode(): LayoutNode {
  return createCellLayoutNode()
}
