
import React, { createContext, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { isRawColorValue } from './color.js'
import { useTheme } from './ThemeProvider.js'

const LEGACY_ROLE_ALIASES: Record<string, keyof Theme> = {
  claude: 'brand',
  claudeShimmer: 'brandShimmer',
  claudeBlue_FOR_SYSTEM_SPINNER: 'systemSpinner',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'systemSpinnerShimmer',
  briefLabelClaude: 'briefLabelAssistant',
}

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

function resolveWithAliases(
  theme: Theme,
  value: string | undefined,
): Color | undefined {
  if (!value) return undefined
  if (isRawColorValue(value)) return value as Color
  const role = LEGACY_ROLE_ALIASES[value] ?? (value as keyof Theme)
  return theme[role] as Color | undefined
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
    resolvedColor = resolveWithAliases(theme, hoverColor)
  } else if (dimColor) {
    resolvedColor = theme.inactive as Color
  } else {
    resolvedColor = resolveWithAliases(theme, color)
  }

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolveWithAliases(theme, backgroundColor)}
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
