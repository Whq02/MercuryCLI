
import type { OwnerKey } from '../run/ownerKey.js'

export {
  boundedTextView,
  formatRef,
  isMercuryRef,
  MERCURY_REF_SCHEME,
  mercuryRefsEnabled,
  parseMercuryRef,
} from '../resources/contracts.js'
export type {
  ParsedRef,
  Resource,
  ResourceAdapter,
  ResourceChild,
  ResourceContext,
  ResourceResult,
} from '../resources/contracts.js'
export {
  getResourceAdapter,
  listResourceKind,
  registerResourceAdapter,
  resolveResource,
  resourceAdapterKinds,
} from '../resources/registry.js'

interface ResourceIdentity {
  ref: string
  owner?: OwnerKey
  version?: string
  observedAt: number
}
