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
import { notBuilt } from '../../pi/holes.js'

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

export function ToolSelector(arg0: {
  tools: Tools
  explicitSelection?: boolean
  initialTools: string[] | undefined
  onComplete: (tools: string[] | undefined) => void
  onCancel?: () => void
}): React.ReactNode {
  return notBuilt('src/components/agents/ToolSelector.tsx:43')
}

export default ToolSelector
