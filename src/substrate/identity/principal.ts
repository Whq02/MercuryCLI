/**
 * The principal — WHO did something: the operator, a guest, or an agent.
 *
 * The substrate owns this shape because every keyed record under the config
 * home (a room frame's author, a conversation participant, a read cursor)
 * names its actor by it. `kind` is load-bearing for authorization at the
 * consumers (the room ACL) and for rendering; `name` is display only.
 */
export interface Principal {
  /** Stable id: `op-…` (the operator), `guest-…` (invite-derived), `agent-…`. */
  id: string
  kind: 'operator' | 'guest' | 'agent'
  /** Display name for the transcript/presence UI (never used for authz). */
  name?: string
}
