import * as React from 'react'
import { Box, type ClickEvent, type DOMElement } from '../../ink.js'

// ============================================================================
//  InteractiveDisclosure — the ONE transcript disclosure shell (interaction-
//  finish). Every transcript row that genuinely reveals more content
//  (collapsed thinking, grouped read/search, folded error detail, agent
//  report, truncated tool results) renders through this wrapper:
//
//    · click TOGGLES open/closed (the owner keeps the expandedKeys state —
//      content derivation is untouched);
//    · hover/click handlers exist ONLY while `clickable` (the owner's
//      isItemClickable predicate — a row with nothing more to reveal takes
//      no handlers and previews no interactivity);
//    · the expanded state paints the SEMANTIC expanded background (the
//      theme-role string resolves per family) + a one-row bottom breath;
//      the TOP ROW's geometry never changes between states;
//    · handlers arrive PRE-BOUND and stable (the virtual list threads its
//      keyed callbacks — the GC-cheap shape the perf pass ratified).
//
//  Keyboard access rides the owner's existing message-actions path (cursor
//  + ↵ toggles the same expandedKeys); this shell is the pointer face.
// ============================================================================

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
