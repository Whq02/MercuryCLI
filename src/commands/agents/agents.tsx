import * as React from 'react'
import { AgentStudio } from '../../screen/agents/studio/AgentStudio.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { getTools } from '../../tools/kit/toolList.js'
import type { LocalJSXCommandOnDone } from '../catalogue/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
): Promise<React.ReactNode> {
  const { toolPermissionContext } = context.getAppState()
  const tools = getTools(toolPermissionContext)
  return <AgentStudio tools={tools} onExit={onDone} />
}
