// The text primitive. The structured text style carries only truthy props,
// and the layout style comes from a pre-built table keyed by wrap mode so
// its identity is stable and never dirties the node.

import React from 'react'
import type { Color, Styles, TextStyles } from '../styles.js'

type WrapMode = NonNullable<Styles['textWrap']>

type BaseProps = {
  readonly color?: Color
  readonly backgroundColor?: Color
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
  readonly wrap?: WrapMode
  readonly children?: React.ReactNode
}

// bold and dim are mutually exclusive in terminals — enforced at the type
// level.
export type Props =
  | (BaseProps & { readonly bold?: boolean; readonly dim?: never })
  | (BaseProps & { readonly dim?: boolean; readonly bold?: never })

const WRAP_MODES: WrapMode[] = [
  'wrap',
  'wrap-trim',
  'end',
  'middle',
  'truncate-end',
  'truncate',
  'truncate-middle',
  'truncate-start',
]

const LAYOUT_STYLE_BY_WRAP: Record<WrapMode, Styles> = Object.fromEntries(
  WRAP_MODES.map(mode => [
    mode,
    { flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: mode },
  ]),
) as Record<WrapMode, Styles>

export default function Text({
  color,
  backgroundColor,
  dim = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: Props): React.ReactNode {
  if (children === undefined || children === null) return null

  const textStyles: TextStyles = {}
  if (color) textStyles.color = color
  if (backgroundColor) textStyles.backgroundColor = backgroundColor
  if (dim) textStyles.dim = true
  if (bold) textStyles.bold = true
  if (italic) textStyles.italic = true
  if (underline) textStyles.underline = true
  if (strikethrough) textStyles.strikethrough = true
  if (inverse) textStyles.inverse = true

  return (
    <ink-text
      style={LAYOUT_STYLE_BY_WRAP[wrap] ?? LAYOUT_STYLE_BY_WRAP.wrap}
      textStyles={textStyles}
    >
      {children}
    </ink-text>
  )
}
