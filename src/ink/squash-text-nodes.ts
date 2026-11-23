import type { DOMElement, ElementNames } from './dom.js'
import type { TextStyles } from './styles.js'

export type StyledSegment = { text: string; styles: TextStyles; hyperlink?: string }

const TEXTUAL_ELEMENTS: ReadonlySet<ElementNames> = new Set(['ink-text', 'ink-virtual-text', 'ink-link'])

export default function squashTextNodes(node: DOMElement): string {
  let text = ''
  for (const child of node.childNodes) {
    if (child === undefined) continue
    if (child.nodeName === '#text') text += child.nodeValue
    else if (TEXTUAL_ELEMENTS.has(child.nodeName)) text += squashTextNodes(child)
  }
  return text
}

export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles: TextStyles = {},
  inheritedHyperlink?: string,
  out: StyledSegment[] = [],
): StyledSegment[] {
  const styles = node.textStyles ? { ...inheritedStyles, ...node.textStyles } : inheritedStyles
  const href = node.attributes['href']
  const hyperlink = node.nodeName === 'ink-link' && typeof href === 'string' && href !== '' ? href : inheritedHyperlink
  for (const child of node.childNodes) {
    if (child === undefined) continue
    if (child.nodeName === '#text') {
      if (child.nodeValue !== '') out.push(hyperlink === undefined ? { text: child.nodeValue, styles } : { text: child.nodeValue, styles, hyperlink })
    } else if (TEXTUAL_ELEMENTS.has(child.nodeName)) {
      squashTextNodesToSegments(child, styles, hyperlink, out)
    }
  }
  return out
}
