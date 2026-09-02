
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

interface WorkflowManagedSettings {
  disableWorkflows?: boolean
  workflowKeywordTriggerEnabled?: boolean
}

function policyWorkflowSettings(): WorkflowManagedSettings | null {
  return getSettingsForSource('policySettings') as WorkflowManagedSettings | null
}

export function workflowsManagedDisabled(): boolean {
  return policyWorkflowSettings()?.disableWorkflows === true
}

export function dynamicWorkflowsEnabled(): boolean {
  if (workflowsManagedDisabled()) return false
  if (flagEnv('MERCURY_WORKFLOWS') === '0') return false
  return true
}

export function workflowsDisabled(): boolean {
  return !dynamicWorkflowsEnabled()
}

export function workflowKeywordTriggerEnabled(): boolean {
  return policyWorkflowSettings()?.workflowKeywordTriggerEnabled ?? true
}
