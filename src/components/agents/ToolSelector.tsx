import figures from 'figures'
import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { isMcpTool } from '../../services/mcp/utils.js'
import { mcpInfoFromString } from '../../utils/mcp/mcpStringUtils.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { filterToolsForAgent } from '../../tools/AgentTool/agentToolUtils.js'
import type { Tools } from '../../Tool.js'
import { plural } from '../../utils/stringUtils.js'
import Divider from '../design-system/Divider.js'

const READ_ONLY_BUCKET = new Set([
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
  'ProviderSearch',
  'TaskStop',
  'ContextLeft',
  'ListMcpResources',
  'ReadMcpResource',
])
const EDIT_BUCKET = new Set(['Edit', 'Write', 'NotebookEdit'])
const EXECUTION_BUCKET = new Set(['Bash'])

type Item =
  | { kind: 'continue' }
  | { kind: 'all'; members: string[] }
  | { kind: 'bucket'; label: string; members: string[] }
  | { kind: 'advanced-toggle' }
  | { kind: 'header'; label: string }
  | { kind: 'server'; label: string; members: string[] }
  | { kind: 'tool'; name: string }

function isSelectable(item: Item): boolean {
  return item.kind !== 'header'
}

function formatToolLabel(name: string): string {
  const info = mcpInfoFromString(name)
  if (info && info.toolName) {
    return `${info.toolName} (${info.serverName})`
  }
  return name
}

function buildItems(candidateTools: Tools, showAdvanced: boolean): Item[] {
  const candidateNames = candidateTools.map(tool => tool.name)
  const readOnly: string[] = []
  const edit: string[] = []
  const execution: string[] = []
  const mcp: string[] = []
  const other: string[] = []
  const byServer = new Map<string, string[]>()

  for (const tool of candidateTools) {
    if (READ_ONLY_BUCKET.has(tool.name)) {
      readOnly.push(tool.name)
    } else if (EDIT_BUCKET.has(tool.name)) {
      edit.push(tool.name)
    } else if (EXECUTION_BUCKET.has(tool.name)) {
      execution.push(tool.name)
    } else if (isMcpTool(tool)) {
      mcp.push(tool.name)
      const serverName = mcpInfoFromString(tool.name)?.serverName ?? 'unknown'
      const list = byServer.get(serverName) ?? []
      list.push(tool.name)
      byServer.set(serverName, list)
    } else {
      other.push(tool.name)
    }
  }

  const items: Item[] = [
    { kind: 'continue' },
    { kind: 'all', members: candidateNames },
  ]

  if (readOnly.length > 0) items.push({ kind: 'bucket', label: 'Read-only tools', members: readOnly })
  if (edit.length > 0) items.push({ kind: 'bucket', label: 'Edit tools', members: edit })
  if (execution.length > 0) items.push({ kind: 'bucket', label: 'Execution tools', members: execution })
  if (mcp.length > 0) items.push({ kind: 'bucket', label: 'MCP tools', members: mcp })
  if (other.length > 0) items.push({ kind: 'bucket', label: 'Other tools', members: other })

  items.push({ kind: 'advanced-toggle' })

  if (showAdvanced) {
    if (byServer.size > 0) {
      items.push({ kind: 'header', label: 'MCP servers' })
      const servers = [...byServer.entries()].sort(([a], [b]) => a.localeCompare(b))
      for (const [serverName, members] of servers) {
        items.push({
          kind: 'server',
          label: `${serverName} (${members.length} ${plural(members.length, 'tool')})`,
          members,
        })
      }
    }
    if (candidateNames.length > 0) {
      items.push({ kind: 'header', label: 'Individual tools' })
      for (const name of candidateNames) {
        items.push({ kind: 'tool', name })
      }
    }
  }

  return items
}

export function ToolSelector({
  tools,
  explicitSelection = false,
  initialTools,
  onComplete,
  onCancel,
}: {
  tools: Tools
  explicitSelection?: boolean
  initialTools: string[] | undefined
  onComplete: (tools: string[] | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  const candidateTools = useMemo(
    () =>
      filterToolsForAgent({ tools, isBuiltIn: false }).filter(
        tool => tool.name !== AGENT_TOOL_NAME,
      ),
    [tools],
  )
  const candidateNames = useMemo(
    () => candidateTools.map(tool => tool.name),
    [candidateTools],
  )

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTools === undefined || initialTools.includes('*')) {
      return new Set(candidateNames)
    }
    const allowed = new Set(candidateNames)
    return new Set(initialTools.filter(name => allowed.has(name)))
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)

  const items = useMemo(
    () => buildItems(candidateTools, showAdvanced),
    [candidateTools, showAdvanced],
  )

  const completeSelection = (): void => {
    if (candidateNames.every(name => selected.has(name)) && !explicitSelection) {
      onComplete(undefined)
      return
    }
    onComplete([...selected])
  }

  useKeybinding(
    'confirm:no',
    () => {
      if (onCancel) onCancel()
      else onComplete(initialTools)
    },
    { context: 'Confirmation' },
  )

  const toggleMembers = (members: string[]): void => {
    setSelected(prev => {
      const next = new Set(prev)
      const allSelected = members.length > 0 && members.every(m => next.has(m))
      if (allSelected) {
        for (const m of members) next.delete(m)
      } else {
        for (const m of members) next.add(m)
      }
      return next
    })
  }

  const moveFocus = (delta: -1 | 1): void => {
    setFocusIndex(prev => {
      let next = prev + delta
      while (next >= 0 && next < items.length) {
        const candidate = items[next]
        if (candidate && isSelectable(candidate)) {
          return next
        }
        next += delta
      }
      return prev
    })
  }

  const activateItem = (item: Item): void => {
    switch (item.kind) {
      case 'continue':
        completeSelection()
        break
      case 'all':
      case 'bucket':
      case 'server':
        toggleMembers(item.members)
        break
      case 'tool':
        setSelected(prev => {
          const next = new Set(prev)
          if (next.has(item.name)) next.delete(item.name)
          else next.add(item.name)
          return next
        })
        break
      case 'advanced-toggle':
        if (showAdvanced) {
          const toggleIdx = items.findIndex(entry => entry.kind === 'advanced-toggle')
          setShowAdvanced(false)
          if (toggleIdx >= 0 && focusIndex > toggleIdx) {
            setFocusIndex(toggleIdx)
          }
        } else {
          setShowAdvanced(true)
        }
        break
      case 'header':
        break
    }
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'up') {
      event.preventDefault()
      event.stopImmediatePropagation()
      moveFocus(-1)
      return
    }
    if (event.key === 'down') {
      event.preventDefault()
      event.stopImmediatePropagation()
      moveFocus(1)
      return
    }
    if (event.key === 'return' || event.key === 'enter' || event.key === ' ') {
      const item = items[focusIndex]
      if (!item) return
      event.preventDefault()
      event.stopImmediatePropagation()
      activateItem(item)
    }
  }

  const allSelected =
    candidateNames.length > 0 && candidateNames.every(name => selected.has(name))
  const summaryText = allSelected
    ? 'All tools selected'
    : `${selected.size} of ${candidateNames.length} tools selected`

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {items.map((item, idx) => {
        const focused = idx === focusIndex
        const pointer = focused ? `${figures.pointer} ` : '  '
        switch (item.kind) {
          case 'continue':
            return (
              <React.Fragment key="continue">
                <Text color={focused ? 'suggestion' : undefined} bold={focused}>
                  {pointer}[ Continue ]
                </Text>
                <Divider />
              </React.Fragment>
            )
          case 'all': {
            const checked =
              item.members.length > 0 && item.members.every(m => selected.has(m))
            return (
              <Text key="all" color={focused ? 'suggestion' : undefined} bold={focused}>
                {pointer}
                {checked ? figures.checkboxOn : figures.checkboxOff} All tools
              </Text>
            )
          }
          case 'bucket': {
            const checked =
              item.members.length > 0 && item.members.every(m => selected.has(m))
            return (
              <Text
                key={`bucket:${item.label}`}
                color={focused ? 'suggestion' : undefined}
                bold={focused}
              >
                {pointer}
                {checked ? figures.checkboxOn : figures.checkboxOff} {item.label}
              </Text>
            )
          }
          case 'advanced-toggle':
            return (
              <Box key="advanced-toggle" marginTop={1}>
                <Text color={focused ? 'suggestion' : undefined} bold={focused}>
                  {pointer}
                  {showAdvanced ? 'Hide' : 'Show'} advanced options
                </Text>
              </Box>
            )
          case 'header':
            return (
              <Box key={`header:${item.label}`} marginTop={1}>
                <Text dimColor bold>
                  {item.label}
                </Text>
              </Box>
            )
          case 'server': {
            const checked =
              item.members.length > 0 && item.members.every(m => selected.has(m))
            return (
              <Text
                key={`server:${item.label}`}
                color={focused ? 'suggestion' : undefined}
                bold={focused}
              >
                {pointer}
                {checked ? figures.checkboxOn : figures.checkboxOff} {item.label}
              </Text>
            )
          }
          case 'tool': {
            const checked = selected.has(item.name)
            return (
              <Text
                key={`tool:${item.name}`}
                color={focused ? 'suggestion' : undefined}
                bold={focused}
              >
                {pointer}
                {checked ? figures.checkboxOn : figures.checkboxOff}{' '}
                {formatToolLabel(item.name)}
              </Text>
            )
          }
        }
      })}
      <Box marginTop={1}>
        <Text dimColor>{summaryText}</Text>
      </Box>
    </Box>
  )
}

export default ToolSelector
