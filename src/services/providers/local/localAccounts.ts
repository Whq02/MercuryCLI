// ============================================================================
//  providers/local/localAccounts — the locally-served family's credential +
//  presence owner.
// ----------------------------------------------------------------------------
//  A local server is keyless by default (Ollama ignores the key, LM Studio
//  ships auth off, vLLM and llama.cpp take an optional --api-key). The ONE
//  optional key: env MERCURY_LOCAL_API_KEY WINS over the auth-scoped stored
//  key (/router key local). Presence is DISCOVERY: the family is "connected"
//  exactly when a probe found a server (localDiscovery) — there is no login.
//  Values never enter logs/records — presence + labels only.
// ============================================================================
import { readStoredLocalApiKey } from '../../../utils/router/providerSecrets.js'
import { getCachedLocalDiscovery } from './localDiscovery.js'

/** The family's ONE remedy sentence for "no server answers" — the probe
 *  route, spelled once (the account-less family has no login door: a
 *  refusal that offered /logins would borrow a credential family's words).
 *  Readers: SATURN's derivation refusal; the usability row and the
 *  undiscovered dispatch profile spell surface-fitted variants of the same
 *  road. */
export const LOCAL_UNREACHABLE_REMEDY =
  'no local server discovered — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL'

/** The optional key: env wins; absence is the normal state, not a refusal. */
export function resolveLocalApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MERCURY_LOCAL_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredLocalApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface LocalAccountRef {
  kind: 'keyless' | 'api-key'
  /** Display words ('Ollama 0.11.4 · 3 models') — never a value. */
  label: string
  keySource?: 'env' | 'stored'
  serverCount: number
  modelCount: number
}

/** The family's presence view from the discovery cache — undefined until a
 *  probe found a server (the honest absent state; nothing to sign into). */
export function resolveLocalAccount(env: NodeJS.ProcessEnv = process.env): LocalAccountRef | undefined {
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot || snapshot.servers.length === 0) return undefined
  const modelCount = snapshot.servers.reduce((n, s) => n + s.models.length, 0)
  const servers = snapshot.servers.map(s => `${s.label} (${s.models.length})`).join(' · ')
  const key = resolveLocalApiKey(env)
  return {
    kind: key ? 'api-key' : 'keyless',
    label: key ? `${servers} · key (${key.source})` : servers,
    ...(key ? { keySource: key.source } : {}),
    serverCount: snapshot.servers.length,
    modelCount,
  }
}
