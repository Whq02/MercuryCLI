// ============================================================================
//  primitives/resource — the Resource primitive contract.
//
//  The canonical namespace IS the existing mercury:// plane
//  (services/resources/) — this module re-exports its contracts and adds only
//  the shared graph vocabulary wires through the registry: typed
//  identity metadata and typed relations between primitive records. Relations
//  return REFS, never embedded object graphs (bounded reads, Law 2 + Law 7).
// ============================================================================

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

/** Shared identity metadata for a primitive-backed resource. */
export interface ResourceIdentity {
  ref: string
  owner?: OwnerKey
  /** Revision/digest/generation for staleness honesty on resume. */
  version?: string
  observedAt: number
}

/** The typed relation vocabulary between primitive records (wires
 *  these through adapters as `child=`-navigable links). */
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

/** Render links as bounded child entries (refs only — never embedded). */
export function linksAsChildren(
  links: readonly ResourceLink[],
): { ref: string; title: string; summary: string }[] {
  return links.map(l => ({
    ref: l.ref,
    title: l.relation,
    summary: `${l.relation} → ${l.ref}`,
  }))
}
