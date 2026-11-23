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


export function anthropicConnectorsArmed(canonical: string | undefined): boolean {
  if (canonical !== undefined && canonical !== '') return isEnvTruthy(canonical)
  return false
}

const REQUIRED_SCOPE = 'user:mcp_servers'

type ConnectorRow = {
  id: string
  display_name: string
  url: string
}

type ConnectorsResponse = {
  data?: ConnectorRow[]
}

export const fetchAnthropicConnectorsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    if (!anthropicConnectorsArmed(flagEnv('MERCURY_ANTHROPIC_CONNECTORS'))) {
      logForDebugging('claudeai MCP: not armed (opt in with MERCURY_ANTHROPIC_CONNECTORS=1)')
      return {}
    }

    const tokens = getClaudeAIOAuthTokens()
    if (!tokens?.accessToken) {
      logForDebugging('claudeai MCP: no OAuth access token; skipping connector fetch')
      return {}
    }

    const scopes: string[] = tokens.scopes ?? []
    if (!scopes.includes(REQUIRED_SCOPE)) {
      const has = scopes.length > 0 ? scopes.join(', ') : 'none'
      logForDebugging(`claudeai MCP: token lacks ${REQUIRED_SCOPE} (has: ${has})`)
      return {}
    }

    try {
      const url = `${getOauthConfig().BASE_API_URL}/v1/mcp_servers?limit=1000`
      const response = await axios.get<ConnectorsResponse>(url, {
        timeout: 5_000,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-beta': 'mcp-servers-2025-12-04',
          'anthropic-version': '2023-06-01',
        },
      })
      const rows = response.data?.data ?? []
      const servers: Record<string, ScopedMcpServerConfig> = {}
      const seenNormalized = new Set<string>()
      for (const row of rows) {
        const baseName = `claude.ai ${row.display_name}`
        let name = baseName
        let normalized = normalizeNameForMCP(name)
        let suffix = 2
        while (seenNormalized.has(normalized)) {
          name = `${baseName} (${suffix})`
          normalized = normalizeNameForMCP(name)
          suffix++
        }
        seenNormalized.add(normalized)
        servers[name] = {
          type: 'claudeai-proxy',
          url: row.url,
          id: row.id,
          scope: 'claudeai',
        }
      }
      logForDebugging(`claudeai MCP: ${Object.keys(servers).length} connector(s) fetched`)
      return servers
    } catch (err) {
      logForDebugging(`claudeai MCP: connector fetch failed: ${String(err)}`)
      forgetConnectorFetch()
      return {}
    }
  },
)

function forgetConnectorFetch(): void {
  fetchAnthropicConnectorsIfEligible.cache?.clear?.()
}

export function clearAnthropicConnectorsCache(): void {
  fetchAnthropicConnectorsIfEligible.cache?.clear?.()
  clearMcpAuthCache()
}

export function markAnthropicConnectorConnected(name: string): void {
  saveGlobalConfig(current => {
    const existing = current.claudeAiMcpEverConnected ?? []
    if (existing.includes(name)) return current
    return {
      ...current,
      claudeAiMcpEverConnected: [...existing, name],
    }
  })
}

export function hasAnthropicConnectorEverConnected(name: string): boolean {
  const list = getGlobalConfig().claudeAiMcpEverConnected
  if (!Array.isArray(list)) return false
  return list.includes(name)
}
