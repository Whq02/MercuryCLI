
import {
  ensureAgentIdentity,
  linkAgentRole,
  type AgentIdentityV1,
  type CrewAgentId,
} from '../crew/identity.js'

export const COORDINATOR_BINDING_ID = 'concourse-coordinator'
export const COORDINATOR_DISPLAY_NAME = 'Concourse Coordinator'
export const COORDINATOR_ROLE_OWNER_REF = 'concourse:coordinator'

let cached: AgentIdentityV1 | null = null

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
