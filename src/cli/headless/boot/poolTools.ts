import type { Tool } from '../../../Tool.js'
import { registerProcessOutputErrorHandlers } from '../../../utils/process.js'
import { noteRunPhase } from '../../../utils/runPhases.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'sessionTools' | 'canUseTool'> {
  const { asks, getAppState, tools } = ports
  const denyRules = getAppState().toolPermissionContext.alwaysDenyRules
  const startingMcpTools = (getAppState().mcp.tools as Tool[]).filter(tool => {
    const rules = Object.values(denyRules ?? {}).flat()
    return !rules.some(rule => rule === tool.name)
  })
  const sessionTools: Tool[] = [...tools, ...startingMcpTools]
  const canUseTool = asks.createCanUseTool()
  registerProcessOutputErrorHandlers()
  noteRunPhase('config_auth')
  return { sessionTools, canUseTool }
}

export const poolTools: BootStep<'sessionTools' | 'canUseTool'> = { name: 'poolTools', makes: ['sessionTools', 'canUseTool'], run }
