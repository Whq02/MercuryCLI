// ============================================================================
//  resolveOwner — derive the canonical OwnerKey from live process state
//
//
//  Kept OUT of ownerKey.ts so the pure key module never imports bootstrap
//  state (proof scripts exercise keys without booting a session). Boundary
//  helpers only: internal owner-scoped stores must take an explicit owner —
//  these resolvers exist for the outer seams (toolExecution, REPL, doctor)
//  that sit where the ambient process identity IS the truth.
//
//  Fallbacks are deliberate and stable: a proof script or pre-boot path with
//  no session id still resolves a DETERMINISTIC key (workspace + 'boot'),
//  never a throw — an observer must never break tool execution.
// ============================================================================

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import {
  agentLane,
  MAIN_LANE,
  makeOwnerKey,
  type OwnerKey,
} from './ownerKey.js'

function safeWorkspace(): string {
  try {
    return getOriginalCwd()
  } catch {
    return process.cwd()
  }
}

function safeSessionId(): string {
  try {
    return String(getSessionId())
  } catch {
    return 'boot'
  }
}

/** The current process's MAIN-thread owner (the default for singleton
 *  consumers that predate owner threading — the frame chip, deck rails). */
export function processMainOwner(): OwnerKey {
  return makeOwnerKey({
    workspace: safeWorkspace(),
    sessionId: safeSessionId(),
    lane: MAIN_LANE,
  })
}

/** Owner for a lane in the current process (main when agentId is absent). */
export function processOwnerForLane(agentId?: string | null): OwnerKey {
  return makeOwnerKey({
    workspace: safeWorkspace(),
    sessionId: safeSessionId(),
    lane: agentId ? agentLane(String(agentId)) : MAIN_LANE,
  })
}

/**
 * Owner for a tool call, from its ToolUseContext-shaped carrier. Honors an
 * explicit `owner` threaded on the context; otherwise derives from the
 * context's agent id + process identity. Never throws.
 */
export function ownerFromToolUseContext(context: {
  owner?: OwnerKey
  agentId?: string
}): OwnerKey {
  if (context.owner) return context.owner
  return processOwnerForLane(context.agentId ?? null)
}
