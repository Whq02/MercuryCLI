import React, { createContext, useContext } from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { resolveThemeColor } from '../../utils/color.js'
import { useTheme } from './ThemeProvider.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export const TextHoverColorContext = createContext<string | undefined>(
  undefined,
)

export type Props = Unbuilt

export default function ThemedText(arg0: Props): React.ReactNode {
  return notBuilt('src/components/design-system/ThemedText.tsx:27')
}
