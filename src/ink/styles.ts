import type { BorderStyle } from './render-border.js'
import { LayoutAlign, LayoutDisplay, LayoutEdge, LayoutFlexDirection, LayoutGutter, LayoutJustify, LayoutOverflow, LayoutPositionType, LayoutWrap, type LayoutNode } from './layout/node.js'

type RGBColor = `rgb(${string})`
type Hash = '#'
export type HexColor = `${Hash}${string}`
type Ansi256Color = `ansi256(${string})`
type AnsiColor = `ansi:${string}`
export type Color = HexColor | RGBColor | Ansi256Color | AnsiColor

export type TextStyles = { color?: Color; backgroundColor?: Color
  dim?: boolean; bold?: boolean; italic?: boolean
  underline?: boolean; strikethrough?: boolean; inverse?: boolean
}

export type Styles = { readonly textWrap?: 'wrap' | 'wrap-trim' | 'end' | 'middle' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start'
  readonly position?: 'absolute' | 'relative'; readonly top?: number | string; readonly bottom?: number | string
  readonly left?: number | string; readonly right?: number | string
  readonly gap?: number; readonly columnGap?: number; readonly rowGap?: number
  readonly margin?: number; readonly marginX?: number; readonly marginY?: number
  readonly marginTop?: number; readonly marginBottom?: number; readonly marginLeft?: number; readonly marginRight?: number
  readonly padding?: number; readonly paddingX?: number; readonly paddingY?: number
  readonly paddingTop?: number; readonly paddingBottom?: number; readonly paddingLeft?: number; readonly paddingRight?: number
  readonly flexGrow?: number; readonly flexShrink?: number
  readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'; readonly flexBasis?: number | string; readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'; readonly alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto'
  readonly justifyContent?: 'flex-start' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly' | 'center'
  readonly width?: number | string; readonly height?: number | string
  readonly minWidth?: number | string; readonly minHeight?: number | string
  readonly maxWidth?: number | string; readonly maxHeight?: number | string
  readonly display?: 'flex' | 'none'; readonly borderStyle?: BorderStyle
  readonly borderTop?: boolean; readonly borderBottom?: boolean; readonly borderLeft?: boolean; readonly borderRight?: boolean
  readonly borderColor?: Color; readonly borderTopColor?: Color; readonly borderBottomColor?: Color
  readonly borderLeftColor?: Color; readonly borderRightColor?: Color
  readonly borderDimColor?: boolean; readonly borderTopDimColor?: boolean; readonly borderBottomDimColor?: boolean
  readonly borderLeftDimColor?: boolean; readonly borderRightDimColor?: boolean
  readonly borderText?: { content: string; position: 'top' | 'bottom'; align: 'start' | 'end' | 'center'; offset?: number }
  readonly borderRowBg?: (row: number) => string | undefined
  readonly backgroundColor?: Color; readonly fillRowBg?: (row: number) => string | undefined; readonly opaque?: boolean
  readonly overflow?: 'visible' | 'hidden' | 'scroll'; readonly overflowX?: 'visible' | 'hidden' | 'scroll'
  readonly overflowY?: 'visible' | 'hidden' | 'scroll'; readonly noSelect?: boolean | 'from-left-edge'
}

type ExtentKey = 'width' | 'height' | 'minWidth' | 'minHeight' | 'maxWidth' | 'maxHeight'
type Measure = number | string

type Rule = (node: LayoutNode, style: Styles, resolved: Styles) => void

const percentOf = (measure: unknown): number | undefined =>
  typeof measure === 'string' && measure.endsWith('%') ? Number.parseFloat(measure) : undefined

const spacingCells = (cells: number | undefined): number => (cells === undefined || Number.isNaN(cells) ? 0 : cells)

const wordsOf = <Word extends string>(vocabulary: Record<string, Word>): ReadonlySet<Word> => new Set(Object.values(vocabulary))

const knownWord = <Word extends string>(table: ReadonlySet<Word>, word: string | undefined): Word | undefined =>
  table.has(word as Word) ? (word as Word) : undefined

const FLEX_DIRECTIONS = wordsOf(LayoutFlexDirection)
const WRAPS = wordsOf(LayoutWrap)
const ALIGNMENTS = wordsOf(LayoutAlign)
const JUSTIFICATIONS = wordsOf(LayoutJustify)

const OFFSET_EDGES = [['top', LayoutEdge.Top], ['bottom', LayoutEdge.Bottom], ['left', LayoutEdge.Left], ['right', LayoutEdge.Right]] as const
const MARGIN_EDGES = [['margin', LayoutEdge.All], ['marginX', LayoutEdge.Horizontal], ['marginY', LayoutEdge.Vertical], ['marginTop', LayoutEdge.Top], ['marginBottom', LayoutEdge.Bottom], ['marginLeft', LayoutEdge.Start], ['marginRight', LayoutEdge.End]] as const
const PADDING_EDGES = [['padding', LayoutEdge.All], ['paddingX', LayoutEdge.Horizontal], ['paddingY', LayoutEdge.Vertical], ['paddingTop', LayoutEdge.Top], ['paddingBottom', LayoutEdge.Bottom], ['paddingLeft', LayoutEdge.Left], ['paddingRight', LayoutEdge.Right]] as const
const BORDER_EDGES = [['borderTop', LayoutEdge.Top], ['borderBottom', LayoutEdge.Bottom], ['borderLeft', LayoutEdge.Left], ['borderRight', LayoutEdge.Right]] as const
const GAP_GUTTERS = [['gap', LayoutGutter.All], ['columnGap', LayoutGutter.Column], ['rowGap', LayoutGutter.Row]] as const

type ExtentRule = readonly [key: ExtentKey, exact: (node: LayoutNode, cells: number) => void, share: (node: LayoutNode, percent: number) => void, unsized: (node: LayoutNode) => void]
const EXTENT_RULES: readonly ExtentRule[] = [
  ['width', (node, cells) => node.setWidth(cells), (node, percent) => node.setWidthPercent(percent), node => node.setWidthAuto()],
  ['height', (node, cells) => node.setHeight(cells), (node, percent) => node.setHeightPercent(percent), node => node.setHeightAuto()],
  ['minWidth', (node, cells) => node.setMinWidth(cells), (node, percent) => node.setMinWidthPercent(percent), node => node.setMinWidth(0)],
  ['minHeight', (node, cells) => node.setMinHeight(cells), (node, percent) => node.setMinHeightPercent(percent), node => node.setMinHeight(0)],
  ['maxWidth', (node, cells) => node.setMaxWidth(cells), (node, percent) => node.setMaxWidthPercent(percent), node => node.setMaxWidth(Number.NaN)],
  ['maxHeight', (node, cells) => node.setMaxHeight(cells), (node, percent) => node.setMaxHeightPercent(percent), node => node.setMaxHeight(Number.NaN)],
]

const placeNode: Rule = (node, style) => {
  if ('position' in style) node.setPositionType(style.position === 'absolute' ? LayoutPositionType.Absolute : LayoutPositionType.Relative)
  for (const [key, edge] of OFFSET_EDGES) {
    if (!(key in style)) continue
    const offset = style[key]
    const percent = percentOf(offset)
    if (typeof offset === 'number') node.setPosition(edge, offset)
    else if (percent !== undefined) node.setPositionPercent(edge, percent)
    else node.setPosition(edge, Number.NaN)
  }
}

const clipNode: Rule = (node, style) => {
  if (!('overflow' in style || 'overflowX' in style || 'overflowY' in style)) return
  const down = style.overflowY ?? style.overflow
  const across = style.overflowX ?? style.overflow
  const scrolls = down === 'scroll' || across === 'scroll'
  const hides = down === 'hidden' || across === 'hidden'
  node.setOverflow(scrolls ? LayoutOverflow.Scroll : hides ? LayoutOverflow.Hidden : LayoutOverflow.Visible)
}

const spaceAround: Rule = (node, style) => {
  for (const [key, edge] of MARGIN_EDGES) if (key in style) node.setMargin(edge, spacingCells(style[key]))
}

const spaceWithin: Rule = (node, style) => {
  for (const [key, edge] of PADDING_EDGES) if (key in style) node.setPadding(edge, spacingCells(style[key]))
}

const wordOr = <Word extends string>(present: boolean, word: string | undefined, table: ReadonlySet<Word>, fallback: Word): Word | undefined =>
  !present ? undefined : word === undefined ? fallback : knownWord(table, word)

const basisNode = (node: LayoutNode, basis: Measure | undefined): void => {
  const share = percentOf(basis)
  if (typeof basis === 'number') node.setFlexBasis(basis)
  else if (share !== undefined) node.setFlexBasisPercent(share)
  else node.setFlexBasis(Number.NaN)
}

const flexNode: Rule = (node, style) => {
  if ('flexGrow' in style) node.setFlexGrow(style.flexGrow ?? 0)
  if ('flexShrink' in style) node.setFlexShrink(typeof style.flexShrink === 'number' ? style.flexShrink : 1)
  const wrap = 'flexWrap' in style ? knownWord(WRAPS, style.flexWrap) : undefined
  if (wrap !== undefined) node.setFlexWrap(wrap)
  const direction = 'flexDirection' in style ? knownWord(FLEX_DIRECTIONS, style.flexDirection) : undefined
  if (direction !== undefined) node.setFlexDirection(direction)
  if ('flexBasis' in style) basisNode(node, style.flexBasis)
  const items = wordOr('alignItems' in style, style.alignItems, ALIGNMENTS, LayoutAlign.Stretch)
  if (items !== undefined) node.setAlignItems(items)
  const self = wordOr('alignSelf' in style, style.alignSelf, ALIGNMENTS, LayoutAlign.Auto)
  if (self !== undefined) node.setAlignSelf(self)
  const justification = wordOr('justifyContent' in style, style.justifyContent, JUSTIFICATIONS, LayoutJustify.FlexStart)
  if (justification !== undefined) node.setJustifyContent(justification)
}

const sizeNode: Rule = (node, style) => {
  for (const [key, exact, share, unsized] of EXTENT_RULES) {
    if (!(key in style)) continue
    const measure = style[key]
    const percent = percentOf(measure)
    if (typeof measure === 'number') exact(node, measure)
    else if (percent !== undefined) share(node, percent)
    else unsized(node)
  }
}

const showNode: Rule = (node, style) => {
  if ('display' in style) node.setDisplay(style.display === 'flex' ? LayoutDisplay.Flex : LayoutDisplay.None)
}

const edgeNode: Rule = (node, style, resolved) => {
  const restyled = 'borderStyle' in style
  const cells = style.borderStyle ? 1 : 0
  for (const [side, edge] of BORDER_EDGES) {
    const drawn = style[side]
    if (restyled) node.setBorder(edge, resolved[side] === false ? 0 : cells)
    else if (drawn !== undefined) node.setBorder(edge, drawn === false ? 0 : 1)
  }
}

const gapNode: Rule = (node, style) => {
  for (const [key, gutter] of GAP_GUTTERS) if (key in style) node.setGap(gutter, style[key] ?? 0)
}

const RULES: readonly Rule[] = [placeNode, clipNode, spaceAround, spaceWithin, flexNode, sizeNode, showNode, edgeNode, gapNode]

export default function applyStyles(layoutNode: LayoutNode, style: Styles = {}, resolvedStyle: Styles = style): void {
  for (const rule of RULES) rule(layoutNode, style, resolvedStyle)
}
