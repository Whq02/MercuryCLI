import type { MCPServerConnection, ConnectedMCPServer } from '../../../utils/mcp/types.js'
import * as printTurn from '../printTurn.js'
import { getAllBaseTools } from '../../../tools.js'
import type { AppState } from '../../../state/AppStateStore.js'
import type { Tool } from '../../../Tool.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'elicitationRegistered' | 'registerPerTurnHandlers' | 'registerElicitationHandlersForClient' | 'baseToolNames' | 'answerSchemaOf' | 'assembleTools'> {
  const { live, options } = ports
  const elicitationRegistered = new Set<string>()
  const registerPerTurnHandlers = (clients: MCPServerConnection[]): void => printTurn.registerPerTurnHandlers(clients, ports)
  const registerElicitationHandlersForClient = (client: ConnectedMCPServer, serverName: string): Promise<void> => printTurn.registerElicitationHandlersForClient(client, serverName, ports)

  const baseToolNames = new Set(getAllBaseTools().map(tool => tool.name))
  const answerSchemaOf = (turnSchema: Record<string, unknown> | undefined): Record<string, unknown> | undefined => turnSchema ?? live.initializeJsonSchema ?? options.jsonSchema
  const assembleTools = (state: AppState, turnSchema?: Record<string, unknown>): Tool[] => printTurn.assembleTurnTools(state, turnSchema, ports)
  return { elicitationRegistered, registerPerTurnHandlers, registerElicitationHandlersForClient, baseToolNames, answerSchemaOf, assembleTools }
}

export const bindTurnTools: BootStep<'elicitationRegistered' | 'registerPerTurnHandlers' | 'registerElicitationHandlersForClient' | 'baseToolNames' | 'answerSchemaOf' | 'assembleTools'> = { name: 'bindTurnTools', makes: ['elicitationRegistered', 'registerPerTurnHandlers', 'registerElicitationHandlersForClient', 'baseToolNames', 'answerSchemaOf', 'assembleTools'], run }
