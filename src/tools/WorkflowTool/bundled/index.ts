
import { flagEnabled } from '../../../substrate/flagRegistry.js'
import { parseWorkflowScript, type ParsedWorkflow } from '../compiler.js'
import { registerBuiltinWorkflow } from '../registry.js'
import { CODE_REVIEW_WORKFLOW_SCRIPT } from './code-review.js'
import { DAEDALUS_WORKFLOW_SCRIPT } from './daedalus.js'
import { DEEP_RESEARCH_WORKFLOW_SCRIPT } from './deep-research.js'

function metaOf(script: string, label: string) {
  const parsed = parseWorkflowScript(script)
  if ('ok' in parsed && parsed.ok === false) {
    throw new Error(`Bundled workflow "${label}" failed to parse its meta: ${parsed.error}`)
  }
  const { name, description, whenToUse, phases } = (parsed as ParsedWorkflow).meta
  return { name, description, whenToUse, phases }
}

let registered = false

export function initBundledWorkflows(): void {
  if (registered) return
  registered = true

  registerBuiltinWorkflow(
    DEEP_RESEARCH_WORKFLOW_SCRIPT,
    metaOf(DEEP_RESEARCH_WORKFLOW_SCRIPT, 'deep-research'),
  )

  registerBuiltinWorkflow(
    CODE_REVIEW_WORKFLOW_SCRIPT,
    metaOf(CODE_REVIEW_WORKFLOW_SCRIPT, 'code-review'),
    { hidden: true },
  )

  if (flagEnabled('MERCURY_DAEDALUS')) {
    registerBuiltinWorkflow(
      DAEDALUS_WORKFLOW_SCRIPT,
      metaOf(DAEDALUS_WORKFLOW_SCRIPT, 'daedalus'),
    )
  }
}
