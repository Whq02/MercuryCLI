import {
  getFlagSettingsPath,
  getSessionExtensions,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import { modeBypassesPermissions, type PermissionMode } from '../permissions/PermissionMode.js'
import { getResolvedTeammateMode } from './backends/registry.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'


export function getTeammateCommand(): string {
  const override = process.env[TEAMMATE_COMMAND_ENV_VAR]
  if (override !== undefined && override.length > 0) return override
  if (isInBundledMode()) return process.execPath
  return process.argv[1] ?? process.execPath
}

export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  if (!options?.planModeRequired) {
    const permissionMode = options?.permissionMode
    if (
      (permissionMode !== undefined && modeBypassesPermissions(permissionMode)) ||
      getSessionBypassPermissionsMode()
    ) {
      flags.push('--dangerously-skip-permissions')
    } else if (permissionMode === 'implement') {
      flags.push('--permission-mode implement')
    }
  }
  const modelOverride = getMainLoopModelOverride()
  if (typeof modelOverride === 'string' && modelOverride.length > 0) {
    flags.push(`--model ${quote([modelOverride])}`)
  }
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }
  for (const extensionPath of getSessionExtensions()) {
    flags.push(`--extension ${quote([extensionPath])}`)
  }
  flags.push(`--teammate-mode ${getResolvedTeammateMode()}`)
  return flags.join(' ')
}

const FORWARDED_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'MERCURY_CONFIG_DIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]

export function buildInheritedEnvVars(): string {
  const parts = ['MERCURY=1']
  for (const key of FORWARDED_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      parts.push(`${key}=${quote([value])}`)
    }
  }
  return parts.join(' ')
}
