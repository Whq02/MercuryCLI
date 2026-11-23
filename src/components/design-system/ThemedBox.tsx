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

type ThemeColor = (string & {}) | keyof Theme

type ThemedColorProp =
  | 'borderColor'
  | 'borderTopColor'
  | 'borderBottomColor'
  | 'borderLeftColor'
  | 'borderRightColor'
  | 'backgroundColor'

type ThemedProps = { readonly [K in ThemedColorProp]?: ThemeColor } & {
  readonly ref?: React.Ref<DOMElement>
  readonly autoFocus?: boolean
  readonly tabIndex?: number
  readonly onClick?: (event: ClickEvent) => void
  readonly onBlur?: (event: FocusEvent) => void
  readonly onBlurCapture?: (event: FocusEvent) => void
  readonly onFocus?: (event: FocusEvent) => void
  readonly onFocusCapture?: (event: FocusEvent) => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly onKeyDownCapture?: (event: KeyboardEvent) => void
  readonly onMouseEnter?: () => void
  readonly onMouseLeave?: () => void
}

export type Props = Omit<BaseBoxProps, keyof ThemedProps> & ThemedProps

export default function ThemedBox({ borderColor, borderTopColor, borderBottomColor, borderLeftColor, borderRightColor, backgroundColor, ...props }: React.PropsWithChildren<Props>): React.ReactNode {
  const [name] = useTheme()
  const theme = getTheme(name)
  useSessionAccent()
  const resolve = (color: ThemeColor | undefined) => resolveThemeColor(theme, color as string | undefined)
  return (
    <Box {...props} borderColor={resolve(borderColor)} borderTopColor={resolve(borderTopColor)}
      borderBottomColor={resolve(borderBottomColor)} borderLeftColor={resolve(borderLeftColor)}
      borderRightColor={resolve(borderRightColor)} backgroundColor={resolve(backgroundColor)} />
  )
}
