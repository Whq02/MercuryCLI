/**
 * Pure parsing/formatting of MCP-qualified tool and command names.
 *
 * Kept free of heavy dependencies so permission validation can import it
 * cheaply (only `normalization.ts`, which is import-free).
 *
 * Naming contract:
 *   - tools / prompts:  `mcp__<normalisedServer>__<name>`
 *   - skills:           `<normalisedServer>:<name>`
 */
import { createHash } from 'node:crypto'
import { normalizeNameForMCP } from './normalization.js'

const MCP_SEGMENT_SEPARATOR = '__'

/**
 * Parse a qualified tool name. The first `__`-segment must be exactly `mcp`,
 * the second is the (non-empty) server name, and everything after is rejoined
 * with `__` so double underscores inside tool names survive. A bare server
 * reference (`mcp__srv`) yields an undefined tool name.
 *
 * Known limitation, preserved deliberately: a server name that itself
 * contains `__` parses incorrectly — permission rules and settings written
 * against the historic behaviour depend on it. Do not "fix" this.
 */
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

/** The qualified-name prefix for one server's tools and prompts. */
export function getMcpPrefix(serverName: string): string {
  return `mcp${MCP_SEGMENT_SEPARATOR}${normalizeNameForMCP(serverName)}${MCP_SEGMENT_SEPARATOR}`
}

/** Build the fully-qualified tool name (both parts normalised). */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

/** The strictest function-name length any wire Mercury speaks accepts: the
 *  OpenAI-family grammar (chat-completions, Responses, Gemini's OpenAI
 *  surface) caps a name at 64 characters; the Anthropic pattern allows 128.
 *  One over-long name rejects the WHOLE request on the 64-character wires. */
export const WIRE_TOOL_NAME_MAX = 64

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}

/**
 * The model-facing name for a server tool: the fully-qualified name when it
 * fits every wire's grammar, else a deterministic shortening that keeps the
 * `mcp__<server>__` prefix whole (the name parsers and the permission-rule
 * check read the server through it) and cuts the tool segment to fit,
 * suffixed with a digest of the real name so two long siblings never
 * collide. A server segment that alone leaves no room is shortened the same
 * way. The tool's mcpInfo always carries the real names; permission rules
 * match on buildMcpToolName over those, never on this spelling.
 */
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

/**
 * The name a permission rule must be checked against: the fully-qualified
 * MCP name when the tool carries MCP info, otherwise the tool's own name.
 * This exists so a deny rule targeting a built-in tool name can never be
 * matched by an unprefixed MCP replacement sharing that display name.
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  if (tool.mcpInfo) return buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
  return tool.name
}

/**
 * Strip a server's qualified prefix off a name. Removes the FIRST occurrence
 * of the prefix anywhere in the string rather than only an anchored one —
 * keep that tolerance.
 */
export function getMcpDisplayName(fullName: string, serverName: string): string {
  return fullName.replace(getMcpPrefix(serverName), '')
}

/**
 * Extract the bare display name from a user-facing label: drop a trailing
 * parenthesised `(MCP)` marker (with surrounding whitespace), trim, then drop
 * everything up to and including the first ` - ` separator, trimming what
 * remains. No separator ⇒ the whole remainder is the display name.
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  const withoutMarker = userFacingName.replace(/\s*\(MCP\)\s*$/, '').trim()
  const separatorIndex = withoutMarker.indexOf(' - ')
  if (separatorIndex === -1) return withoutMarker
  return withoutMarker.slice(separatorIndex + 3).trim()
}
