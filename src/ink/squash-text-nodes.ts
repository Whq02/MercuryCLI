import type { DOMElement } from './dom.js'
import type { TextStyles } from './styles.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type StyledSegment = Unbuilt

export default function squashTextNodes(node: DOMElement): string {
  return notBuilt('src/ink/squash-text-nodes.ts:13')
}

export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles?: TextStyles,
  inheritedHyperlink?: string,
  out?: StyledSegment[],
): StyledSegment[] {
  return notBuilt('src/ink/squash-text-nodes.ts:26')
}
