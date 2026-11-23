import { HooksConfigMenu } from '../../screen/event-hooks-menu/HooksConfigMenu.js'
import { getTools } from '../../tools/kit/toolList.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { toolPermissionContext } = context.getAppState()
  const toolNames = getTools(toolPermissionContext).map(tool => tool.name)
  return <HooksConfigMenu toolNames={toolNames} onExit={onDone} />
}
