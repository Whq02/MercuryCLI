import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

export function getSettingsWithAllErrors(): SettingsWithErrors {
  const base = getSettingsWithErrors()
  const mcpErrors: ValidationError[] = []
  for (const scope of ['user', 'project', 'local'] as const) {
    try {
      mcpErrors.push(...(getMcpConfigsByScope(scope).errors as ValidationError[]))
    } catch (error) {
      logError(error)
      mcpErrors.push({
        path: '',
        message: `Failed to read MCP configuration file: ${errorMessage(error)}`,
        mcpErrorMetadata: { scope, severity: 'fatal' },
      })
    }
  }
  return { settings: base.settings, errors: [...base.errors, ...mcpErrors] }
}
