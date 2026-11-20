import { flagEnv } from '../substrate/flagRegistry.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../services/providers/credentialEnvSpellings.js'
import { isEnvTruthy } from './envUtils.js'
import { AGENT_CLI_SESSION_ENV_VARS, AGENT_CLI_TOKEN_FD_ENV_VARS } from './knownAgentClis.js'


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

const WINDOWS_TOOL_SHELL_DEFAULTS: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GCM_INTERACTIVE: 'never',
}

const GIT_FOR_WINDOWS_ASKPASS_DISPLAY = 'needs-to-be-defined'
const GIT_FOR_WINDOWS_ASKPASS = /(?:^|[/\\])(?:git-askpass(?:\.exe)?|git-gui--askpass)$/i

function unquoteAskpass(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function isGitForWindowsAskpass(key: string, value: string | undefined, platform: string): boolean {
  if (platform !== 'win32' || value === undefined) return false
  const upper = key.toUpperCase()
  if (upper === 'DISPLAY') return value === GIT_FOR_WINDOWS_ASKPASS_DISPLAY
  return (upper === 'SSH_ASKPASS' || upper === 'GIT_ASKPASS') && GIT_FOR_WINDOWS_ASKPASS.test(unquoteAskpass(value))
}

const toolShellKey = (key: string, platform: string): string => platform === 'win32' || /^(?:npm|pnpm)_config_/i.test(key) ? key.toUpperCase() : key

export function toolShellEnv(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  const keyOf = (key: string): string => toolShellKey(key, platform)
  const child: NodeJS.ProcessEnv = {}
  const names = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isGitForWindowsAskpass(key, value, platform)) continue
    const previous = names.get(keyOf(key))
    if (previous !== undefined && previous !== key) delete child[previous]
    child[key] = value
    names.set(keyOf(key), key)
  }
  for (const [key, value] of Object.entries(overrides)) {
    const previous = names.get(keyOf(key))
    if (previous !== undefined && previous !== key) delete child[previous]
    child[key] = value
    names.set(keyOf(key), key)
  }
  const defaults = platform === 'win32' ? { ...TOOL_SHELL_DEFAULTS, ...WINDOWS_TOOL_SHELL_DEFAULTS } : TOOL_SHELL_DEFAULTS
  for (const [key, value] of Object.entries(defaults)) {
    if (!names.has(keyOf(key))) child[key] = value
  }
  return child
}

const WINDOWS_HEADLESS_GIT_DEFAULTS: Readonly<Record<string, string>> = {
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
}

function windowsHeadlessGitDefaultsOwed(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform !== 'win32' || !getIsNonInteractiveSession()) return []
  const entries = Object.entries(env)
  const promptSetting = entries.reduce<string | undefined>((found, [key, value]) => (nameKey(key, platform) === 'GIT_TERMINAL_PROMPT' ? value : found), undefined)
  if (promptSetting === '1') return []
  const present = new Set(entries.filter(([key, value]) => value !== undefined && !isGitForWindowsAskpass(key, value, platform)).map(([key]) => nameKey(key, platform)))
  return Object.keys(WINDOWS_HEADLESS_GIT_DEFAULTS).filter(name => !present.has(nameKey(name, platform)))
}

export function headlessChildDefaultsOwed(env: NodeJS.ProcessEnv, platform: string = process.platform): string[] {
  if (!getIsNonInteractiveSession()) return []
  const present = new Set(Object.keys(env).map(name => nameKey(name, platform)))
  return Object.keys(HEADLESS_CHILD_DEFAULTS).filter(name => !present.has(nameKey(name, platform)))
}

function nameKey(name: string, platform: string = process.platform): string {
  return platform === 'win32' ? name.toUpperCase() : name
}

function deleteNames(env: NodeJS.ProcessEnv, names: readonly string[], platform: string = process.platform): void {
  const doomed = new Set(names.map(name => nameKey(name, platform)))
  for (const key of Object.keys(env)) {
    if (doomed.has(nameKey(key, platform))) delete env[key]
  }
}

export function subprocessEnv(options: { stripProviderCredentials?: boolean; platform?: string } = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const env = process.env
  const scrubForCI = isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_ENV_SCRUB'))
  const isolateCredentials = options.stripProviderCredentials === true || isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION'))
  const hasTokenVar = ALWAYS_STRIP_TOKEN_VARS.some(name => env[name] !== undefined)
  const hasOtelVar = Object.keys(env).some(key => nameKey(key, platform).startsWith('OTEL_'))
  const hasBrowserSecret = Object.keys(env).some(key => nameKey(key, platform).startsWith(BROWSER_SECRET_PREFIX))
  const hasWindowsAskpass = platform === 'win32' && Object.entries(env).some(([key, value]) => isGitForWindowsAskpass(key, value, platform))
  const owedDefaults = headlessChildDefaultsOwed(env, platform)
  const owedWindowsGit = windowsHeadlessGitDefaultsOwed(env, platform)
  if (!scrubForCI && !isolateCredentials && !hasTokenVar && !hasOtelVar && !hasBrowserSecret && !hasWindowsAskpass && owedDefaults.length === 0 && owedWindowsGit.length === 0) {
    return env
  }

  const clone: NodeJS.ProcessEnv = { ...env }
  for (const name of owedDefaults) clone[name] = HEADLESS_CHILD_DEFAULTS[name]
  scrub(clone, scrubForCI, isolateCredentials, platform)
  if (owedWindowsGit.length > 0 || hasWindowsAskpass) {
    const present = new Set(Object.keys(clone).map(key => nameKey(key, platform)))
    for (const [name, value] of Object.entries(WINDOWS_HEADLESS_GIT_DEFAULTS)) {
      if (!present.has(nameKey(name, platform))) clone[name] = value
    }
  }
  return clone
}

function scrub(clone: NodeJS.ProcessEnv, scrubForCI: boolean, isolateCredentials: boolean, platform: string = process.platform): void {
  deleteNames(clone, ALWAYS_STRIP_TOKEN_VARS, platform)
  for (const [key, value] of Object.entries(clone)) {
    const folded = nameKey(key, platform)
    if (folded.startsWith('OTEL_') || folded.startsWith(BROWSER_SECRET_PREFIX) || isGitForWindowsAskpass(key, value, platform)) delete clone[key]
  }
  if (isolateCredentials) {
    deleteNames(clone, ALL_PROVIDER_CREDENTIAL_ENV_VARS, platform)
  }
  if (scrubForCI) {
    deleteNames(clone, CI_SCRUB_VARS.flatMap(name => [name, `INPUT_${name}`]), platform)
  }
}

const SHELL_KEEPS_TO_ITSELF =
  /^(?:_|SHLVL|PWD|OLDPWD|SHELLOPTS|BASHOPTS|BASHPID|PS[0-4]|PSVAR|PROMPT[2-4]?|PROMPT_COMMAND|PROMPT_DIRTRIM|PROMPT_EOL_MARK|RPROMPT2?|RPS[12]|SPROMPT|HIST\w*|SAVEHIST|(?:BASH|ZSH)(?:_\w*)?)$/

export function loginExportsCarried(exported: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const carried: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(exported)) {
    if (/^[A-Za-z_]\w*$/.test(name) && !SHELL_KEEPS_TO_ITSELF.test(name)) carried[name] = value
  }
  scrub(carried, isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_ENV_SCRUB')), isEnvTruthy(flagEnv('MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION')))
  return carried
}

const SYSTEM_PROGRAM_FOLDERS: ReadonlySet<string> = new Set(['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])

export function pathWithLoginEntries(own: string, carried: NodeJS.ProcessEnv | undefined, platform: string = process.platform): string {
  const exported = Object.entries(carried ?? {}).find(([name]) => toolShellKey(name, platform) === 'PATH')?.[1] ?? ''
  const held = new Set(own.split(':'))
  const login = [...new Set(exported.split(':'))].filter(entry => entry !== '')
  const added = login.filter(entry => !held.has(entry))
  if (added.length === 0) return own
  if (platform === 'win32') return [...(own === '' ? [] : [own]), ...added].join(':')
  const ofTheLogin = new Set(login)
  const front = [...held].filter(entry => entry !== '' && !(ofTheLogin.has(entry) && SYSTEM_PROGRAM_FOLDERS.has(entry)))
  const kept = new Set(front)
  return [...front, ...login.filter(entry => !kept.has(entry))].join(':')
}

export function withLoginExports(
  env: NodeJS.ProcessEnv,
  carried: NodeJS.ProcessEnv | undefined,
  scrubbed: readonly string[],
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  if (carried === undefined) return env
  const held = new Set([...Object.keys(env), ...scrubbed].map(key => toolShellKey(key, platform)))
  const gained: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(carried)) {
    if (isGitForWindowsAskpass(name, value, platform)) continue
    if (toolShellKey(name, platform) !== 'PATH' && !held.has(toolShellKey(name, platform))) gained[name] = value
  }
  const path = platform === 'win32' ? undefined : pathWithLoginEntries(env.PATH ?? '', carried, platform)
  if (path !== undefined && path !== (env.PATH ?? '')) gained.PATH = path
  return Object.keys(gained).length === 0 ? env : { ...env, ...gained }
}

export function languageServerEnv(): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...subprocessEnv() }
  deleteNames(clone, ALL_PROVIDER_CREDENTIAL_ENV_VARS)
  return clone
}
