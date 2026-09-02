import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

/**
 * The merged settings plus settings validation errors PLUS MCP
 * configuration errors from the user, project and local scopes (the
 * dynamic scope throws at startup instead of reporting). A separate module
 * purely to break a dependency cycle — the plain settings loader
 * deliberately excludes MCP errors.
 */
export function getSettingsWithAllErrors(): SettingsWithErrors {
  const base = getSettingsWithErrors()
  const mcpErrors: ValidationError[] = []
  for (const scope of ['user', 'project', 'local'] as const) {
    try {
      mcpErrors.push(...(getMcpConfigsByScope(scope).errors as ValidationError[]))
    } catch {
      // A scope that cannot be read contributes nothing here.
    }
  }
  return { settings: base.settings, errors: [...base.errors, ...mcpErrors] }
}
