import { LATEST_PROTOCOL_VERSION } from './sdk.js'

export const MCP_PROTOCOL_REVISION = '2026-07-28'
export const MCP_PUBLISHED_REVISION = '2026-07-28'
export const MCP_LEGACY_REVISION: string = LATEST_PROTOCOL_VERSION

export type McpProtocolCurrency = {
  line: string
  behind: boolean
  fix?: string
}

export function describeMcpProtocolCurrency(): McpProtocolCurrency {
  if (MCP_PROTOCOL_REVISION < MCP_PUBLISHED_REVISION) {
    return {
      line: `proto ${MCP_PROTOCOL_REVISION} · rev ${MCP_PUBLISHED_REVISION} is published — SDK behind`,
      behind: true,
      fix: `The bundled SDK speaks MCP ${MCP_PROTOCOL_REVISION}; ${MCP_PUBLISHED_REVISION} is out. Newer servers may refuse — update Mercury when a build ships the migration.`,
    }
  }
  return {
    line: `proto ${MCP_PROTOCOL_REVISION} current · older servers via ${MCP_LEGACY_REVISION}`,
    behind: false,
  }
}
