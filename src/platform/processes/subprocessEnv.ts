import { flagEnv } from '../substrate/flagRegistry.js'
import { getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../../models/sign-in/credentials/credentialEnvSpellings.js'
import { isEnvTruthy } from '../environment/envUtils.js'
import { AGENT_CLI_SESSION_ENV_VARS, AGENT_CLI_TOKEN_FD_ENV_VARS } from '../environment/knownAgentClis.js'
import { hostEnv } from '../environment/hostEnv.js'
import {
  envVarKey,
  extraToolShellDefaults,
  headlessGitDefaults,
  isPlatformAskpassVar,
  loginPathOverride,
  mergeLoginPath,
  toolShellEnvKey,
} from '../host-os/spawn.js'


export const ALWAYS_STRIP_TOKEN_VARS: readonly string[] = [
  'MERCURY_OAUTH_TOKEN',
  ...AGENT_CLI_SESSION_ENV_VARS,
]

export const STORED_TOKEN_SCRUB_VARS: readonly string[] = [
  ...ALWAYS_STRIP_TOKEN_VARS,
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  ...AGENT_CLI_TOKEN_FD_ENV_VARS,
]

const CI_SCRUB_VARS: readonly string[] = [
  ...ALL_PROVIDER_CREDENTIAL_ENV_VARS,
  'MERCURY_OAUTH_TOKEN',
  ...AGENT_CLI_SESSION_ENV_VARS,
  'ANTHROPIC_FOUNDRY_API_KEY',
  'MERCURY_PROVIDER_HEADERS',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
]

const BROWSER_SECRET_PREFIX = 'MERCURY_BROWSER_SECRET_'

export const HEADLESS_CHILD_DEFAULTS: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

export const TOOL_SHELL_DEFAULTS: Readonly<Record<string, string>> = {
  ...HEADLESS_CHILD_DEFAULTS,
  MERCURY: '1',
  AGENT: '1',
  AI_AGENT: 'mercury',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  GH_PAGER: 'cat',
  GLAB_PAGER: 'cat',
  MANPAGER: 'cat',
  PSQL_PAGER: 'cat',
  AWS_PAGER: '',
  LESS: '-FRX',
  BAT_PAGER: '',
  DELTA_PAGER: 'cat',
  EDITOR: 'true',
  VISUAL: 'true',
  GIT_EDITOR: 'true',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  PYTHONUNBUFFERED: '1',
  npm_config_yes: 'false',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_progress: 'false',
  PNPM_CONFIG_UPDATE_NOTIFIER: 'false',
  YARN_ENABLE_PROGRESS_BARS: '0',
  YARN_ENABLE_TELEMETRY: '0',
  YARN_PREFER_INTERACTIVE: '0',
  CARGO_TERM_COLOR: 'never',
  CARGO_TERM_PROGRESS_WHEN: 'never',
  PIP_NO_INPUT: '1',
  TF_INPUT: '0',
  GH_PROMPT_DISABLED: '1',
}

export function toolShellEnv(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  const keyOf = (key: string): string => toolShellEnvKey(key, platform)
  const dropped = new Set([keyOf('OLDPWD'), keyOf('CDPATH')])
  const child: NodeJS.ProcessEnv = {}
  const names = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    const folded = keyOf(key)
    if (value === undefined || dropped.has(folded) || isPlatformAskpassVar(key, value, platform)) continue
    const previous = names.get(folded)
    if (previous !== undefined && previous !== key) delete child[previous]
    child[key] = value
    names.set(folded, key)
  }
  for (const [key, value] of Object.entries(overrides)) {
    const folded = keyOf(key)
    if (dropped.has(folded)) continue
    const previous = names.get(folded)
    if (previous !== undefined && previous !== key) delete child[previous]
    child[key] = value
    names.set(folded, key)
  }
  const defaults = { ...TOOL_SHELL_DEFAULTS, ...extraToolShellDefaults(platform) }
  for (const [key, value] of Object.entries(defaults)) {
    if (!names.has(keyOf(key))) child[key] = value
  }
  return child
}

function windowsHeadlessGitDefaultsOwed(env: NodeJS.ProcessEnv, platform: string): string[] {
  const extraKeys = Object.keys(headlessGitDefaults(platform))
  if (extraKeys.length === 0 || !getIsNonInteractiveSession()) return []
  const entries = Object.entries(env)
  const promptSetting = entries.reduce<string | undefined>((found, [key, value]) => (envVarKey(key, platform) === 'GIT_TERMINAL_PROMPT' ? value : found), undefined)
  if (promptSetting === '1') return []
  const present = new Set(entries.filter(([key, value]) => value !== undefined && !isPlatformAskpassVar(key, value, platform)).map(([key]) => envVarKey(key, platform)))
  return extraKeys.filter(name => !present.has(envVarKey(name, platform)))
}

export function headlessChildDefaultsOwed(env: NodeJS.ProcessEnv, platform: string = process.platform): string[] {
  if (!getIsNonInteractiveSession()) return []
  const present = new Set(Object.keys(env).map(name => envVarKey(name, platform)))
  return Object.keys(HEADLESS_CHILD_DEFAULTS).filter(name => !present.has(envVarKey(name, platform)))
}
function deleteNames(env: NodeJS.ProcessEnv, names: readonly string[], platform: string = process.platform): void {
  const doomed = new Set(names.map(name => envVarKey(name, platform)))
  for (const key of Object.keys(env)) {
    if (doomed.has(envVarKey(key, platform))) delete env[key]
  }
}

export function subprocessEnv(options: { stripProviderCredentials?: boolean; platform?: string } = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const env = hostEnv()
  const scrubForCI = isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_ENV_SCRUB'))
  const isolateCredentials = options.stripProviderCredentials === true || isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION'))
  const hasTokenVar = ALWAYS_STRIP_TOKEN_VARS.some(name => env[name] !== undefined)
  const hasOtelVar = Object.keys(env).some(key => envVarKey(key, platform).startsWith('OTEL_'))
  const hasBrowserSecret = Object.keys(env).some(key => envVarKey(key, platform).startsWith(BROWSER_SECRET_PREFIX))
  const hasWindowsAskpass = Object.entries(env).some(([key, value]) => isPlatformAskpassVar(key, value, platform))
  const owedDefaults = headlessChildDefaultsOwed(env, platform)
  const owedWindowsGit = windowsHeadlessGitDefaultsOwed(env, platform)
  if (!scrubForCI && !isolateCredentials && !hasTokenVar && !hasOtelVar && !hasBrowserSecret && !hasWindowsAskpass && owedDefaults.length === 0 && owedWindowsGit.length === 0) {
    return env
  }

  const clone: NodeJS.ProcessEnv = { ...env }
  for (const name of owedDefaults) clone[name] = HEADLESS_CHILD_DEFAULTS[name]
  scrub(clone, scrubForCI, isolateCredentials, platform)
  if (owedWindowsGit.length > 0 || hasWindowsAskpass) {
    const present = new Set(Object.keys(clone).map(key => envVarKey(key, platform)))
    for (const [name, value] of Object.entries(headlessGitDefaults(platform))) {
      if (!present.has(envVarKey(name, platform))) clone[name] = value
    }
  }
  return clone
}

function scrub(clone: NodeJS.ProcessEnv, scrubForCI: boolean, isolateCredentials: boolean, platform: string = process.platform): void {
  deleteNames(clone, ALWAYS_STRIP_TOKEN_VARS, platform)
  for (const [key, value] of Object.entries(clone)) {
    const folded = envVarKey(key, platform)
    if (folded.startsWith('OTEL_') || folded.startsWith(BROWSER_SECRET_PREFIX) || isPlatformAskpassVar(key, value, platform)) delete clone[key]
  }
  if (isolateCredentials) {
    deleteNames(clone, ALL_PROVIDER_CREDENTIAL_ENV_VARS, platform)
  }
  if (scrubForCI) {
    deleteNames(clone, CI_SCRUB_VARS.flatMap(name => [name, `INPUT_${name}`]), platform)
  }
}

export function devinCliChildEnv(platform: string = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...subprocessEnv({ stripProviderCredentials: true, platform }) }
  deleteNames(env, ['WINDSURF_API_KEY'], platform)
  return env
}
const SHELL_KEEPS_TO_ITSELF =
  /^(?:_|SHLVL|PWD|OLDPWD|CDPATH|SHELLOPTS|BASHOPTS|BASHPID|PS[0-4]|PSVAR|PROMPT[2-4]?|PROMPT_COMMAND|PROMPT_DIRTRIM|PROMPT_EOL_MARK|RPROMPT2?|RPS[12]|SPROMPT|HIST\w*|SAVEHIST|(?:BASH|ZSH)(?:_\w*)?)$/

export function loginExportsCarried(exported: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const carried: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(exported)) {
    if (/^[A-Za-z_]\w*$/.test(name) && !SHELL_KEEPS_TO_ITSELF.test(name)) carried[name] = value
  }
  scrub(carried, isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_ENV_SCRUB')), isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION')))
  return carried
}

export function pathWithLoginEntries(own: string, carried: NodeJS.ProcessEnv | undefined, platform: string = process.platform): string {
  return mergeLoginPath(own, carried, platform)
}

export function withLoginExports(
  env: NodeJS.ProcessEnv,
  carried: NodeJS.ProcessEnv | undefined,
  scrubbed: readonly string[],
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  if (carried === undefined) return env
  const held = new Set([...Object.keys(env), ...scrubbed, 'OLDPWD', 'CDPATH'].map(key => toolShellEnvKey(key, platform)))
  const gained: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(carried)) {
    if (isPlatformAskpassVar(name, value, platform)) continue
    const folded = toolShellEnvKey(name, platform)
    if (folded !== 'PATH' && !held.has(folded)) gained[name] = value
  }
  const path = loginPathOverride(env.PATH ?? '', carried, platform)
  if (path !== undefined && path !== (env.PATH ?? '')) gained.PATH = path
  return Object.keys(gained).length === 0 ? env : { ...env, ...gained }
}

export function languageServerEnv(): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...subprocessEnv() }
  deleteNames(clone, ALL_PROVIDER_CREDENTIAL_ENV_VARS)
  return clone
}
