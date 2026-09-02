import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

export function getSettingsWithAllErrors(): SettingsWithErrors {
  const base = getSettingsWithErrors()
  const mcpErrors: ValidationError[] = []
  for (const scope of ['user', 'project', 'local'] as const) {
    try {
      mcpErrors.push(...(getMcpConfigsByScope(scope).errors as ValidationError[]))
    } catch {
    }
  }
  return { settings: base.settings, errors: [...base.errors, ...mcpErrors] }
}
