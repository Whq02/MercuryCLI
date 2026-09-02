import type { ApiTool } from '../types/wire.js'

/**
 * Process-lifetime memo of rendered tool schemas, for prompt-cache
 * stability: the tool schemas are serialised ahead of the system prompt on
 * the wire, so changing one byte of them invalidates the whole tool block
 * and everything after it. Memoising per session pins those bytes at first
 * render, so mid-session feature-gate refreshes, MCP reconnections and
 * dynamic prompt content stop churning the cache.
 *
 * Callers treat the cache as session-scoped by clearing it at session and
 * authentication boundaries. This module is deliberately a dependency-free
 * leaf so the authentication module can clear it without an import cycle.
 */

const toolSchemaCache = new Map<string, ApiTool>()

export function getToolSchemaCache(): Map<string, ApiTool> {
  return toolSchemaCache
}

export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}
