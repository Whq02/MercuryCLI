// =============================================================================
// Workflow enablement.
//
// The predicates that turn the dynamic-workflow stack on or off. Consulted by
// WorkflowTool.isEnabled()/validateInput(), the registry's disabled path, and
// the command factory — so this small file IS the switch.
//
// Mercury owns the workflow stack: dynamic workflows are ON BY DEFAULT. The
// only gates, in priority order, are the admin managed-disable (policy
// settings), the frozen external compatibility kill-switch env, and the
// registered MERCURY_WORKFLOWS opt-out. Every predicate reads its environment
// LIVE per call — an enablement gate must never latch a stale answer.
// =============================================================================

import { isEnvTruthy } from '../../utils/envUtils.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// The managed (policy) workflow keys. They are not declared on the settings
// type yet, so they are read through a narrow structural view.
interface WorkflowManagedSettings {
  disableWorkflows?: boolean
  workflowKeywordTriggerEnabled?: boolean
}

/**
 * The policy-settings view — the highest-priority settings source. Read from
 * that source directly (never the merged config) so an admin
 * `disableWorkflows` holds even if a user flips the key in their own
 * settings file.
 */
function policyWorkflowSettings(): WorkflowManagedSettings | null {
  return getSettingsForSource('policySettings') as WorkflowManagedSettings | null
}

// -----------------------------------------------------------------------------
// Force-disabled by policy. MERCURY_WORKFLOWS=0
// is the operator opt-out (dynamicWorkflowsEnabled below) — no compat
// spelling.
// -----------------------------------------------------------------------------
export function workflowsManagedDisabled(): boolean {
  return policyWorkflowSettings()?.disableWorkflows === true
}

// -----------------------------------------------------------------------------
// THE gate: are dynamic workflows usable this session?
//
// The kill-switches are consulted before the default can answer — an admin
// policy or an operator opt-out must always win over "on by default". With
// neither present, workflows are on.
// -----------------------------------------------------------------------------
export function dynamicWorkflowsEnabled(): boolean {
  if (workflowsManagedDisabled()) return false
  if (flagEnv('MERCURY_WORKFLOWS') === '0') return false
  return true
}

/**
 * The negated spelling of the same gate, for call sites (the registry's
 * disabled paths) that read more naturally in the negative.
 */
export function workflowsDisabled(): boolean {
  return !dynamicWorkflowsEnabled()
}

/** The keyword auto-trigger defaults on; policy can turn it off. */
export function workflowKeywordTriggerEnabled(): boolean {
  return policyWorkflowSettings()?.workflowKeywordTriggerEnabled ?? true
}
