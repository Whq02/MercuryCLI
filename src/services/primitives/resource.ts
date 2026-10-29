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
