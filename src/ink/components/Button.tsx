// A focusable, activatable box. INTENTIONALLY UNSTYLED — the render prop is
// the only styling channel.

import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { DOMElement } from '../dom.js'
import type { KeyboardEvent } from '../events/keyboard-event.js'
import type { Styles } from '../styles.js'
import Box from './Box.js'

export type ButtonState = {
  readonly focused: boolean
  readonly hovered: boolean
  readonly active: boolean
}

export type Props = Omit<Styles, 'textWrap'> & {
  readonly ref?: React.Ref<DOMElement>
  readonly onActivate: () => void
  readonly tabIndex?: number
  readonly autoFocus?: boolean
  readonly children?:
    | React.ReactNode
    | ((state: ButtonState) => React.ReactNode)
}

const ACTIVE_PULSE_MS = 100

const Button = forwardRef<DOMElement, Props>(function Button(
  { onActivate, tabIndex = 0, autoFocus, children, ...style },
  ref,
) {
  const [focused, setFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [active, setActive] = useState(false)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
    },
    [],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'return' && event.key !== ' ') return
      event.preventDefault()
      setActive(true)
      onActivate()
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
      pulseTimer.current = setTimeout(() => {
        pulseTimer.current = null
        setActive(false)
      }, ACTIVE_PULSE_MS)
    },
    [onActivate],
  )

  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback(() => setFocused(false), [])
  const onMouseEnter = useCallback(() => setHovered(true), [])
  const onMouseLeave = useCallback(() => setHovered(false), [])
  const onClick = useCallback(() => onActivate(), [onActivate])

  const state: ButtonState = { focused, hovered, active }
  return (
    <Box
      {...style}
      ref={ref}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {typeof children === 'function' ? children(state) : children}
    </Box>
  )
})

export default Button
