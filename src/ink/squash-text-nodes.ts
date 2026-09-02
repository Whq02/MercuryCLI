// Flattens a text subtree to a plain string or to styled segments. The walk
// recurses through the three textual element kinds and ignores everything
// else; `ink-link` children replace the inherited hyperlink with their own
// non-empty href on the way down.

import type { DOMElement } from './dom.js'
import type { TextStyles } from './styles.js'

export type StyledSegment = {
  text: string
  styles: TextStyles
  hyperlink?: string
}

const TEXTUAL_ELEMENTS = new Set(['ink-text', 'ink-virtual-text', 'ink-link'])

export default function squashTextNodes(node: DOMElement): string {
  let text = ''
  for (const child of node.childNodes) {
    if (child === undefined) continue
    if (child.nodeName === '#text') {
      text += child.nodeValue
    } else if (TEXTUAL_ELEMENTS.has(child.nodeName)) {
      text += squashTextNodes(child)
    }
  }
  return text
}

export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles: TextStyles = {},
  inheritedHyperlink?: string,
  out: StyledSegment[] = [],
): StyledSegment[] {
  const styles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles
  let hyperlink = inheritedHyperlink
  if (node.nodeName === 'ink-link') {
    const href = node.attributes['href']
    if (typeof href === 'string' && href !== '') hyperlink = href
  }
  for (const child of node.childNodes) {
    if (child === undefined) continue
    if (child.nodeName === '#text') {
      if (child.nodeValue !== '') {
        out.push(
          hyperlink !== undefined
            ? { text: child.nodeValue, styles, hyperlink }
            : { text: child.nodeValue, styles },
        )
      }
    } else if (TEXTUAL_ELEMENTS.has(child.nodeName)) {
      squashTextNodesToSegments(child, styles, hyperlink, out)
    }
  }
  return out
}
