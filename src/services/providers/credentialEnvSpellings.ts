// ============================================================================
//  providers/credentialEnvSpellings — the ONE table of provider credential
//  env spellings, keyed by the route-law family union (FN-013 AUTH-07).
//
//  The subprocess scrub used to hand-list four spellings while the router
//  resolved eleven — every family added since drifted straight past the
//  strip, and by default every stdio MCP server, hook, language server and
//  model-issued shell command inherited the operator's provider
//  credentials. This table is the drift-proofing: the Record is EXHAUSTIVE
//  over CallModelRoute, so a new family fails the typecheck until its
//  spelling row lands (the same covered-by-construction pattern the
//  foreign-tool signature table uses), and the runtime prover enumerates
//  the declared id spaces against it.
//
//  Deliberately a LEAF: the type import erases at build time, the data is
//  pure — subprocessEnv (on every child spawn path) imports this without
//  dragging the provider estate along.
// ============================================================================
import type { CallModelRoute } from './idSpaces.js'

/** Every env spelling that can carry a family's credential. Values only —
 *  never read here; the strip paths consume the names. */
export const PROVIDER_CREDENTIAL_ENV_VARS: Record<CallModelRoute, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  zai: ['ZAI_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  huggingface: ['HF_TOKEN'],
  'openai-compat': ['MERCURY_COMPAT_API_KEY'],
  local: ['MERCURY_LOCAL_API_KEY'],
}

/** The flat derived strip set, deduplicated, stable order. */
export const ALL_PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  ...new Set(Object.values(PROVIDER_CREDENTIAL_ENV_VARS).flat()),
]
