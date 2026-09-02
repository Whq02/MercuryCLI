// The public style vocabulary and its DIFF application onto a layout node.
// Two rules govern application: a property participates only when its key is
// PRESENT on the object being applied, and border side visibility is read
// from the RESOLVED style (a diff may carry borderStyle while omitting
// unchanged side flags). The rule groups run in one FIXED order regardless
// of key order: position → overflow → margin → padding → flex → dimensions →
// display → border → gap.

import type { BorderStyle } from './render-border.js'
import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  LayoutOverflow,
  LayoutPositionType,
  LayoutWrap,
  type LayoutNode,
} from './layout/node.js'

export type RGBColor = `rgb(${string})`
export type HexColor = `#${string}`
export type Ansi256Color = `ansi256(${string})`
export type AnsiColor = `ansi:${string}`
export type Color = RGBColor | HexColor | Ansi256Color | AnsiColor

export type TextStyles = {
  color?: Color
  backgroundColor?: Color
  dim?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
}

export type Styles = {
  readonly textWrap?:
    | 'wrap'
    | 'wrap-trim'
    | 'end'
    | 'middle'
    | 'truncate-end'
    | 'truncate'
    | 'truncate-middle'
    | 'truncate-start'
  readonly position?: 'absolute' | 'relative'
  readonly top?: number | string
  readonly bottom?: number | string
  readonly left?: number | string
  readonly right?: number | string
  readonly gap?: number
  readonly columnGap?: number
  readonly rowGap?: number
  readonly margin?: number
  readonly marginX?: number
  readonly marginY?: number
  readonly marginTop?: number
  readonly marginBottom?: number
  readonly marginLeft?: number
  readonly marginRight?: number
  readonly padding?: number
  readonly paddingX?: number
  readonly paddingY?: number
  readonly paddingTop?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly paddingRight?: number
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  readonly flexBasis?: number | string
  readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  readonly alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto'
  readonly justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
    | 'center'
  readonly width?: number | string
  readonly height?: number | string
  readonly minWidth?: number | string
  readonly minHeight?: number | string
  readonly maxWidth?: number | string
  readonly maxHeight?: number | string
  readonly display?: 'flex' | 'none'
  readonly borderStyle?: BorderStyle
  readonly borderTop?: boolean
  readonly borderBottom?: boolean
  readonly borderLeft?: boolean
  readonly borderRight?: boolean
  readonly borderColor?: Color
  readonly borderTopColor?: Color
  readonly borderBottomColor?: Color
  readonly borderLeftColor?: Color
  readonly borderRightColor?: Color
  readonly borderDimColor?: boolean
  readonly borderTopDimColor?: boolean
  readonly borderBottomDimColor?: boolean
  readonly borderLeftDimColor?: boolean
  readonly borderRightDimColor?: boolean
  readonly borderText?: {
    content: string
    position: 'top' | 'bottom'
    align: 'start' | 'end' | 'center'
    offset?: number
  }
  /** Row-addressed border ground: absolute buffer row → background colour. */
  readonly borderRowBg?: (row: number) => string | undefined
  readonly backgroundColor?: Color
  /** Absolute buffer row → the background of every interior cell on it. */
  readonly fillRowBg?: (row: number) => string | undefined
  /** Fill the interior (padding included) with spaces WITHOUT any colour
   *  escape, so nothing behind shows through on the terminal's own ground. */
  readonly opaque?: boolean
  readonly overflow?: 'visible' | 'hidden' | 'scroll'
  readonly overflowX?: 'visible' | 'hidden' | 'scroll'
  readonly overflowY?: 'visible' | 'hidden' | 'scroll'
  /** Alternate-screen selection exclusion; `from-left-edge` widens the
   *  exclusion from column 0 to the box's right edge on its rows. */
  readonly noSelect?: boolean | 'from-left-edge'
}

const isPercent = (value: unknown): value is string =>
  typeof value === 'string' && value.endsWith('%')

const percentValue = (value: string): number => Number.parseFloat(value)

// The layout engine's spelling of "unset" for an edge position and the flex
// basis is a NaN point value (the engine reads NaN as auto); every other
// group uses an explicit auto setter or 0 — do not generalise the NaN.
function applyPosition(node: LayoutNode, style: Styles): void {
  if ('position' in style) {
    node.setPositionType(
      style.position === 'absolute'
        ? LayoutPositionType.Absolute
        : LayoutPositionType.Relative,
    )
  }
  const edges = [
    ['top', LayoutEdge.Top],
    ['bottom', LayoutEdge.Bottom],
    ['left', LayoutEdge.Left],
    ['right', LayoutEdge.Right],
  ] as const
  for (const [key, edge] of edges) {
    if (!(key in style)) continue
    const value = style[key]
    if (typeof value === 'number') node.setPosition(edge, value)
    else if (isPercent(value)) node.setPositionPercent(edge, percentValue(value))
    else node.setPosition(edge, Number.NaN)
  }
}

function applyOverflow(node: LayoutNode, style: Styles): void {
  if (!('overflow' in style || 'overflowX' in style || 'overflowY' in style)) {
    return
  }
  // Layout only distinguishes whether children may expand the container;
  // per-axis clipping is the render walk's job. Scroll wins over hidden.
  const vertical = style.overflowY ?? style.overflow
  const horizontal = style.overflowX ?? style.overflow
  if (vertical === 'scroll' || horizontal === 'scroll') {
    node.setOverflow(LayoutOverflow.Scroll)
  } else if (vertical === 'hidden' || horizontal === 'hidden') {
    node.setOverflow(LayoutOverflow.Hidden)
  } else {
    node.setOverflow(LayoutOverflow.Visible)
  }
}

// A NaN value must never reach the layout engine unsanitised.
const spacing = (value: number | undefined): number => {
  if (value === undefined || Number.isNaN(value)) return 0
  return value
}

function applyMargin(node: LayoutNode, style: Styles): void {
  // Shorthands before sides, in declared order, so a diff carrying both
  // lands with the side winning. Margin addresses the horizontal sides
  // through START/END (padding uses LEFT/RIGHT); the product only runs
  // left-to-right so the two are equivalent, but the layout corpus records
  // the setter calls — keep the distinction.
  if ('margin' in style) {
    node.setMargin(LayoutEdge.All, spacing(style.margin))
  }
  if ('marginX' in style) {
    node.setMargin(LayoutEdge.Horizontal, spacing(style.marginX))
  }
  if ('marginY' in style) {
    node.setMargin(LayoutEdge.Vertical, spacing(style.marginY))
  }
  if ('marginTop' in style) {
    node.setMargin(LayoutEdge.Top, spacing(style.marginTop))
  }
  if ('marginBottom' in style) {
    node.setMargin(LayoutEdge.Bottom, spacing(style.marginBottom))
  }
  if ('marginLeft' in style) {
    node.setMargin(LayoutEdge.Start, spacing(style.marginLeft))
  }
  if ('marginRight' in style) {
    node.setMargin(LayoutEdge.End, spacing(style.marginRight))
  }
}

function applyPadding(node: LayoutNode, style: Styles): void {
  if ('padding' in style) {
    node.setPadding(LayoutEdge.All, spacing(style.padding))
  }
  if ('paddingX' in style) {
    node.setPadding(LayoutEdge.Horizontal, spacing(style.paddingX))
  }
  if ('paddingY' in style) {
    node.setPadding(LayoutEdge.Vertical, spacing(style.paddingY))
  }
  if ('paddingTop' in style) {
    node.setPadding(LayoutEdge.Top, spacing(style.paddingTop))
  }
  if ('paddingBottom' in style) {
    node.setPadding(LayoutEdge.Bottom, spacing(style.paddingBottom))
  }
  if ('paddingLeft' in style) {
    node.setPadding(LayoutEdge.Left, spacing(style.paddingLeft))
  }
  if ('paddingRight' in style) {
    node.setPadding(LayoutEdge.Right, spacing(style.paddingRight))
  }
}

const FLEX_DIRECTIONS = {
  row: LayoutFlexDirection.Row,
  'row-reverse': LayoutFlexDirection.RowReverse,
  column: LayoutFlexDirection.Column,
  'column-reverse': LayoutFlexDirection.ColumnReverse,
} as const

const FLEX_WRAPS = {
  nowrap: LayoutWrap.NoWrap,
  wrap: LayoutWrap.Wrap,
  'wrap-reverse': LayoutWrap.WrapReverse,
} as const

const ALIGNS = {
  'flex-start': LayoutAlign.FlexStart,
  center: LayoutAlign.Center,
  'flex-end': LayoutAlign.FlexEnd,
  stretch: LayoutAlign.Stretch,
  auto: LayoutAlign.Auto,
} as const

const JUSTIFIES = {
  'flex-start': LayoutJustify.FlexStart,
  center: LayoutJustify.Center,
  'flex-end': LayoutJustify.FlexEnd,
  'space-between': LayoutJustify.SpaceBetween,
  'space-around': LayoutJustify.SpaceAround,
  'space-evenly': LayoutJustify.SpaceEvenly,
} as const

function applyFlex(node: LayoutNode, style: Styles): void {
  if ('flexGrow' in style) {
    node.setFlexGrow(style.flexGrow ?? 0)
  }
  if ('flexShrink' in style) {
    node.setFlexShrink(typeof style.flexShrink === 'number' ? style.flexShrink : 1)
  }
  if ('flexWrap' in style) {
    const wrap = style.flexWrap === undefined ? undefined : FLEX_WRAPS[style.flexWrap]
    if (wrap !== undefined) node.setFlexWrap(wrap)
  }
  if ('flexDirection' in style) {
    const direction =
      style.flexDirection === undefined
        ? undefined
        : FLEX_DIRECTIONS[style.flexDirection]
    if (direction !== undefined) node.setFlexDirection(direction)
  }
  if ('flexBasis' in style) {
    if (typeof style.flexBasis === 'number') node.setFlexBasis(style.flexBasis)
    else if (isPercent(style.flexBasis)) {
      node.setFlexBasisPercent(percentValue(style.flexBasis))
    } else {
      node.setFlexBasis(Number.NaN)
    }
  }
  if ('alignItems' in style) {
    const align =
      style.alignItems === undefined
        ? LayoutAlign.Stretch
        : ALIGNS[style.alignItems]
    if (align !== undefined) node.setAlignItems(align)
  }
  if ('alignSelf' in style) {
    const align =
      style.alignSelf === undefined ? LayoutAlign.Auto : ALIGNS[style.alignSelf]
    if (align !== undefined) node.setAlignSelf(align)
  }
  if ('justifyContent' in style) {
    const justify =
      style.justifyContent === undefined
        ? LayoutJustify.FlexStart
        : JUSTIFIES[style.justifyContent]
    if (justify !== undefined) node.setJustifyContent(justify)
  }
}

function applyDimensions(node: LayoutNode, style: Styles): void {
  if ('width' in style) {
    if (typeof style.width === 'number') node.setWidth(style.width)
    else if (isPercent(style.width)) node.setWidthPercent(percentValue(style.width))
    else node.setWidthAuto()
  }
  if ('height' in style) {
    if (typeof style.height === 'number') node.setHeight(style.height)
    else if (isPercent(style.height)) {
      node.setHeightPercent(percentValue(style.height))
    } else {
      node.setHeightAuto()
    }
  }
  if ('minWidth' in style) {
    if (isPercent(style.minWidth)) node.setMinWidthPercent(percentValue(style.minWidth))
    else node.setMinWidth(typeof style.minWidth === 'number' ? style.minWidth : 0)
  }
  if ('minHeight' in style) {
    if (isPercent(style.minHeight)) {
      node.setMinHeightPercent(percentValue(style.minHeight))
    } else {
      node.setMinHeight(typeof style.minHeight === 'number' ? style.minHeight : 0)
    }
  }
  if ('maxWidth' in style) {
    if (isPercent(style.maxWidth)) node.setMaxWidthPercent(percentValue(style.maxWidth))
    else node.setMaxWidth(typeof style.maxWidth === 'number' ? style.maxWidth : 0)
  }
  if ('maxHeight' in style) {
    if (isPercent(style.maxHeight)) {
      node.setMaxHeightPercent(percentValue(style.maxHeight))
    } else {
      node.setMaxHeight(typeof style.maxHeight === 'number' ? style.maxHeight : 0)
    }
  }
}

function applyDisplay(node: LayoutNode, style: Styles): void {
  if (!('display' in style)) return
  node.setDisplay(style.display === 'flex' ? LayoutDisplay.Flex : LayoutDisplay.None)
}

const BORDER_SIDES = [
  ['borderTop', LayoutEdge.Top],
  ['borderBottom', LayoutEdge.Bottom],
  ['borderLeft', LayoutEdge.Left],
  ['borderRight', LayoutEdge.Right],
] as const

function applyBorder(node: LayoutNode, style: Styles, resolved: Styles): void {
  if ('borderStyle' in style) {
    const width = style.borderStyle ? 1 : 0
    for (const [key, edge] of BORDER_SIDES) {
      // Side visibility comes from the RESOLVED style, not the diff.
      node.setBorder(edge, resolved[key] === false ? 0 : width)
    }
    return
  }
  let sideChanged = false
  for (const [key] of BORDER_SIDES) {
    if (key in style) sideChanged = true
  }
  if (!sideChanged) return
  for (const [key, edge] of BORDER_SIDES) {
    if (!(key in style)) continue
    const flag = style[key]
    // An undefined side flag means removed/never-set — NOT a request to
    // enable that edge.
    if (flag === undefined) continue
    node.setBorder(edge, flag === false ? 0 : 1)
  }
}

function applyGap(node: LayoutNode, style: Styles): void {
  if ('gap' in style) node.setGap(LayoutGutter.All, style.gap ?? 0)
  if ('columnGap' in style) node.setGap(LayoutGutter.Column, style.columnGap ?? 0)
  if ('rowGap' in style) node.setGap(LayoutGutter.Row, style.rowGap ?? 0)
}

export default function applyStyles(
  layoutNode: LayoutNode,
  style: Styles = {},
  resolvedStyle: Styles = style,
): void {
  applyPosition(layoutNode, style)
  applyOverflow(layoutNode, style)
  applyMargin(layoutNode, style)
  applyPadding(layoutNode, style)
  applyFlex(layoutNode, style)
  applyDimensions(layoutNode, style)
  applyDisplay(layoutNode, style)
  applyBorder(layoutNode, style, resolvedStyle)
  applyGap(layoutNode, style)
}
