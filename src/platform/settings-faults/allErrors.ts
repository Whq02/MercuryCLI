import { getMcpConfigsByScope } from '../../integrations/mcp/serverConfigs.js'
import { ConfigAccessBeforeAllowedError } from '../config/globalConfig.js'
import { errorMessage } from '../errors/errors.js'
import { getSettingsWithErrors } from '../settings/settings.js'
import type { SettingsWithErrors, ValidationError } from '../settings/validation.js'
import { passedOver } from '../errors/passedOver.js'

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
