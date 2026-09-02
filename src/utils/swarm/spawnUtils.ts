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

/**
 * Child-process command/flag/env composition for pane teammates.
 */

/** The env override wins; else the executable in bundled mode, else the running script. */
export function getTeammateCommand(): string {
  const override = process.env[TEAMMATE_COMMAND_ENV_VAR]
  if (override !== undefined && override.length > 0) return override
  if (isInBundledMode()) return process.execPath
  return process.argv[1] ?? process.execPath
}

/**
 * Inherited CLI flags. Strategy mode outranks a bypass for safety (a
 * strategy-required spawn inherits nothing); the bypass posture is
 * evaluated through the shared predicate so that autopilot passes down the
 * bypass ARM and never the autopilot mode name itself — a silent child
 * downgrade otherwise. Only interpolated values are shell-quoted; the fixed
 * flag literals and the teammate-mode value are emitted plain, and the
 * teammate-mode flag is always present and last.
 */
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

/**
 * The forwarding list (in order). Each family earns its place: the
 * base URL and config dir (a child without them sends API traffic to the
 * default endpoint, not where the parent's goes), and the proxy/CA bundle
 * family (a parent behind an intercepting relay has credentials attached
 * to outbound requests; a child that never learns the proxy settings
 * connects directly and arrives credential-less).
 * (The remote pair left the list with the compat retirement —
 * the remote/CI detection class has no readers any more.)
 */
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

/**
 * Inherited environment, placed inline in the spawn command rather than
 * relied on as inherited process environment — the shell tmux starts in the
 * new pane may be a login shell that builds its environment from scratch.
 * `MERCURY=1` is the ONE agent-context marker (no CLAUDECODE=1 ecosystem
 * stamp — third-party tools keying on that spelling lose
 * agent-context detection, an accepted consequence).
 */
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
