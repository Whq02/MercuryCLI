import type { ProjectConfig } from '../../utils/config/schema.js'
import { notBuilt } from '../../pi/holes.js'

type McpDisabledRecordSlice = Pick<ProjectConfig, 'disabledMcpServers' | 'enabledMcpServers'>

const DEFAULT_DISABLED_BUILTIN_SERVERS: ReadonlySet<string> = new Set()

export function isMcpServerDisabledIn(slice: McpDisabledRecordSlice, name: string): boolean {
  if (DEFAULT_DISABLED_BUILTIN_SERVERS.has(name)) {
    return !(slice.enabledMcpServers ?? []).includes(name)
  }
  return (slice.disabledMcpServers ?? []).includes(name)
}

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

export function withMcpServerEnabled(current: ProjectConfig, name: string, enabled: boolean): ProjectConfig {
  return notBuilt('src/services/mcp/disabledRecord.ts:25')
}
