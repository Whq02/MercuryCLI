import * as React from 'react'
import { AgentStudio } from '../../components/agents/studio/AgentStudio.js'
import type { ToolUseContext } from '../../Tool.js'
import { getTools } from '../../tools.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
): Promise<React.ReactNode> {
  const { toolPermissionContext } = context.getAppState()
  const tools = getTools(toolPermissionContext)
  return <AgentStudio tools={tools} onExit={onDone} />
}
