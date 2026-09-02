// The tree's one seam for node's randomUUID: call sites import it from here
// instead of from 'crypto' directly, so a build that ever needs to shim or
// retarget the source touches one module rather than every caller.
//
// The two-line import-then-export shape is deliberate: the module holds a
// concrete local binding to forward, which stays linked across bundler modes.
// Don't collapse it to a bare `export { … } from …` re-export.
import { randomUUID } from 'crypto'
export { randomUUID }
