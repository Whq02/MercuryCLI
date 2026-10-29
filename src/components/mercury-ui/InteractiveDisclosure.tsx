import * as React from 'react'
import { Box, type ClickEvent, type DOMElement } from '../../ink.js'


export function InteractiveDisclosure({
  rowRef,
  expanded,
  clickable,
  onToggle,
  onHoverIn,
  onHoverOut,
  children,
}: {
  rowRef?: React.Ref<DOMElement>
  expanded: boolean
  clickable: boolean
  onToggle?: (e: ClickEvent) => void
  onHoverIn?: () => void
  onHoverOut?: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box
      ref={rowRef}
      flexDirection="column"
      backgroundColor={expanded ? 'userMessageBackgroundHover' : undefined}
      paddingBottom={expanded ? 1 : undefined}
      onClick={clickable ? onToggle : undefined}
      onMouseEnter={clickable ? onHoverIn : undefined}
      onMouseLeave={clickable ? onHoverOut : undefined}
    >
      {children}
    </Box>
  )
}
