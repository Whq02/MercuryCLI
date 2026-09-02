// The flex container: web-like defaults injected here, overflow normalised
// onto both axes, spacing integrality checked on the debug channel.

import React, { forwardRef, type PropsWithChildren } from 'react'
import type { DOMElement } from '../dom.js'
import type { ClickEvent } from '../events/click-event.js'
import type { FocusEvent } from '../events/focus-event.js'
import type { KeyboardEvent } from '../events/keyboard-event.js'
import type { Styles } from '../styles.js'
import { logForDebugging } from '../../utils/debug.js'

export type Props = Omit<Styles, 'textWrap'> & {
  readonly ref?: React.Ref<DOMElement>
  /** ≥ 0 participates in tab cycling; −1 is programmatically focusable
   *  only. */
  readonly tabIndex?: number
  /** Focus at mount, during the reconciler's mount phase. */
  readonly autoFocus?: boolean
  /** Bubbles from the deepest hit box up through ancestors; only works
   *  where mouse tracking is enabled (inside the alternate screen). */
  readonly onClick?: (event: ClickEvent) => void
  readonly onFocus?: (event: FocusEvent) => void
  readonly onFocusCapture?: (event: FocusEvent) => void
  readonly onBlur?: (event: FocusEvent) => void
  readonly onBlurCapture?: (event: FocusEvent) => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly onKeyDownCapture?: (event: KeyboardEvent) => void
  /** Do NOT bubble — moving between children does not re-fire on the
   *  parent. */
  readonly onMouseEnter?: () => void
  readonly onMouseLeave?: () => void
}

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
      // The debug channel only — the error stream would corrupt a live
      // frame. Not deduplicated by design.
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
      ...style
    },
    ref,
  ) {
    checkSpacingIntegrality(style as Record<string, unknown>)
    const overflowX = style.overflowX ?? style.overflow ?? 'visible'
    const overflowY = style.overflowY ?? style.overflow ?? 'visible'
    // The defaults apply to ABSENT and undefined values alike (a caller
    // forwarding `flexDirection={undefined}` still gets a row).
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
      >
        {children}
      </ink-box>
    )
  },
)

Box.displayName = 'Box'

export default Box
