// ============================================================================
// services/concourse/coordinatorIdentity —
//  the ONE named GLOBAL Concourse coordinator seat, registered through
//  services/crew like every agent — stable crew identity (idempotent by
//  binding: the same native binding always lands on the same agentId),
//  role-linked 'coordinator', visible in the crew directory. NO parallel
//  identity store: the crew owner is the identity truth; this module only
//  names the binding and caches the resolution.
// ============================================================================

import {
  ensureAgentIdentity,
  linkAgentRole,
  type AgentIdentityV1,
  type CrewAgentId,
} from '../crew/identity.js'

/** The ONE global binding — never per-project, never per-session (the
 *  "one stable global crew identity"). */
export const COORDINATOR_BINDING_ID = 'concourse-coordinator'
export const COORDINATOR_DISPLAY_NAME = 'Concourse Coordinator'
export const COORDINATOR_ROLE_OWNER_REF = 'concourse:coordinator'

let cached: AgentIdentityV1 | null = null

/** Resolve-or-mint the global coordinator identity (idempotent at the crew
 *  owner; the role link is idempotent too). Callers that only need the id
 *  use coordinatorAgentId(). */
export async function ensureCoordinatorIdentity(opts?: { dir?: string }): Promise<AgentIdentityV1> {
  if (cached && opts?.dir === undefined) return cached
  const identity = await ensureAgentIdentity({
    displayName: COORDINATOR_DISPLAY_NAME,
    binding: { bindingKind: 'native', bindingId: COORDINATOR_BINDING_ID },
    ...(opts?.dir !== undefined ? { dir: opts.dir } : {}),
  })
  await linkAgentRole(identity.agentId, 'coordinator', COORDINATOR_ROLE_OWNER_REF, opts)
  if (opts?.dir === undefined) cached = identity
  return identity
}

export async function coordinatorAgentId(opts?: { dir?: string }): Promise<CrewAgentId> {
  return (await ensureCoordinatorIdentity(opts)).agentId
}

export function _resetCoordinatorIdentityForTesting(): void {
  cached = null
}
