// =============================================================================
// Built-in workflow registration.
//
// Registers each bundled workflow into the name registry exactly once per
// process (the entry layer calls initBundledWorkflows() at startup):
//
//   • deep-research — listed;
//   • code-review   — registered hidden: the code-review skill launches it,
//                     so it stays out of listings;
//   • daedalus      — behind the MERCURY_DAEDALUS opt-in. With the flag off
//                     it exists nowhere: not in the registry, not in
//                     listings, not in the tool prompt's catalogue. When on,
//                     it lists normally — starting it is a deliberate,
//                     billed operator action regardless of visibility.
//
// A bundled workflow is stored as its complete script text, opening with a
// pure-literal `export const meta = {...}` statement. Registration derives
// the descriptor BY PARSING that opening statement — the script is the only
// authority on its own metadata, so the two cannot disagree. A bundled
// script whose meta will not parse is a defect in the build itself, and the
// response is a thrown error, not a quiet omission.
// =============================================================================

import { flagEnabled } from '../../../substrate/flagRegistry.js'
import { parseWorkflowScript, type ParsedWorkflow } from '../compiler.js'
import { registerBuiltinWorkflow } from '../registry.js'
import { CODE_REVIEW_WORKFLOW_SCRIPT } from './code-review.js'
import { DAEDALUS_WORKFLOW_SCRIPT } from './daedalus.js'
import { DEEP_RESEARCH_WORKFLOW_SCRIPT } from './deep-research.js'

/** Parse a bundled script's pure-literal meta; a failure is a build bug. */
function metaOf(script: string, label: string) {
  const parsed = parseWorkflowScript(script)
  if ('ok' in parsed && parsed.ok === false) {
    throw new Error(`Bundled workflow "${label}" failed to parse its meta: ${parsed.error}`)
  }
  const { name, description, whenToUse, phases } = (parsed as ParsedWorkflow).meta
  return { name, description, whenToUse, phases }
}

let registered = false

/** Register every built-in workflow. Idempotent per process. */
export function initBundledWorkflows(): void {
  if (registered) return
  registered = true

  registerBuiltinWorkflow(
    DEEP_RESEARCH_WORKFLOW_SCRIPT,
    metaOf(DEEP_RESEARCH_WORKFLOW_SCRIPT, 'deep-research'),
  )

  // Registered hidden — reachable by the skill that drives it, invisible to
  // the pickers.
  registerBuiltinWorkflow(
    CODE_REVIEW_WORKFLOW_SCRIPT,
    metaOf(CODE_REVIEW_WORKFLOW_SCRIPT, 'code-review'),
    { hidden: true },
  )

  // Opt-in: the flag is read at this once-per-process registration, so an env
  // flip changes the registry only in a fresh process.
  if (flagEnabled('MERCURY_DAEDALUS')) {
    registerBuiltinWorkflow(
      DAEDALUS_WORKFLOW_SCRIPT,
      metaOf(DAEDALUS_WORKFLOW_SCRIPT, 'daedalus'),
    )
  }
}
