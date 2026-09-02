// ============================================================================
//  runtimePosture — init-path self-knowledge (task #62, operator-directed).
// ----------------------------------------------------------------------------
//  Every process the harness boots — the interactive REPL, a headless `-p` /
//  stream-json run, a daemon-spawned Scribe/Implementer/party seat — and every
//  in-process subagent (Agent tool, workflow agents, teammates) should KNOW at
//  model-wake what it is running inside: whether permission 'ask' prompts can
//  even be answered, which capability kills are armed, what MCP risk posture
//  applies, whether team tooling exists, and that the never-Haiku floor is in
//  force. Before this block, that knowledge lived only in the operator's head
//  and the /substrate panel — a headless child would retry a denied tool or
//  invent explanations for a policy block (the recon-access P0 symptom, solved
//  mechanically by MERCURY_DAEMON_PERMISSION_MODE; this states the semantics to
//  the model so it plans around them).
//
//  HONESTY RULES for this block:
//  - It states PROCESS-STATIC facts only, labeled "at boot" where the live
//    state can drift (kills can be toggled mid-session via /kill); the live
//    surface is /substrate and this block says so.
//  - It is computed ONCE per process and memoized: the system prompt must stay
//    byte-stable across turns (the prompt-cache invariant).
//  - OFF (MERCURY_RUNTIME_POSTURE=0) ⇒ null/[] ⇒ byte-identical.
// ============================================================================

import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { listCapabilityKills } from '../permissions/capabilityGate.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { NEVER_HAIKU_FALLBACK } from '../model/modelFloor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Fork default-ON, `=0` opts out (the house substrate-gate shape). */
export function runtimePostureEnabled(): boolean {
  if (flagEnv('MERCURY_RUNTIME_POSTURE') === '0') return false
  return true
}

// Set exactly once by the headless entry (runHeadless in src/cli/print.ts)
// BEFORE the first getSystemPrompt call. Default: interactive. A module flag
// (not a TTY sniff) because `-p` inside a real terminal still has TTY stdio —
// interactivity is decided by the ENTRYPOINT, not the fd family.
let nonInteractive = false
let bootPermissionMode: string | undefined

export function markSessionNonInteractive(permissionMode?: string): void {
  nonInteractive = true
  if (permissionMode) bootPermissionMode = permissionMode
}

/** Exposed for proofs (the posture text depends on it). */
export function isSessionMarkedNonInteractive(): boolean {
  return nonInteractive
}

let memo: string | null | undefined

/**
 * The posture block, memoized per process (undefined = not yet computed;
 * null = gated off). Test-only reset below.
 */
export function getRuntimePostureSection(): string | null {
  if (memo !== undefined) return memo
  if (!runtimePostureEnabled()) {
    memo = null
    return memo
  }

  const lines: string[] = ['# Runtime posture (this process, at boot)']

  if (nonInteractive) {
    lines.push(
      '- Session: NON-INTERACTIVE (headless `-p`/stream-json). There is no human at a prompt: any tool call that would need an interactive permission approval is DENIED automatically. Do not retry a denied call unchanged and do not invent tool failure as the cause — prefer tools your rules allow, or state the policy blocker plainly in your output.' +
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
      ? `- Capability kills armed at boot: ${killList.join(', ')} (MERCURY_KILL — absolute; no mode, including bypass, overrides a kill). Live state: /substrate.`
      : '- Capability kills armed at boot: none. (Kills can be armed mid-session via /kill; live state: /substrate.)',
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
    `- Agent-model floor: any subagent/workflow/seat spawn that resolves to the Haiku tier is upgraded to ${NEVER_HAIKU_FALLBACK} (fork invariant; the spawn result carries a note when this fires).`,
  )

  memo = lines.join('\n')
  return memo
}

/** Doctrine-sized variant for spawned subagents: the two facts a child most
 *  often trips on (deny semantics + lease semantics), one line. */
export function getRuntimePostureDoctrineLine(): string | null {
  if (!runtimePostureEnabled()) return null
  const denyClause = nonInteractive
    ? 'this process is HEADLESS — an unanswerable permission ask is an automatic DENY; treat a denied tool as policy, not failure, and say so instead of retrying'
    : 'a denied tool call may be permission policy, not tool failure — say which it was'
  return `Runtime posture: ${denyClause}; a file-lease denial means another agent holds those paths (coordinate, do not force); Haiku-tier spawns are floored to ${NEVER_HAIKU_FALLBACK}.`
}

/** Test-only: clear the memo + interactivity mark (proofs flip env/state). */
export function resetRuntimePostureForTest(): void {
  memo = undefined
  nonInteractive = false
  bootPermissionMode = undefined
}
