import type { Tool } from '../../../tools/kit/tool.js'
import { registerProcessOutputErrorHandlers } from '../../../platform/processes/process.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
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
