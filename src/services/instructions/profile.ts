// ============================================================================
//  instructions/profile.ts — instruction-profile resolution (MERCURY
// RUNTIME-owned, never inferred from a model name.
//
//  Precedence (low → high):
//    1. `auto` default
//    2. session/operator selection (the /config control persists via the
//       settings owner; boot applies it here)
//    3. explicit agent/role selection (spawn-time capture pins it for the
//       child's whole life — a later parent change affects future spawns)
//
//  This module is deliberately tiny state: two override slots + a pure
//  resolver over the DURABLE settings owner (settings.json
//  `instructionProfile` — no persistence island). The engine consumes the
//  RESULT; surfaces read the same result — one answer everywhere. A surface
//  that changes a slot clears the engine's discovery cache (the composition
//  memoizers above the engine are cleared by the same surface — the exact
//  contract of the existing /memory dialog + worktree cache clears).
// ============================================================================
import { getInitialSettings } from '../../utils/settings/settings.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type {
  InstructionProfile,
  InstructionProfileOrigin,
} from './contracts.js'
import { INSTRUCTION_PROFILES } from './contracts.js'

let sessionProfile: InstructionProfile | null = null
let agentProfile: InstructionProfile | null = null

export function isInstructionProfile(
  value: unknown,
): value is InstructionProfile {
  return (
    typeof value === 'string' &&
    (INSTRUCTION_PROFILES as readonly string[]).includes(value)
  )
}

/** The session/operator selection (settings-owned; applied at boot and by
 *  the /config control). Pass null to return to the `auto` default. */
export function setSessionInstructionProfile(
  profile: InstructionProfile | null,
): void {
  sessionProfile = profile
}

/** The agent/role selection (spawn-time capture applies it in the CHILD
 *  process; an agent definition's `instructionProfile` field feeds it). */
export function setAgentInstructionProfile(
  profile: InstructionProfile | null,
): void {
  agentProfile = profile
}

export function resolveRequestedInstructionProfile(): {
  profile: InstructionProfile
  origin: InstructionProfileOrigin
} {
  if (agentProfile !== null) {
    return { profile: agentProfile, origin: 'agent' }
  }
  // The out-of-process spawn carrier (MERCURY_INSTRUCTION_PROFILE, registered):
  // pane-teammate spawns stamp the agent-definition profile into the child's
  // env — the child resolves it as the agent tier at its own boot. Read
  // live, no caching (a value flag).
  const envCarrier = flagEnv('MERCURY_INSTRUCTION_PROFILE')
  if (isInstructionProfile(envCarrier)) {
    return { profile: envCarrier, origin: 'agent' }
  }
  if (sessionProfile !== null) {
    return { profile: sessionProfile, origin: 'session' }
  }
  // The durable operator selection (settings.json). Read live so headless
  // children and fresh boots resolve without a wiring step; the in-memory
  // slot above only fronts it for immediate same-session switches. The read
  // is guarded: callers like path CLASSIFICATION (isMemoryFilePath) may run
  // before enableConfigs() — resolution degrades to `auto`, never throws.
  let durable: unknown
  try {
    durable = getInitialSettings().instructionProfile
  } catch {
    durable = undefined
  }
  if (isInstructionProfile(durable)) {
    return { profile: durable, origin: 'session' }
  }
  return { profile: 'auto', origin: 'default' }
}
