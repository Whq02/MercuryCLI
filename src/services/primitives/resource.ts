
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

export interface ResourceIdentity {
  ref: string
  owner?: OwnerKey
  version?: string
  observedAt: number
}

export const RESOURCE_RELATIONS = [
  'parent',
  'child',
  'execution',
  'transaction',
  'evidence',
  'view',
  'output',
  'receipt',
  'snapshot',
  'verification',
] as const

export type ResourceRelation = (typeof RESOURCE_RELATIONS)[number]

export interface ResourceLink {
  ref: string
  relation: ResourceRelation
}

export function linksAsChildren(
  links: readonly ResourceLink[],
): { ref: string; title: string; summary: string }[] {
  return links.map(l => ({
    ref: l.ref,
    title: l.relation,
    summary: `${l.relation} → ${l.ref}`,
  }))
}
