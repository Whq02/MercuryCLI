import * as React from 'react'
import { Box, Text, type DOMElement } from '../../ink.js'
import { claimHover, releaseHover, useHoverOwned } from './useHoverOwned.js'
import { useMercuryTokens } from './useMercuryTokens.js'


export type InteractiveRowProps = {
  id: string
  selected?: boolean
  focused?: boolean
  unavailable?: boolean
  reasonUnavailable?: string
  onSelect?: () => void
  onActivate?: () => void
  directActivate?: boolean
  selectionBand?: boolean
  actionLabel?: string
  rowRef?: React.Ref<DOMElement>
  width?: number | string
  height?: number
  flexDirection?: 'row' | 'column'
  flexShrink?: number
  flexGrow?: number
  hoverStyle?: 'chrome-ink' | 'row-fill'
  children: React.ReactNode | ((hover: boolean) => React.ReactNode)
}

export function rowActionHint(row: {
  actionLabel?: string
  unavailable?: boolean
}): string | undefined {
  return row.unavailable ? undefined : row.actionLabel
}

export function InteractiveRow({
  id,
  selected = false,
  focused = true,
  unavailable = false,
  reasonUnavailable,
  onSelect,
  onActivate,
  directActivate = false,
  selectionBand = true,
  rowRef,
  width,
  height,
  flexDirection,
  flexShrink,
  flexGrow,
  hoverStyle,
  children,
}: InteractiveRowProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const hover = useHoverOwned(id)
  const interactive = !unavailable && (!!onSelect || !!onActivate)
  const bandPainted =
    selectionBand &&
    selected &&
    focused &&
    !unavailable &&
    !directActivate &&
    typeof children !== 'function'

  const handleClick = interactive
    ? (): void => {
        if (directActivate) {
          onActivate?.()
          return
        }
        if (selected && focused) onActivate?.()
        else if (onSelect) onSelect()
        else if (focused) onActivate?.()
      }
    : undefined

  const renderedChildren = typeof children === 'function' ? children(interactive && hover) : children

  const hoverFillPainted =
    interactive &&
    hover &&
    (hoverStyle === 'row-fill' || (hoverStyle === undefined && typeof children !== 'function'))

  return (
    <Box
      ref={rowRef}
      width={width}
      height={height}
      flexDirection={flexDirection}
      flexShrink={flexShrink}
      flexGrow={flexGrow}
      overflow="hidden"
      backgroundColor={bandPainted ? tokens.selectionBand : hoverFillPainted ? tokens.surface2 : undefined}
      onClick={handleClick}
      onMouseEnter={interactive ? () => claimHover(id) : undefined}
      onMouseLeave={interactive ? () => releaseHover(id) : undefined}
    >
      {renderedChildren}
      {
}
      {unavailable && reasonUnavailable ? (
        <Text color={tokens.textMuted} wrap="truncate-end">{` — ${reasonUnavailable}`}</Text>
      ) : null}
    </Box>
  )
}
