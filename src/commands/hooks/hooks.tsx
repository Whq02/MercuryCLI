import * as React from 'react'
import { HooksConfigMenu } from '../../components/hooks/HooksConfigMenu.js'
import { getTools } from '../../tools.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { toolPermissionContext } = context.getAppState()
  const toolNames = getTools(toolPermissionContext).map(tool => tool.name)
  return <HooksConfigMenu toolNames={toolNames} onExit={onDone} />
}
