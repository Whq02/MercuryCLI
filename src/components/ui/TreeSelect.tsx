import React, { useRef, useState } from 'react'
import { Box } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Select } from '../CustomSelect/select.js'
import { GLYPH } from '../../utils/glyphs.js'

const EXPANDED_MARKER = `${GLYPH.chevronDown} `
const COLLAPSED_MARKER = `${GLYPH.chevronRight} `
const CHILD_MARKER = '  ▸ '

type TreeNode<T> = {
  id: string
  label: string
  description?: string
  dimDescription?: boolean
  disabled?: boolean
  value: T
  children?: readonly TreeNode<T>[]
}

type TreeSelectProps<T> = {
  nodes: readonly TreeNode<T>[]
  onSelect: (node: TreeNode<T>) => void
  onFocus?: (node: TreeNode<T>) => void
  onCancel?: () => void
  onUpFromFirstItem?: () => void
  visibleOptionCount?: number
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  isDisabled?: boolean
  hideIndexes?: boolean
  isNodeExpanded?: (nodeId: string) => boolean
  onExpand?: (nodeId: string) => void
  onCollapse?: (nodeId: string) => void
}

type FlatRow<T> = {
  node: TreeNode<T>
  depth: number
  expanded: boolean
  hasChildren: boolean
  parentId: string | null
}

function flattenNodes<T>(
  nodes: readonly TreeNode<T>[],
  isExpanded: (id: string) => boolean,
  depth = 0,
  parentId: string | null = null,
  out: FlatRow<T>[] = [],
): FlatRow<T>[] {
  for (const node of nodes) {
    const hasChildren = (node.children?.length ?? 0) > 0
    const expanded = hasChildren && isExpanded(node.id)
    out.push({ node, depth, expanded, hasChildren, parentId })
    if (expanded && node.children) {
      flattenNodes(node.children, isExpanded, depth + 1, node.id, out)
    }
  }
  return out
}

export function TreeSelect<T>({
  nodes,
  onSelect,
  onFocus,
  onCancel,
  onUpFromFirstItem,
  visibleOptionCount,
  layout = 'expanded',
  isDisabled = false,
  hideIndexes,
  isNodeExpanded,
  onExpand,
  onCollapse,
}: TreeSelectProps<T>): React.ReactNode {
  const [localExpanded, setLocalExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined)
  const focusedIdRef = useRef<string | undefined>(undefined)
  const lastNotifiedIdRef = useRef<string | undefined>(undefined)

  const checkExpanded = (id: string): boolean =>
    isNodeExpanded ? isNodeExpanded(id) : localExpanded.has(id)

  const expandNode = (id: string): void => {
    if (onExpand) {
      onExpand(id)
    } else if (!isNodeExpanded) {
      setLocalExpanded(prev => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
    }
  }

  const collapseNode = (id: string): void => {
    if (onCollapse) {
      onCollapse(id)
    } else if (!isNodeExpanded) {
      setLocalExpanded(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const flat = flattenNodes(nodes, checkExpanded)
  const rowById = new Map<string, FlatRow<T>>()
  for (const row of flat) {
    rowById.set(row.node.id, row)
  }

  const options = flat.map(row => ({
    label: row.hasChildren
      ? `${row.expanded ? EXPANDED_MARKER : COLLAPSED_MARKER}${row.node.label}`
      : row.depth > 0
        ? `${CHILD_MARKER}${row.node.label}`
        : row.node.label,
    value: row.node.id,
    ...(row.node.description !== undefined ? { description: row.node.description } : {}),
    ...(row.node.dimDescription !== undefined ? { dimDescription: row.node.dimDescription } : {}),
    ...(row.node.disabled !== undefined ? { disabled: row.node.disabled } : {}),
  }))

  const handleSelect = (id: string): void => {
    const row = rowById.get(id)
    if (row) onSelect(row.node)
  }

  const handleFocus = (id: string): void => {
    focusedIdRef.current = id
    if (focusNodeId !== undefined && id !== focusNodeId) {
      setFocusNodeId(undefined)
    }
    if (lastNotifiedIdRef.current === id) return
    lastNotifiedIdRef.current = id
    const row = rowById.get(id)
    if (row) onFocus?.(row.node)
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (isDisabled) return
    const currentId =
      focusedIdRef.current !== undefined && rowById.has(focusedIdRef.current)
        ? focusedIdRef.current
        : flat[0]?.node.id
    if (currentId === undefined) return
    const current = rowById.get(currentId)
    if (!current) return

    if (e.key === 'right') {
      if (current.hasChildren && !current.expanded) {
        e.stopPropagation()
        expandNode(current.node.id)
      }
      return
    }

    if (e.key === 'left') {
      if (current.hasChildren && current.expanded) {
        e.stopPropagation()
        collapseNode(current.node.id)
        return
      }
      if (current.parentId !== null) {
        e.stopPropagation()
        const parent = rowById.get(current.parentId)
        focusedIdRef.current = current.parentId
        lastNotifiedIdRef.current = current.parentId
        setFocusNodeId(current.parentId)
        if (parent) {
          onFocus?.(parent.node)
        }
        collapseNode(current.parentId)
      }
    }
  }

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus={!isDisabled}
      onKeyDown={handleKeyDown}
    >
      <Select<string>
        options={options}
        defaultFocusValue={focusNodeId}
        onChange={handleSelect}
        onFocus={handleFocus}
        onCancel={onCancel}
        onUpFromFirstItem={onUpFromFirstItem}
        visibleOptionCount={visibleOptionCount}
        layout={layout}
        isDisabled={isDisabled}
        hideIndexes={hideIndexes}
      />
    </Box>
  )
}
