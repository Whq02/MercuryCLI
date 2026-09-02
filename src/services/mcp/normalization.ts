/**
 * Server-name normalisation into the API-safe identifier charset.
 *
 * Deliberately import-free: this module sits under the permission-validation
 * and config paths and must never grow a dependency (cycle prevention — see
 * the S22 module-split note; `mcpStringUtils.ts` is the light sibling).
 */

/** The literal connector-name prefix (trailing space included). */
const CLAUDE_AI_NAME_PREFIX = 'claude.ai '

/**
 * Normalise a server name for wire use: every character outside
 * `[a-zA-Z0-9_-]` becomes an underscore (the Anthropic pattern is
 * `^[a-zA-Z0-9_-]{1,128}$`; the OpenAI-family 64-character cap is enforced
 * by wireSafeMcpToolName).
 *
 * Connector servers only — recognised by the `claude.ai ` name prefix —
 * additionally collapse consecutive underscores to one and strip leading and
 * trailing underscores, so the normalised name cannot interfere with the
 * `__` delimiter inside qualified tool names.
 */
export function normalizeNameForMCP(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!name.startsWith(CLAUDE_AI_NAME_PREFIX)) return normalized
  return normalized.replace(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '')
}
