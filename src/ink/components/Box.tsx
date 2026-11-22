import React, { forwardRef, type PropsWithChildren } from 'react'
import type { DOMElement } from '../dom.js'
import type { ClickEvent } from '../events/click-event.js'
import type { FocusEvent } from '../events/focus-event.js'
import type { KeyboardEvent } from '../events/keyboard-event.js'
import type { TextGestureHandler } from '../events/text-gesture.js'
import type { Styles } from '../styles.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Unbuilt } from '../../pi/holes.js'

export type Props = Unbuilt

const SPACING_PROPS = [
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'gap',
  'columnGap',
  'rowGap',
] as const

function checkSpacingIntegrality(style: Record<string, unknown>): void {
  for (const key of SPACING_PROPS) {
    const value = style[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      logForDebugging(`<Box> ${key} should be an integer, got ${String(value)}`, {
        level: 'warn',
      })
    }
  }
}

const Box = forwardRef<DOMElement, PropsWithChildren<Props>>(
  function Box(
    {
      children,
      tabIndex,
      autoFocus,
      onClick,
      onFocus,
      onFocusCapture,
      onBlur,
      onBlurCapture,
      onKeyDown,
      onKeyDownCapture,
      onMouseEnter,
      onMouseLeave,
      onTextGesture,
      ...style
    },
    ref,
  ) {
    checkSpacingIntegrality(style as Record<string, unknown>)
    const overflowX = style.overflowX ?? style.overflow ?? 'visible'
    const overflowY = style.overflowY ?? style.overflow ?? 'visible'
    const resolved: Styles = {
      ...style,
      flexWrap: style.flexWrap ?? 'nowrap',
      flexDirection: style.flexDirection ?? 'row',
      flexGrow: style.flexGrow ?? 0,
      flexShrink: style.flexShrink ?? 1,
      overflowX,
      overflowY,
    }
    return (
      <ink-box
        ref={ref}
        style={resolved}
        tabIndex={tabIndex}
        autoFocus={autoFocus}
        onClick={onClick}
        onFocus={onFocus}
        onFocusCapture={onFocusCapture}
        onBlur={onBlur}
        onBlurCapture={onBlurCapture}
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onTextGesture={onTextGesture}
      >
        {children}
      </ink-box>
    )
  },
)

export default Box
