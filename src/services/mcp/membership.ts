import type { SessionKitV1 } from '../../daemon/sessionKit.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMcpServerDisabled } from './config.js'
import { sessionKitOf } from './sessionKitPin.js'
import type { ScopedMcpServerConfig } from './types.js'

const COORDINATION_ORGAN_NAME = 'mercury'
const IDE_ORGAN_NAME = 'ide'

export function isMcpOrgan(name: string): boolean {
  if (name === IDE_ORGAN_NAME) return true
  return name === COORDINATION_ORGAN_NAME && flagEnv('MERCURY_COORDINATION_MCP') !== '0'
}

function recordMembership(name: string): boolean {
  return !isMcpServerDisabled(name)
}

export function isMcpCatalogueMember(name: string): boolean {
  const kit = sessionKitOf()
  if (kit === undefined) return recordMembership(name)
  return isMcpOrgan(name) || kitMembership(kit, name)
}

export function kitMembership(kit: SessionKitV1 | undefined, name: string): boolean {
  if (kit === undefined) return recordMembership(name)
  if (kit.resolved === false) return !(kit.deltas?.mcpOff ?? []).includes(name)
  return kit.mcp.includes(name)
}

export function partitionMcpConfigsByMembership(
  configs: Record<string, ScopedMcpServerConfig>,
): {
  members: Array<[string, ScopedMcpServerConfig]>
  excluded: Array<[string, ScopedMcpServerConfig]>
} {
  const members: Array<[string, ScopedMcpServerConfig]> = []
  const excluded: Array<[string, ScopedMcpServerConfig]> = []
  for (const entry of Object.entries(configs)) {
    ;(isMcpCatalogueMember(entry[0]) ? members : excluded).push(entry)
  }
  return { members, excluded }
}
