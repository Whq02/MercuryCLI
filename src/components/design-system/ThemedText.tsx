import React, { createContext, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { resolveThemeColor } from '../../utils/color.js'
import { useTheme } from './ThemeProvider.js'

export const TextHoverColorContext = createContext<string | undefined>(
  undefined,
)

export type Props = {
  readonly backgroundColor?: keyof Theme | (string & {})
  readonly color?: keyof Theme | (string & {})
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly inverse?: boolean
  readonly italic?: boolean
  readonly strikethrough?: boolean
  readonly underline?: boolean
  readonly wrap?: NonNullable<Styles['textWrap']>
  readonly children?: React.ReactNode
}

export default function ThemedText({ backgroundColor, color, bold = false, dimColor = false, inverse = false, italic = false, strikethrough = false, underline = false, wrap = 'wrap', children }: Props): React.ReactNode {
  const [name] = useTheme()
  const theme = getTheme(name)
  useSessionAccent()
  const hover = useContext(TextHoverColorContext)
  const foreground = !color && hover ? resolveThemeColor(theme, hover)
    : dimColor ? resolveThemeColor(theme, 'inactive') : resolveThemeColor(theme, color)
  return (
    <Text color={foreground} backgroundColor={resolveThemeColor(theme, backgroundColor)}
      bold={bold} italic={italic} underline={underline} strikethrough={strikethrough} inverse={inverse} wrap={wrap}>
      {children}
    </Text>
  )
}
