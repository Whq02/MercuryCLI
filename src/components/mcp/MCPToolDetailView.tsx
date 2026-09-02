// One MCP tool's detail: names, async-loaded description, and the parameter
// list from its input JSON schema. The description probe runs against a
// FRESHLY CONSTRUCTED neutral permission context — default mode, nothing
// granted, bypass unavailable — so it can never inherit or mutate live
// permission state.

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getMcpDisplayName } from '../../services/mcp/mcpStringUtils.js'
import { getEmptyToolPermissionContext, type Tool } from '../../Tool.js'
import { Dialog } from '../design-system/Dialog.js'
import { toolAnnotationWords } from './MCPToolListView.js'
import type { ServerInfo } from './types.js'

export function MCPToolDetailView({
  tool,
  server,
  onBack,
}: {
  tool: Tool
  server: ServerInfo
  onBack: () => void
}): React.ReactNode {
  const [description, setDescription] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void tool
      .description(undefined, {
        isNonInteractiveSession: false,
        toolPermissionContext: getEmptyToolPermissionContext(),
        tools: [],
      })
      .then(text => {
        if (live) setDescription(text)
      })
      .catch(() => {
        if (live) setDescription('The description failed to load.')
      })
    return () => {
      live = false
    }
  }, [tool])

  const words = toolAnnotationWords(tool)
  const schema = tool.inputJSONSchema as
    | {
        properties?: Record<
          string,
          { type?: string; description?: string } | undefined
        >
        required?: string[]
      }
    | undefined
  const properties = Object.entries(schema?.properties ?? {})
  const required = new Set(schema?.required ?? [])
  const rawName =
    (tool as { mcpInfo?: { toolName?: string } }).mcpInfo?.toolName ?? tool.name

  return (
    <Dialog
      title={
        <Text>
          {getMcpDisplayName(tool.name, server.name)}
          {words.length > 0 ? <Text dimColor> [{words.join(', ')}]</Text> : null}
        </Text>
      }
      subtitle={server.name}
      onCancel={onBack}
    >
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Registered as: </Text>
          {tool.name}
        </Text>
        <Text>
          <Text dimColor>Raw name: </Text>
          {rawName}
        </Text>
        <Box marginTop={1}>
          {description === null ? (
            <Text dimColor>Loading description…</Text>
          ) : (
            <Text wrap="wrap">{description}</Text>
          )}
        </Box>
        {properties.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Parameters</Text>
            {properties.map(([name, property]) => (
              <Text key={name} wrap="wrap">
                {'  '}
                <Text bold>{name}</Text>
                {required.has(name) ? <Text color="warning">*</Text> : null}
                <Text dimColor> {property?.type ?? 'unknown'}</Text>
                {property?.description ? (
                  <Text dimColor> — {property.description}</Text>
                ) : null}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    </Dialog>
  )
}
