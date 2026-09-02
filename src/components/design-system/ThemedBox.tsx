
import React from 'react'
import Box, { type Props as BaseBoxProps } from '../../ink/components/Box.js'
import type { DOMElement } from '../../ink/dom.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { FocusEvent } from '../../ink/events/focus-event.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { resolveThemeColor } from './color.js'
import { useTheme } from './ThemeProvider.js'

type ThemeColor = (string & {}) | keyof Theme

type ThemedColorProp =
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor'
  | 'backgroundColor'

export type Props = Omit<
  BaseBoxProps,
  | ThemedColorProp
  | 'ref'
  | 'tabIndex'
  | 'autoFocus'
  | 'onClick'
  | 'onFocus'
  | 'onFocusCapture'
  | 'onBlur'
  | 'onBlurCapture'
  | 'onKeyDown'
  | 'onKeyDownCapture'
  | 'onMouseEnter'
  | 'onMouseLeave'
> & {
  readonly borderColor?: ThemeColor
  readonly borderTopColor?: ThemeColor
  readonly borderBottomColor?: ThemeColor
  readonly borderLeftColor?: ThemeColor
  readonly borderRightColor?: ThemeColor
  readonly backgroundColor?: ThemeColor
  readonly ref?: React.Ref<DOMElement>
  readonly tabIndex?: number
  readonly autoFocus?: boolean
  readonly onClick?: (event: ClickEvent) => void
  readonly onFocus?: (event: FocusEvent) => void
  readonly onFocusCapture?: (event: FocusEvent) => void
  readonly onBlur?: (event: FocusEvent) => void
  readonly onBlurCapture?: (event: FocusEvent) => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly onKeyDownCapture?: (event: KeyboardEvent) => void
  readonly onMouseEnter?: () => void
  readonly onMouseLeave?: () => void
}

export default function ThemedBox({
  borderColor,
  borderTopColor,
  borderBottomColor,
  borderLeftColor,
  borderRightColor,
  backgroundColor,
  children,
  ...rest
}: React.PropsWithChildren<Props>): React.ReactNode {
  const [themeName] = useTheme()
  useSessionAccent()
  const theme = getTheme(themeName)
  return (
    <Box
      {...rest}
      borderColor={resolveThemeColor(theme, borderColor)}
      borderTopColor={resolveThemeColor(theme, borderTopColor)}
      borderBottomColor={resolveThemeColor(theme, borderBottomColor)}
      borderLeftColor={resolveThemeColor(theme, borderLeftColor)}
      borderRightColor={resolveThemeColor(theme, borderRightColor)}
      backgroundColor={resolveThemeColor(theme, backgroundColor)}
    >
      {children}
    </Box>
  )
}
