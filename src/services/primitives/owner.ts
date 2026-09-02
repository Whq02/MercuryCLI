// ============================================================================
//  primitives/owner — the Owner primitive contract.
//
//  The canonical identity IS the existing OwnerKey (services/run/ownerKey.ts)
//  — this module re-exports it and adds only the shared descriptor vocabulary
//  cross-domain consumers need: WHAT KIND of owner a key names, its parent,
//  and its workspace/session/lane parts as typed fields. It never mints a
//  second identity: a descriptor is DERIVED from a key, and the key remains
//  the only comparable form (Law 1 — one stable owner vocabulary).
//
//  Pure + React-free. Disposal stays ownerLifecycle's job (re-exported).
// ============================================================================

import {
  agentLane,
  MAIN_LANE,
  makeOwnerKey,
  parseOwnerKey,
  type OwnerIdentity,
  type OwnerKey,
} from '../run/ownerKey.js'

export {
  agentLane,
  isOwnerKey,
  MAIN_LANE,
  makeOwnerKey,
  ownerEquals,
  ownerKeyFileStem,
  parseOwnerKey,
} from '../run/ownerKey.js'
export type { OwnerIdentity, OwnerKey } from '../run/ownerKey.js'
export {
  disposeOwner,
  registerOwnerDisposer,
  registerOwnerScopedStore,
  unregisterOwnerDisposer,
} from '../run/ownerLifecycle.js'
export { OwnerScopedStore } from '../run/ownerScopedStore.js'

/** What KIND of owner a key names — derived, never stored as identity. */
export type OwnerScope =
  | 'session' // the main conversation lane of one session
  | 'agent' // a subagent lane inside a session
  | 'lane' // a named non-agent lane (querySource-differentiated)
  | 'project' // project-scoped state (services) — session-independent
  | 'machine' // machine-scoped state — workspace-independent

/** The typed, derived view of one OwnerKey (Law 1's descriptor form). */
export interface OwnerDescriptor {
  key: OwnerKey
  scope: OwnerScope
  /** The containing owner, when one exists (an agent lane's session). */
  parent?: OwnerKey
  workspace: string
  sessionId?: string
  lane?: string
}

/** Sentinel session ids for the non-session scopes (stable, collision-free
 *  through the canonical serializer's escaping). */
const PROJECT_SESSION = '@project'
const MACHINE_SESSION = '@machine'

/** Mint the project-scoped owner for a workspace (services and other
 *  session-independent, project-lifetime state). Deliberately session-free:
 *  two sessions in one project share it — that is the point. */
export function projectOwner(workspace: string): OwnerKey {
  return makeOwnerKey({ workspace, sessionId: PROJECT_SESSION, lane: MAIN_LANE })
}

/** Mint the machine-scoped owner (workspace-independent state). */
export function machineOwner(): OwnerKey {
  return makeOwnerKey({ workspace: '', sessionId: MACHINE_SESSION, lane: MAIN_LANE })
}

/** Derive the typed descriptor for a key. Total — every canonical key has
 *  exactly one descriptor; scope falls out of the identity parts. */
export function describeOwner(key: OwnerKey): OwnerDescriptor {
  const id: OwnerIdentity = parseOwnerKey(key)
  if (id.sessionId === MACHINE_SESSION) {
    return { key, scope: 'machine', workspace: id.workspace }
  }
  if (id.sessionId === PROJECT_SESSION) {
    return { key, scope: 'project', workspace: id.workspace }
  }
  if (id.lane.startsWith('agent:')) {
    return {
      key,
      scope: 'agent',
      parent: makeOwnerKey({ ...id, lane: MAIN_LANE }),
      workspace: id.workspace,
      sessionId: id.sessionId,
      lane: id.lane,
    }
  }
  if (id.lane !== MAIN_LANE || id.querySource) {
    return {
      key,
      scope: 'lane',
      parent: makeOwnerKey({
        workspace: id.workspace,
        sessionId: id.sessionId,
        lane: MAIN_LANE,
      }),
      workspace: id.workspace,
      sessionId: id.sessionId,
      lane: id.lane,
    }
  }
  return {
    key,
    scope: 'session',
    workspace: id.workspace,
    sessionId: id.sessionId,
    lane: id.lane,
  }
}
