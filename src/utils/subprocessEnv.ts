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
  'ANTHROPIC_CUSTOM_HEADERS',
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
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
]

const BROWSER_SECRET_PREFIX = 'MERCURY_BROWSER_SECRET_'

export function subprocessEnv(): NodeJS.ProcessEnv {
  const env = process.env
  const scrubForCI = isEnvTruthy(process.env.MERCURY_SUBPROCESS_ENV_SCRUB)
  const isolateCredentials = isEnvTruthy(process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION)
  const hasTokenVar = ALWAYS_STRIP_TOKEN_VARS.some(name => env[name] !== undefined)
  const hasOtelVar = Object.keys(env).some(key => key.startsWith('OTEL_'))
  const hasBrowserSecret = Object.keys(env).some(key => key.startsWith(BROWSER_SECRET_PREFIX))
  if (!scrubForCI && !isolateCredentials && !hasTokenVar && !hasOtelVar && !hasBrowserSecret) {
    return env
  }

  const clone: NodeJS.ProcessEnv = { ...env }
  for (const name of ALWAYS_STRIP_TOKEN_VARS) {
    delete clone[name]
  }
  for (const key of Object.keys(clone)) {
    if (key.startsWith('OTEL_') || key.startsWith(BROWSER_SECRET_PREFIX)) delete clone[key]
  }
  if (isolateCredentials) {
    for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) {
      delete clone[name]
    }
  }
  if (scrubForCI) {
    for (const name of CI_SCRUB_VARS) {
      delete clone[name]
      delete clone[`INPUT_${name}`]
    }
  }
  return clone
}

export function languageServerEnv(): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...subprocessEnv() }
  for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) {
    delete clone[name]
  }
  return clone
}
