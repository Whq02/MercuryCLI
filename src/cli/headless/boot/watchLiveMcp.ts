import type { ScopedMcpServerConfig, MCPServerConnection } from '../../../utils/mcp/types.js'
import { getMcpConfigByName, getMercuryMcpConfigs, filterMcpServersByPolicy } from '../../../services/mcp/config.js'
import { fetchToolsForClient, fetchCommandsForClient, fetchResourcesForClient, reconnectMcpServerImpl, clearServerCache, supplementaryToolsForMcpClient, pruneStaleMcpResourceTools } from '../../../services/mcp/client.js'
import { getMcpPrefix } from '../../../utils/mcp/mcpStringUtils.js'
import { requestDeliberateToolChange } from '../../../services/providers/lawfulPrefixChange.js'
import { processMainOwner } from '../../../utils/run/resolveOwner.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed } from '../../../services/mcp/dynamicMcpSeed.js'
import { watchLiveMcpConfig } from '../../../services/mcp/liveConfig.js'
import { mcpConfigAsWritten } from '../../../services/mcp/utils.js'
import { randomUUID } from 'node:crypto'
import { dropMcpServerFromAppState } from '../../../services/mcp/kitDial.js'
import { isMcpCatalogueMember } from '../../../services/mcp/membership.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

function run(ports: RunnerPorts): BootMade<'resolveServerConfigFromAllSources' | 'applyReconnectedClient' | 'mcpSignIns' | 'permittedMcpConfig' | 'reconnectLiveMcp' | 'liveMcp'> {
  return notBuilt('src/cli/headless/boot/watchLiveMcp.ts:16')
}

export const watchLiveMcp: BootStep<'resolveServerConfigFromAllSources' | 'applyReconnectedClient' | 'mcpSignIns' | 'permittedMcpConfig' | 'reconnectLiveMcp' | 'liveMcp'> = { name: 'watchLiveMcp', makes: ['resolveServerConfigFromAllSources', 'applyReconnectedClient', 'mcpSignIns', 'permittedMcpConfig', 'reconnectLiveMcp', 'liveMcp'], run }
