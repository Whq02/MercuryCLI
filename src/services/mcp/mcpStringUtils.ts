import { createHash } from 'node:crypto'
import { normalizeNameForMCP } from './normalization.js'

const MCP_SEGMENT_SEPARATOR = '__'

export function mcpInfoFromString(
  toolString: string,
): { serverName: string; toolName?: string } | null {
  const parts = toolString.split(MCP_SEGMENT_SEPARATOR)
  if (parts[0] !== 'mcp') return null
  const serverName = parts[1]
  if (!serverName) return null
  if (parts.length === 2) return { serverName }
  return { serverName, toolName: parts.slice(2).join(MCP_SEGMENT_SEPARATOR) }
}

export function getMcpPrefix(serverName: string): string {
  return `mcp${MCP_SEGMENT_SEPARATOR}${normalizeNameForMCP(serverName)}${MCP_SEGMENT_SEPARATOR}`
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

export const WIRE_TOOL_NAME_MAX = 64

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

export function wireSafeMcpToolName(serverName: string, toolName: string): string {
  const full = buildMcpToolName(serverName, toolName)
  if (full.length <= WIRE_TOOL_NAME_MAX) return full
  const tool = normalizeNameForMCP(toolName)
  const suffix = `_${shortDigest(toolName)}`
  const prefix = getMcpPrefix(serverName)
  const room = WIRE_TOOL_NAME_MAX - prefix.length - suffix.length
  if (room >= 8) return `${prefix}${tool.slice(0, room)}${suffix}`
  const server = normalizeNameForMCP(serverName)
  const serverSuffix = `_${shortDigest(serverName)}`
  const shortServer = `${server.slice(0, 16)}${serverSuffix}`
  const shortPrefix = `mcp${MCP_SEGMENT_SEPARATOR}${shortServer}${MCP_SEGMENT_SEPARATOR}`
  return `${shortPrefix}${tool.slice(0, WIRE_TOOL_NAME_MAX - shortPrefix.length - suffix.length)}${suffix}`
}

export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  if (tool.mcpInfo) return buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
  return tool.name
}

export function getMcpDisplayName(fullName: string, serverName: string): string {
  return fullName.replace(getMcpPrefix(serverName), '')
}

export function extractMcpToolDisplayName(userFacingName: string): string {
  const withoutMarker = userFacingName.replace(/\s*\(MCP\)\s*$/, '').trim()
  const separatorIndex = withoutMarker.indexOf(' - ')
  if (separatorIndex === -1) return withoutMarker
  return withoutMarker.slice(separatorIndex + 3).trim()
}
