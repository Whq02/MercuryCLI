// One recorded tool call as `name(args)`, through the tool's own
// display contract: unknown tool → the raw name; otherwise the input is
// parsed with the tool's schema (empty object on parse failure) and the
// display name plus rendered arguments are shown — the bare display name
// with no arguments, the raw name when anything throws.

import React from 'react'
import { Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { ToolActivity } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Theme } from '../../utils/theme.js'

export function renderToolActivity(
  activity: ToolActivity,
  tools: Tools,
  theme: Theme,
): React.ReactNode {
  void theme
  const tool = findToolByName(tools, activity.toolName)
  if (!tool) return <Text>{activity.toolName}</Text>
  try {
    let input: unknown = {}
    try {
      const schema = (
        tool as { inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown } } }
      ).inputSchema
      const parsed = schema?.safeParse?.(activity.input)
      input = parsed?.success ? parsed.data : {}
    } catch {
      input = {}
    }
    const displayName =
      (tool as { userFacingName?: (input?: unknown) => string }).userFacingName?.(
        input,
      ) ?? activity.toolName
    if (displayName === '') return <Text>{activity.toolName}</Text>
    const rendered = (
      tool as {
        renderToolUseMessage?: (
          input?: unknown,
          options?: unknown,
        ) => React.ReactNode | string | null
      }
    ).renderToolUseMessage?.(input, { verbose: false })
    if (rendered === null || rendered === undefined || rendered === '') {
      return <Text>{displayName}</Text>
    }
    return (
      <Text>
        {displayName}({rendered})
      </Text>
    )
  } catch {
    return <Text>{activity.toolName}</Text>
  }
}
