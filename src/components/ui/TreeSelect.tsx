// Tree-flattening single select: depth-first flatten over the
// underlying single-select list. Expansion is controlled (predicate +
// callbacks win) or uncontrolled (an internal set). The horizontal keys
// are driven by the caller's focused-node id, NOT the list's internal
// cursor — a caller that never passes it gets no expand/collapse at all.
// Programmatic focus moves are latched so the resulting focus callback is
// swallowed, and repeated focus on the same id is suppressed.

import React, { useRef, useState } from 'react'
import { Box } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Select } from '../CustomSelect/select.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

// The kit's two-state disclosure pair: › folded, ⌄ open (the ▶ it replaces
// carries the Unicode Emoji property and paints as a pictograph on hosts
// that route emoji-eligible code points to a colour font).
const EXPANDED_MARKER = `${GLYPH.chevronDown} `
const COLLAPSED_MARKER = `${GLYPH.chevronRight} `
const CHILD_MARKER = '  ▸ '

export type TreeNode<T> = {
  id: string
  value: T
  label: string
  description?: string
  dimDescription?: boolean
  children?: TreeNode<T>[]
  metadata?: Record<string, unknown>
}

export type TreeSelectProps<T> = {
  nodes: TreeNode<T>[]
  /** Drives the horizontal keys; without it no expand/collapse runs. */
  focusedNodeId?: string
  /** Controlled expansion: when supplied it wins over the internal set. */
  isNodeExpanded?: (nodeId: string) => boolean
  onExpand?: (nodeId: string) => void
  onCollapse?: (nodeId: string) => void
  onFocus?: (node: TreeNode<T>) => void
  onSelect?: (node: TreeNode<T>) => void
  onCancel?: () => void
  onUpFromFirstItem?: () => void
  visibleOptionCount?: number
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  isDisabled?: boolean
  hideIndexes?: boolean
}

type FlatRow<T> = {
  node: TreeNode<T>
  depth: number
  expanded: boolean
  hasChildren: boolean
  parentId: string | null
}

export function TreeSelect<T>({
  nodes,
  focusedNodeId,
  isNodeExpanded,
  onExpand,
  onCollapse,
  onFocus,
  onSelect,
  onCancel,
  onUpFromFirstItem,
  visibleOptionCount,
  layout = 'expanded',
  isDisabled = false,
  hideIndexes = false,
}: TreeSelectProps<T>): React.ReactNode {
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set(),
  )
  const expandedOf = (nodeId: string): boolean =>
    isNodeExpanded ? isNodeExpanded(nodeId) : internalExpanded.has(nodeId)
  const expand = (nodeId: string): void => {
    if (onExpand) onExpand(nodeId)
    else setInternalExpanded(prev => new Set([...prev, nodeId]))
  }
  const collapse = (nodeId: string): void => {
    if (onCollapse) onCollapse(nodeId)
    else
      setInternalExpanded(prev => {
        const next = new Set(prev)
        next.delete(nodeId)
        return next
      })
  }

  // Depth-first flatten; children only under an expanded parent.
  const rows: FlatRow<T>[] = []
  const walk = (list: TreeNode<T>[], depth: number, parentId: string | null): void => {
    for (const node of list) {
      const hasChildren = (node.children?.length ?? 0) > 0
      const expanded = hasChildren && expandedOf(node.id)
      rows.push({ node, depth, expanded, hasChildren, parentId })
      if (expanded) walk(node.children!, depth + 1, node.id)
    }
  }
  walk(nodes, 0, null)

  const byId = new Map(rows.map(row => [row.node.id, row]))

  // Programmatic-focus latch + same-id suppression.
  const suppressFocusIdRef = useRef<string | null>(null)
  const lastFocusIdRef = useRef<string | null>(null)
  const [programmaticFocusId, setProgrammaticFocusId] = useState<string | undefined>(
    undefined,
  )

  const moveFocusTo = (nodeId: string): void => {
    suppressFocusIdRef.current = nodeId
    setProgrammaticFocusId(nodeId)
  }

  // The wrapper takes focus itself so it receives the horizontal keys; a
  // handled key is marked handled (preventDefault + stop) so the list does
  // not also act on it.
  const handleKeyDown = (event: KeyboardEvent): void => {
    // No focused-node id, or disabled ⇒ no expand/collapse at all.
    if (isDisabled || focusedNodeId === undefined) return
    const focusedRow = byId.get(focusedNodeId)
    if (!focusedRow) return
    if (event.key === 'right') {
      if (focusedRow.hasChildren && !focusedRow.expanded) expand(focusedRow.node.id)
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (event.key === 'left') {
      if (focusedRow.hasChildren && focusedRow.expanded) {
        collapse(focusedRow.node.id)
      } else if (focusedRow.parentId !== null) {
        // Collapse the PARENT and move focus to it.
        collapse(focusedRow.parentId)
        moveFocusTo(focusedRow.parentId)
      }
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  const labelFor = (row: FlatRow<T>): string => {
    if (row.hasChildren) {
      return `${row.expanded ? EXPANDED_MARKER : COLLAPSED_MARKER}${row.node.label}`
    }
    if (row.depth > 0) return `${CHILD_MARKER}${row.node.label}`
    return row.node.label
  }

  return (
    <Box flexDirection="column" tabIndex={-1} autoFocus onKeyDown={handleKeyDown}>
    <Select<string>
      isDisabled={isDisabled}
      hideIndexes={hideIndexes}
      visibleOptionCount={visibleOptionCount}
      layout={layout}
      options={rows.map(row => ({
        value: row.node.id,
        label: labelFor(row),
        ...(row.node.description !== undefined
          ? {
              description: row.node.description,
              dimDescription: row.node.dimDescription ?? true,
            }
          : {}),
      }))}
      defaultFocusValue={programmaticFocusId ?? focusedNodeId}
      onFocus={id => {
        if (suppressFocusIdRef.current === id) {
          // The latched programmatic move's own callback is swallowed.
          suppressFocusIdRef.current = null
          lastFocusIdRef.current = id
          return
        }
        if (lastFocusIdRef.current === id) return
        lastFocusIdRef.current = id
        const row = byId.get(id)
        if (row) onFocus?.(row.node)
      }}
      onChange={id => {
        const row = byId.get(id)
        if (row) onSelect?.(row.node)
      }}
      onCancel={onCancel}
      onUpFromFirstItem={onUpFromFirstItem}
    />
    </Box>
  )
}
