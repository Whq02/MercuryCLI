// The theme-role-aware Text — re-exported by the estate's `src/ink.ts` as
// `Text`, which makes this the primitive practically every renderer draws
// through. A colour prop is a theme role key or a raw colour value; the
// legacy pre-rename role spellings are accepted as INPUT here (and only
// here — the box primitive and the string colouriser do not apply the map).
//
// Observed colour precedence: with no
// explicit colour and a hover colour present, hover wins; otherwise dim
// resolves to the theme's inactive role EVEN over an explicit colour;
// otherwise the explicit colour resolves. Dimming is the inactive colour,
// never ANSI dim, so it composes with bold.

import React, { createContext, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { isRawColorValue } from './color.js'
import { useTheme } from './ThemeProvider.js'

/** Legacy role aliases (contract data, input only): pre-rename spellings
 *  from persisted content still resolve. */
const LEGACY_ROLE_ALIASES: Record<string, keyof Theme> = {
  claude: 'brand',
  claudeShimmer: 'brandShimmer',
  claudeBlue_FOR_SYSTEM_SPINNER: 'systemSpinner',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'systemSpinnerShimmer',
  briefLabelClaude: 'briefLabelAssistant',
}

/** A subtree-wide hover tint for UNCOLOURED text: the renderer's own style
 *  cascade does not cross box boundaries, this context does. Carries an
 *  optional theme role key. */
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

/** Role-or-raw resolution with the legacy alias map applied; unknown roles
 *  resolve to nothing rather than throwing. Widened to the renderer's Color
 *  type: theme values are authored in the raw grammar and the colouriser
 *  returns unknown forms untouched. */
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
  // Accent-store subscription: a role-keyed colour must re-resolve when the
  // accent epoch moves, or it keeps the previous hue until an unrelated
  // repaint (the historical stale-prompt-box defect).
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
