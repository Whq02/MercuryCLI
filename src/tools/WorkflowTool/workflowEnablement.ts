
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'

interface WorkflowManagedSettings {
  disableWorkflows?: boolean
}

function policyWorkflowSettings(): WorkflowManagedSettings | null {
  return getSettingsForSource('policySettings') as WorkflowManagedSettings | null
}

export function workflowsManagedDisabled(): boolean {
  return policyWorkflowSettings()?.disableWorkflows === true
}

export function dynamicWorkflowsEnabled(): boolean {
  if (workflowsManagedDisabled()) return false
  return flagEnabled('MERCURY_WORKFLOWS')
}

export function workflowsDisabled(): boolean {
  return !dynamicWorkflowsEnabled()
}
