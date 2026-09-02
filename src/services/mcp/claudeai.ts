import axios from 'axios'
import memoize from 'lodash-es/memoize.js'

import { getOauthConfig } from '../../constants/oauth.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { ScopedMcpServerConfig } from './types.js'


export function claudeAiMcpArmed(canonical: string | undefined): boolean {
  if (canonical !== undefined && canonical !== '') return isEnvTruthy(canonical)
  return false
}

const REQUIRED_SCOPE = 'user:mcp_servers'
const FETCH_TIMEOUT_MS = 5000

type ClaudeAiMcpServerRow = {
  type?: string
  id: string
  display_name: string
  url: string
  created_at?: string
}

export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    const canonical = flagEnv('MERCURY_CLAUDEAI_MCP')
    if (!claudeAiMcpArmed(canonical)) {
      logForDebugging('claudeai MCP: not armed (opt in with MERCURY_CLAUDEAI_MCP=1)')
      return {}
    }
    const tokens = getClaudeAIOAuthTokens()
    const accessToken = tokens?.accessToken
    if (!accessToken) {
      logForDebugging('claudeai MCP: no OAuth access token; skipping connector fetch')
      return {}
    }
    const scopes = tokens.scopes ?? []
    if (!scopes.includes(REQUIRED_SCOPE)) {
      logForDebugging(`claudeai MCP: token lacks ${REQUIRED_SCOPE} (has: ${scopes.join(', ') || 'none'})`)
      return {}
    }
    try {
      const base = getOauthConfig().BASE_API_URL
      const response = await axios.get<{ data?: ClaudeAiMcpServerRow[]; has_more?: boolean; next_page?: string | null }>(
        `${base}/v1/mcp_servers?limit=1000`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'anthropic-beta': 'mcp-servers-2025-12-04',
            'anthropic-version': '2023-06-01',
          },
          timeout: FETCH_TIMEOUT_MS,
        },
      )
      const rows = response.data?.data ?? []
      const configs: Record<string, ScopedMcpServerConfig> = {}
      const takenNormalized = new Set<string>()
      for (const row of rows) {
        const baseName = `claude.ai ${row.display_name}`
        let name = baseName
        let suffix = 2
        while (takenNormalized.has(normalizeNameForMCP(name))) {
          name = `${baseName} (${suffix})`
          suffix++
        }
        takenNormalized.add(normalizeNameForMCP(name))
        configs[name] = {
          type: 'claudeai-proxy',
          url: row.url,
          id: row.id,
          scope: 'claudeai',
        } as ScopedMcpServerConfig
      }
      logForDebugging(`claudeai MCP: ${Object.keys(configs).length} connector(s) fetched`)
      return configs
    } catch (err) {
      logForDebugging(`claudeai MCP: connector fetch failed: ${String(err)}`)
      return {}
    }
  },
)

export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache?.clear?.()
  clearMcpAuthCache()
}

export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const list = current.claudeAiMcpEverConnected ?? []
    if (list.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...list, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}
