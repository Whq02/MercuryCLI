// ============================================================================
//  src/services/mcp/disabledRecord.ts — THE DISABLED-RECORD SEMANTICS as a
//  zero-dependency leaf.
//
//  ONE meaning for the per-project MCP off-record, answerable by ANY process
//  from an explicit project slice: the `disabledMcpServers` opt-out list
//  governs most servers; a default-disabled built-in is governed by the
//  `enabledMcpServers` opt-in list instead. config.ts's cwd-keyed doors
//  (isMcpServerDisabled / setMcpServerEnabled) are two-line calls over the
//  functions below, and the menu store's workspace-keyed derivation (the
//  daemon stamping a kit for a birth its screen never saw, the boot face
//  after a ground move) reads the SAME functions — never the raw lists: the
//  MCP half of the menu record renders through the disabled semantics in
//  every process, or the two worlds drift.
//
//  A leaf on purpose: no daemon file imports services/mcp today, and the kit
//  derivation must not pull the whole resolution graph behind config.ts into
//  the daemon to answer "is this name off".
// ============================================================================
import type { ProjectConfig } from '../../utils/config/schema.js'

/** The slice fields the off-record lives in. */
export type McpDisabledRecordSlice = Pick<ProjectConfig, 'disabledMcpServers' | 'enabledMcpServers'>

/**
 * Built-in servers that default to disabled (explicit opt-in through the
 * `enabledMcpServers` list). Folded to empty in the audited snapshot — the
 * opt-in branch is currently unreachable; the mechanism is kept because the
 * computer-use capability references it.
 */
export const DEFAULT_DISABLED_BUILTIN_SERVERS: ReadonlySet<string> = new Set()

/**
 * Is this server disabled in THIS slice? Most servers are governed by the
 * `disabledMcpServers` (opt-out) list; default-disabled built-ins are
 * governed by the `enabledMcpServers` (opt-in) list instead.
 */
export function isMcpServerDisabledIn(slice: McpDisabledRecordSlice, name: string): boolean {
  if (DEFAULT_DISABLED_BUILTIN_SERVERS.has(name)) {
    return !(slice.enabledMcpServers ?? []).includes(name)
  }
  return (slice.disabledMcpServers ?? []).includes(name)
}

/**
 * The off-record of a slice AS NAMES — every opted-out server plus every
 * default-disabled built-in the slice never opted in — the rendered form
 * the menu store's deltas carry (never the raw lists). Order: the opt-out
 * list's own, then the built-ins in their declaration order; no duplicates.
 */
export function disabledMcpServerNamesIn(slice: McpDisabledRecordSlice): string[] {
  const out: string[] = []
  for (const name of slice.disabledMcpServers ?? []) {
    if (!out.includes(name)) out.push(name)
  }
  for (const name of DEFAULT_DISABLED_BUILTIN_SERVERS) {
    if (isMcpServerDisabledIn(slice, name) && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * The pure updater behind every enable/disable pen: the slice with the
 * server's state set. Setting the state a server already has returns the
 * input BY IDENTITY, so the store's change detection skips the write.
 */
export function withMcpServerEnabled(current: ProjectConfig, name: string, enabled: boolean): ProjectConfig {
  if (DEFAULT_DISABLED_BUILTIN_SERVERS.has(name)) {
    const list = current.enabledMcpServers ?? []
    if (enabled === list.includes(name)) return current
    return {
      ...current,
      enabledMcpServers: enabled ? [...list, name] : list.filter(entry => entry !== name),
    }
  }
  const list = current.disabledMcpServers ?? []
  if (enabled === !list.includes(name)) return current
  return {
    ...current,
    disabledMcpServers: enabled ? list.filter(entry => entry !== name) : [...list, name],
  }
}
