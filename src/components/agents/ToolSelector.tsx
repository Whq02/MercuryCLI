// The agent tool allowlist editor: buckets, MCP server groups, and
// individual tools. Continue reports NOTHING when every candidate tool is
// selected — meaning "all tools", not an explicit list. The working
// selection is filtered against the candidate names on every render, so a
// stale stored name never counts toward totals.

import figures from 'figures'
import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { isMcpTool } from '../../services/mcp/utils.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { filterToolsForAgent } from '../../tools/AgentTool/agentToolUtils.js'
import type { Tools } from '../../Tool.js'
import { plural } from '../../utils/stringUtils.js'
import Divider from '../design-system/Divider.js'

/** Bucket membership (contract data — runtime tool names). Determined
 *  MCP-first, then read-only, edit, execution, other; the agent-spawning
 *  tool is excluded entirely. */
const READ_ONLY_BUCKET = new Set([
  'Glob',
  'Grep',
  'ExitPlanMode',
  'Read',
  'WebFetch',
  'TodoWrite',
  'WebSearch',
  'ProviderSearch',
  'TaskStop',
  'TaskOutput',
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

export function ToolSelector({
  tools,
  initialTools,
  onComplete,
  onCancel,
}: {
  tools: Tools
  initialTools: string[] | undefined
  onComplete: (tools: string[] | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  // The agent-eligible candidate set for a non-built-in, non-async agent,
  // minus the agent-spawning tool.
  const candidates = useMemo(
    () =>
      filterToolsForAgent({ tools, isBuiltIn: false, isAsync: false })
        .map(tool => tool.name)
        .filter(name => name !== AGENT_TOOL_NAME),
    [tools],
  )
  const candidateSet = useMemo(() => new Set(candidates), [candidates])

  // An absent list, or one containing the wildcard, expands to everything.
  const [stored, setStored] = useState<string[]>(() =>
    initialTools === undefined || initialTools.includes('*')
      ? [...candidates]
      : initialTools,
  )
  // Filtered against candidates every render; the stored list may still
  // hold stale names.
  const selection = stored.filter(name => candidateSet.has(name))
  const selectionSet = new Set(selection)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)

  const mcpTools = candidates.filter(name => isMcpTool({ name }))
  const nonMcp = candidates.filter(name => !isMcpTool({ name }))
  const readOnly = nonMcp.filter(name => READ_ONLY_BUCKET.has(name))
  const edit = nonMcp.filter(name => EDIT_BUCKET.has(name))
  const execution = nonMcp.filter(name => EXECUTION_BUCKET.has(name))
  const other = nonMcp.filter(
    name =>
      !READ_ONLY_BUCKET.has(name) &&
      !EDIT_BUCKET.has(name) &&
      !EXECUTION_BUCKET.has(name),
  )

  const servers = new Map<string, string[]>()
  for (const name of mcpTools) {
    const info = mcpInfoFromString(name)
    const server = info?.serverName ?? name
    const members = servers.get(server)
    if (members) members.push(name)
    else servers.set(server, [name])
  }
  const serverNames = [...servers.keys()].sort()

  const items: Item[] = [
    { kind: 'continue' },
    { kind: 'all', members: candidates },
  ]
  if (readOnly.length > 0) {
    items.push({ kind: 'bucket', label: 'Read-only tools', members: readOnly })
  }
  if (edit.length > 0) {
    items.push({ kind: 'bucket', label: 'Edit tools', members: edit })
  }
  if (execution.length > 0) {
    items.push({ kind: 'bucket', label: 'Execution tools', members: execution })
  }
  if (mcpTools.length > 0) {
    items.push({ kind: 'bucket', label: 'MCP tools', members: mcpTools })
  }
  if (other.length > 0) {
    items.push({ kind: 'bucket', label: 'Other tools', members: other })
  }
  items.push({ kind: 'advanced-toggle' })
  if (showAdvanced) {
    if (serverNames.length > 0) {
      items.push({ kind: 'header', label: 'MCP servers' })
      for (const server of serverNames) {
        const members = servers.get(server) ?? []
        items.push({
          kind: 'server',
          label: `${server} (${members.length} ${plural(members.length, 'tool')})`,
          members,
        })
      }
      items.push({ kind: 'header', label: 'Individual tools' })
    }
    for (const name of candidates) items.push({ kind: 'tool', name })
  }

  const clampedFocus = Math.min(focusIndex, items.length - 1)
  const focused = items[clampedFocus]

  const toggleMembers = (members: string[]): void => {
    const allSelected = members.every(name => selectionSet.has(name))
    if (allSelected) {
      setStored(selection.filter(name => !members.includes(name)))
    } else {
      const merged = new Set(selection)
      for (const name of members) merged.add(name)
      setStored([...merged])
    }
  }

  const runItem = (item: Item): void => {
    switch (item.kind) {
      case 'continue':
        // Everything selected means "all tools", not an explicit list.
        onComplete(
          selection.length === candidates.length ? undefined : selection,
        )
        break
      case 'all':
      case 'bucket':
      case 'server':
        toggleMembers(item.members)
        break
      case 'tool':
        toggleMembers([item.name])
        break
      case 'advanced-toggle': {
        const next = !showAdvanced
        setShowAdvanced(next)
        // Hiding while focus sits below the toggle moves focus back here.
        if (!next) {
          const at = items.findIndex(i => i.kind === 'advanced-toggle')
          if (clampedFocus > at) setFocusIndex(at)
        }
        break
      }
      case 'header':
        break
    }
  }

  const move = (direction: 1 | -1): void => {
    let next = clampedFocus
    do {
      next += direction
    } while (next >= 0 && next < items.length && !isSelectable(items[next]!))
    if (next >= 0 && next < items.length) setFocusIndex(next)
  }

  useKeybinding(
    'confirm:no',
    () => {
      if (onCancel) onCancel()
      else onComplete(initialTools)
    },
    { context: 'Confirmation' },
  )

  const checkbox = (members: string[]): string =>
    members.length > 0 && members.every(name => selectionSet.has(name))
      ? figures.checkboxOn
      : figures.checkboxOff

  const advancedAt = items.findIndex(i => i.kind === 'advanced-toggle')
  let sawHeader = false

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      tabIndex={-1}
      autoFocus
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'up') {
          move(-1)
          event.stopImmediatePropagation()
        } else if (event.key === 'down') {
          move(1)
          event.stopImmediatePropagation()
        } else if (event.key === 'return') {
          if (focused && focused.kind !== 'header') runItem(focused)
          event.stopImmediatePropagation()
        }
      }}
    >
      {items.map((item, index) => {
        const isFocused = index === clampedFocus
        const pointer = isFocused ? figures.pointer : ' '
        let row: React.ReactNode
        switch (item.kind) {
          case 'continue':
            row = (
              <Text bold={isFocused}>
                {pointer} [ Continue ]
              </Text>
            )
            break
          case 'all':
            row = (
              <Text bold={isFocused}>
                {pointer} {checkbox(item.members)} All tools
              </Text>
            )
            break
          case 'bucket':
          case 'server':
            row = (
              <Text bold={isFocused}>
                {pointer} {checkbox(item.members)} {item.label}
              </Text>
            )
            break
          case 'advanced-toggle':
            row = (
              <Text bold={isFocused}>
                {pointer} {showAdvanced ? 'Hide' : 'Show'} advanced options
              </Text>
            )
            break
          case 'header':
            row = <Text dimColor>{item.label}</Text>
            break
          case 'tool': {
            const info = item.name.startsWith('mcp__')
              ? mcpInfoFromString(item.name)
              : null
            const display =
              info && info.toolName !== undefined
                ? `${info.toolName} (${info.serverName})`
                : item.name
            row = (
              <Text bold={isFocused}>
                {pointer} {checkbox([item.name])} {display}
              </Text>
            )
            break
          }
        }
        const blankBeforeHeader = item.kind === 'header' && sawHeader
        if (item.kind === 'header') sawHeader = true
        return (
          <Box key={index} flexDirection="column">
            {index === 1 || index === advancedAt ? (
              <Divider width={40} />
            ) : null}
            {blankBeforeHeader ? <Box height={1} /> : null}
            {row}
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {selection.length === candidates.length
            ? 'All tools selected'
            : `${selection.length} of ${candidates.length} tools selected`}
        </Text>
      </Box>
    </Box>
  )
}

export default ToolSelector
