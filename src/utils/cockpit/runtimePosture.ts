
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { listCapabilityKills } from '../permissions/capabilityGate.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { NEVER_HAIKU_FALLBACK } from '../model/modelFloor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { canAnswerAsks } from '../../bootstrap/state.js'

export function runtimePostureEnabled(): boolean {
  if (flagEnv('MERCURY_RUNTIME_POSTURE') === '0') return false
  return true
}

let nonInteractive = false
let bootPermissionMode: string | undefined

export function markSessionNonInteractive(permissionMode?: string): void {
  nonInteractive = true
  if (permissionMode) bootPermissionMode = permissionMode
}

export function isSessionMarkedNonInteractive(): boolean {
  return nonInteractive
}

let memo: string | null | undefined

export function getRuntimePostureSection(): string | null {
  if (memo !== undefined) return memo
  if (!runtimePostureEnabled()) {
    memo = null
    return memo
  }

  const lines: string[] = ['# Runtime posture (this process, at boot)']

  if (nonInteractive && canAnswerAsks()) {
    lines.push(
      '- Session: NON-INTERACTIVE (headless `-p`/stream-json) with a permission channel: a tool call that needs approval is put to the connected client, which answers allow or deny; a question to the operator travels the same channel. Do not retry a denied call unchanged and do not invent tool failure as the cause — prefer tools your rules allow, or state the policy blocker plainly in your output.' +
        (bootPermissionMode ? ` Permission mode for this run: ${bootPermissionMode}.` : ''),
    )
  } else if (nonInteractive) {
    lines.push(
      '- Session: NON-INTERACTIVE (headless `-p`/stream-json). There is no human at a prompt and no permission channel: any tool call that would need an interactive permission approval is DENIED automatically, and no question can reach the operator — choose the most reasonable option, state the assumption, and continue. Do not retry a denied call unchanged and do not invent tool failure as the cause — prefer tools your rules allow, or state the policy blocker plainly in your output.' +
        (bootPermissionMode ? ` Permission mode for this run: ${bootPermissionMode}.` : ''),
    )
  } else {
    lines.push(
      '- Session: interactive. Permission asks reach the operator; the current mode is on the shift+tab carousel and can change mid-session.',
    )
  }

  const kills = listCapabilityKills()
  const killList = Object.entries(kills).flatMap(([agent, tools]) =>
    tools.map(t => (agent === '*' || agent === '' ? t : `${agent}:${t}`)),
  )
  lines.push(
    killList.length > 0
      ? `- Capability kills armed at boot: ${killList.join(', ')} (MERCURY_KILL — absolute; no mode, including bypass, overrides a kill).${nonInteractive ? '' : ' Live state: /substrate.'}`
      : `- Capability kills armed at boot: none.${nonInteractive ? '' : ' (Kills can be armed mid-session via /kill; live state: /substrate.)'}`,
  )

  lines.push(
    isMcpPolicyActive()
      ? `- MCP tool-risk policy: ${describeMcpPolicy()} — higher-risk MCP tools are blocked by policy, not broken.`
      : '- MCP tool-risk policy: permissive (no max-risk cap set).',
  )

  lines.push(
    isAgentSwarmsEnabled()
      ? '- Team tooling (swarms) available: file leases guard concurrent edits (a lease denial is coordination, not an error); TeamBrief aggregates team state.'
      : '- Team tooling (swarms): off for this process.',
  )

  lines.push(
    `- Agent-model floor: an agent selected at the Haiku tier runs on ${NEVER_HAIKU_FALLBACK} instead; the launch result reports that adjustment.`,
  )

  memo = lines.join('\n')
  return memo
}

export function getRuntimePostureDoctrineLine(): string | null {
  if (!runtimePostureEnabled()) return null
  const denyClause = nonInteractive
    ? 'this process is HEADLESS — an unanswerable permission ask is an automatic DENY; treat a denied tool as policy, not failure, and say so instead of retrying'
    : 'a denied tool call may be permission policy, not tool failure — say which it was'
  return `Runtime posture: ${denyClause}; a file-lease denial means another agent holds those paths (coordinate, do not force); Haiku-tier spawns are floored to ${NEVER_HAIKU_FALLBACK}.`
}

export function resetRuntimePostureForTest(): void {
  memo = undefined
  nonInteractive = false
  bootPermissionMode = undefined
}
