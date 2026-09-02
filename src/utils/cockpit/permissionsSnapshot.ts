// permissionsSnapshot — the read-only governance posture: permission mode (passed
// in from the command's tool context), MCP max exposed risk, active capability
// kills, trusted-server allowlist, and sandbox flag. Read-only; never mutates a
// rule. The base /permissions rule editor is untouched — this feeds /policy and
// the /deck governance row.
import { getMaxExposedRisk, isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { isEnvTruthy } from '../envUtils.js'
import { listCapabilityKills } from '../permissions/capabilityGate.js'
import { withState, type Snapshot } from './types.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type PermissionsData = {
  mode: string
  mcpMaxRisk: string
  mcpPolicyActive: boolean
  mcpPolicyHint: string
  kills: string[]
  trusted: string[]
  sandbox: string
}

export function permissionsSnapshot(opts?: { mode?: string }): Snapshot<{ data: PermissionsData }> {
  try {
    const killMap = listCapabilityKills()
    const kills: string[] = []
    for (const [agent, tools] of Object.entries(killMap)) {
      for (const tool of tools) {
        kills.push(agent === '*' || agent === '' ? tool : `${agent}:${tool}`)
      }
    }
    const trusted = (flagEnv('MERCURY_MCP_TRUSTED_SERVERS') ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    // Sandbox: honest read of the known env gate; 'off' otherwise (no fabrication).
    const sandbox =
      isEnvTruthy(flagEnv('MERCURY_SANDBOX'))
        ? 'workspace-write'
        : 'off'
    return {
      state: 'live',
      source: 'toolPolicy + capabilityGate',
      data: {
        mode: opts?.mode ?? 'default',
        mcpMaxRisk: getMaxExposedRisk(),
        mcpPolicyActive: isMcpPolicyActive(),
        mcpPolicyHint: describeMcpPolicy(),
        kills,
        trusted,
        sandbox,
      },
    }
  } catch {
    return withState(
      'unavailable',
      { mode: opts?.mode ?? 'default', mcpMaxRisk: 'high', mcpPolicyActive: false, mcpPolicyHint: 'high · permissive', kills: [], trusted: [], sandbox: 'off' },
      'governance state unreadable',
    )
  }
}
