import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../services/providers/credentialEnvSpellings.js'
import { isEnvTruthy } from './envUtils.js'
import { AGENT_CLI_SESSION_ENV_VARS, AGENT_CLI_TOKEN_FD_ENV_VARS } from './knownAgentClis.js'

/**
 * Produces the scrubbed environment handed to every spawned child process
 * (shell tool, shell snapshot, stdio MCP servers, language servers, hooks).
 */

/**
 * Session/auth variables no child ever needs: the parent re-reads them
 * lazily per request, and handing a session token or a subscription tier
 * to a subprocess opens an exfiltration path.
 */
export const ALWAYS_STRIP_TOKEN_VARS: readonly string[] = [
  // Mercury's own env-supplied session token.
  'MERCURY_OAUTH_TOKEN',
  // Foreign products' session/auth env a nested boot can inherit (a shell
  // launched from inside another coding tool): stripped so another tool's
  // credentials and account facts never reach Mercury's children. The
  // spellings DERIVE from the signature table (knownAgentClis.ts) — every
  // row equally, so a new tool is scrubbed by construction.
  ...AGENT_CLI_SESSION_ENV_VARS,
]

/** The stored-token gate's WHOLE strip set (HB-0078): everything the gated
 *  scrub removes when a stored OAuth token exists — the session tokens above
 *  plus the token file-descriptors (own spelling + the table-derived foreign
 *  spellings). ONE home: both daemon spawn doors consume it — the owned
 *  spawn (ownedDaemon.ts) and the restart successor (daemon/main.ts), so a
 *  restart re-resolves the operator's stored account exactly like a fresh
 *  spawn would. */
export const STORED_TOKEN_SCRUB_VARS: readonly string[] = [
  ...ALWAYS_STRIP_TOKEN_VARS,
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  ...AGENT_CLI_TOKEN_FD_ENV_VARS,
]

/**
 * The CI hardening list: each of these — and its `INPUT_`-prefixed twin,
 * which the CI system auto-creates for workflow inputs — is stripped under
 * the scrub flag. The CI platform tokens (GITHUB_TOKEN / GH_TOKEN) are
 * deliberately NOT scrubbed: wrapper scripts need them and they are
 * job-scoped.
 */
const CI_SCRUB_VARS: readonly string[] = [
  // Provider API keys, symmetrically — DERIVED from the route-law family
  // table (credentialEnvSpellings), so a new family is stripped by
  // construction (FN-013 AUTH-07: the hand-kept list named four spellings
  // while the router resolved eleven; no provider's key spelling gets
  // special CI treatment by omission — the neutrality ruling).
  ...ALL_PROVIDER_CREDENTIAL_ENV_VARS,
  'MERCURY_OAUTH_TOKEN',
  // Every known tool's session/auth spellings (derived from the signature
  // table, knownAgentClis.ts — every row equally), for CI runners whose env
  // carries another tool's credential.
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

/**
 * The environment for a spawned child. Hot path: when nothing needs
 * stripping and the CI scrub is off, the LIVE process environment object
 * is returned by reference, without cloning.
 */
/** Browser-tool secret family (services/browser/browserSecrets.ts): the
 *  values are operator-registered credentials the Browser tool fills into
 *  pages WITHOUT the model ever seeing them — no child (shell, MCP server,
 *  hook, language server) may inherit the family. */
const BROWSER_SECRET_PREFIX = 'MERCURY_BROWSER_SECRET_'

export function subprocessEnv(): NodeJS.ProcessEnv {
  const env = process.env
  const scrubForCI = isEnvTruthy(process.env.MERCURY_SUBPROCESS_ENV_SCRUB)
  // The registered isolation posture (FN-013 AUTH-07): truthy moves shell,
  // hooks and stdio MCP servers from ambient credential inheritance to
  // explicit grant (the MCP configuration's per-server env block is the
  // documented grant path). Unset ⇒ byte-identical ambient inheritance —
  // flipping the default is a follow-on, not this release.
  const isolateCredentials = isEnvTruthy(process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION)
  // Defined at all — even as an empty string — counts as present.
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
    // Children never need exporter configuration, and the OTLP header
    // variables are specified to carry bearer credentials. The browser
    // secret family is always stripped for the same reason.
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

/**
 * The environment for a spawned LANGUAGE SERVER (FN-013 AUTH-07): the
 * subprocess environment with the provider credential set stripped
 * UNCONDITIONALLY — a language server has no credential need, and by
 * default it inherited every provider key the operator held. An operator
 * or extension server that genuinely needs a variable grants it through
 * its own per-server env block, which the spawn site overlays after this.
 */
export function languageServerEnv(): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...subprocessEnv() }
  for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) {
    delete clone[name]
  }
  return clone
}
