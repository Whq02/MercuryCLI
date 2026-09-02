// The tools a connected server exposes. Each row carries the display name
// (MCP prefix stripped) and its annotation classes — read-only, destructive,
// open-world — with the description tinted by severity.

import * as React from 'react'
import { Text } from '../../ink.js'
import { filterToolsByServer } from '../../services/mcp/utils.js'
import { getMcpDisplayName } from '../../services/mcp/mcpStringUtils.js'
import { useAppState } from '../../state/AppState.js'
import type { Tool } from '../../Tool.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import type { ServerInfo } from './types.js'

export function toolAnnotationWords(tool: {
  isReadOnly?: (input?: unknown) => boolean
  isDestructive?: (input?: unknown) => boolean
  isOpenWorld?: (input?: unknown) => boolean
}): string[] {
  const words: string[] = []
  if (tool.isReadOnly?.(undefined)) words.push('read-only')
  if (tool.isDestructive?.(undefined)) words.push('destructive')
  if (tool.isOpenWorld?.(undefined)) words.push('open-world')
  return words
}

export function MCPToolListView({
  server,
  onSelectTool,
  onBack,
}: {
  server: ServerInfo
  onSelectTool: (tool: Tool) => void
  onBack: () => void
}): React.ReactNode {
  const allTools = useAppState(state => state.mcp.tools)
  const tools =
    server.client.type === 'connected'
      ? filterToolsByServer(allTools, server.name)
      : []

  if (tools.length === 0) {
    return (
      <Dialog title={server.name} onCancel={onBack}>
        <Text dimColor>This server exposes no tools.</Text>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={server.name}
      subtitle={`${tools.length} ${plural(tools.length, 'tool')}`}
      onCancel={onBack}
    >
      <Select
        options={tools.map((tool, index) => {
          const words = toolAnnotationWords(tool)
          const tone = words.includes('destructive')
            ? 'error'
            : words.includes('read-only')
              ? 'success'
              : undefined
          return {
            label: (
              <Text>
                {getMcpDisplayName(tool.name, server.name)}
                {words.length > 0 ? (
                  <Text color={tone} dimColor={tone === undefined}>
                    {' '}
                    {words.join(', ')}
                  </Text>
                ) : null}
              </Text>
            ),
            value: String(index),
          }
        })}
        onChange={value => {
          const tool = tools[Number(value)]
          if (tool) onSelectTool(tool)
        }}
      />
    </Dialog>
  )
}
