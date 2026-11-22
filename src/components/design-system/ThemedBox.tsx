import React from 'react'
import Box, { type Props as BaseBoxProps } from '../../ink/components/Box.js'
import type { DOMElement } from '../../ink/dom.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { FocusEvent } from '../../ink/events/focus-event.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { resolveThemeColor } from '../../utils/color.js'
import { useTheme } from './ThemeProvider.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ThemeColor = (string & {}) | keyof Theme

type ThemedColorProp =
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor'
  | 'backgroundColor'

export type Props = Unbuilt

export default function ThemedBox(arg0: React.PropsWithChildren<Props>): React.ReactNode {
  return notBuilt('src/components/design-system/ThemedBox.tsx:59')
}
