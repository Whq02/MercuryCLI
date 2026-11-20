import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { ConfigAccessBeforeAllowedError } from '../config/globalConfig.js'
import { errorMessage } from '../errors.js'
import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'
import { passedOver } from '../passedOver.js'

export function getSettingsWithAllErrors(): SettingsWithErrors {
  const base = getSettingsWithErrors()
  const mcpErrors: ValidationError[] = []
  for (const scope of ['user', 'project', 'local'] as const) {
    try {
      mcpErrors.push(...(getMcpConfigsByScope(scope).errors as ValidationError[]))
    } catch (error) {
      passedOver(error)
      if (error instanceof ConfigAccessBeforeAllowedError) continue
      mcpErrors.push({
        path: '',
        message: `Failed to read MCP configuration file: ${errorMessage(error)}`,
        mcpErrorMetadata: { scope, severity: 'fatal' },
      })
    }
  }
  return { settings: base.settings, errors: [...base.errors, ...mcpErrors] }
}
