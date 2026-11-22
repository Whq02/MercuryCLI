import axios from 'axios'
import memoize from 'lodash-es/memoize.js'

import { getOauthConfig } from '../../constants/oauth.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { clearMcpAuthCache } from './client/needsAuth.js'
import { normalizeNameForMCP } from '../../utils/mcp/normalization.js'
import type { ScopedMcpServerConfig } from '../../utils/mcp/types.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export function anthropicConnectorsArmed(canonical: string | undefined): boolean {
  if (canonical !== undefined && canonical !== '') return isEnvTruthy(canonical)
  return false
}

const REQUIRED_SCOPE = 'user:mcp_servers'

export const fetchAnthropicConnectorsIfEligible: Unbuilt = unbuilt('src/services/mcp/anthropicConnectors.ts:31')

function forgetConnectorFetch(): void {
  fetchAnthropicConnectorsIfEligible.cache?.clear?.()
}

export function clearAnthropicConnectorsCache(): void {
  fetchAnthropicConnectorsIfEligible.cache?.clear?.()
  clearMcpAuthCache()
}

export function markAnthropicConnectorConnected(name: string): void {
  return notBuilt('src/services/mcp/anthropicConnectors.ts:101')
}

export function hasAnthropicConnectorEverConnected(name: string): boolean {
  return notBuilt('src/services/mcp/anthropicConnectors.ts:109')
}
