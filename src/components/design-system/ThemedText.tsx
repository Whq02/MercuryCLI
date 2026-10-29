import React, { createContext, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { resolveThemeColor } from './color.js'
import { useTheme } from './ThemeProvider.js'

export const TextHoverColorContext = createContext<string | undefined>(
  undefined,
)

export type Props = {
  readonly color?: keyof Theme | (string & {})
  readonly backgroundColor?: keyof Theme | (string & {})
  readonly dimColor?: boolean
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
  readonly wrap?: NonNullable<Styles['textWrap']>
  readonly children?: React.ReactNode
}

export default function ThemedText({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: Props): React.ReactNode {
  const [themeName] = useTheme()

  useSessionAccent()
  const hoverColor = useContext(TextHoverColorContext)
  const theme = getTheme(themeName)

  let resolvedColor: Color | undefined
  if (!color && hoverColor) {
    resolvedColor = resolveThemeColor(theme, hoverColor)
  } else if (dimColor) {
    resolvedColor = theme.inactive as Color
  } else {
    resolvedColor = resolveThemeColor(theme, color)
  }

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolveThemeColor(theme, backgroundColor)}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  )
}
