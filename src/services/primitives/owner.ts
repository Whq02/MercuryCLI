
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

export type OwnerScope =
  | 'session'
  | 'agent'
  | 'lane'
  | 'project'
  | 'machine'

export interface OwnerDescriptor {
  key: OwnerKey
  scope: OwnerScope
  parent?: OwnerKey
  workspace: string
  sessionId?: string
  lane?: string
}

const PROJECT_SESSION = '@project'
const MACHINE_SESSION = '@machine'

export function projectOwner(workspace: string): OwnerKey {
  return makeOwnerKey({ workspace, sessionId: PROJECT_SESSION, lane: MAIN_LANE })
}

export function machineOwner(): OwnerKey {
  return makeOwnerKey({ workspace: '', sessionId: MACHINE_SESSION, lane: MAIN_LANE })
}

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
