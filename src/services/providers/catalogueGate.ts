// ============================================================================
//  providers/catalogueGate — THE one door for model-catalogue traffic.
//
//  MERCURY'S LAW: catalogue/model-list traffic to a provider happens ONLY
//  while that provider holds a live credential on this home (signed in, or a
//  key present). With no credential there is NO request — not at boot, not at
//  picker-open, not on a discovery refresh; the picker says "connect
//  <provider> to browse its models" instead of fetching. And
//  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC stops ALL catalogue traffic,
//  credentialed included — dispatch stays essential, browsing goes dark.
//
//  ONE OWNER: every per-provider catalogue fetch (the models lists, and the
//  OpenRouter /key probe that rides the same discovery estate) asks this door
//  before opening a socket. The law is decided HERE and nowhere else — the
//  fetch sites route through the verdict; they never carry their own copy of
//  the credential/switch logic.
//
//  THE LOCAL BOUNDARY: the 'local' family is exempt BY CONSTRUCTION. Its
//  fetch targets are the operator's own machines — the fixed loopback
//  discovery roots (localDiscovery's 127.0.0.1 well-known set) and the
//  endpoints the operator configured by hand. Asking an operator-owned
//  loopback/LAN server what it serves is not a phone-home; the exemption is
//  drawn at the FAMILY (whose target set contains no vendor host), never at
//  a URL pattern.
//
//  Credential presence comes from each family's OWNING account resolver
//  (the modelRegistry doctrine: never assumed, never a second copy) and the
//  check is a sync PRESENCE read — the door never refreshes a token and
//  never opens a socket itself.
// ============================================================================
import { getEssentialTrafficOnlyReason } from '../../utils/privacyLevel.js'
import { resolveGeminiAccount } from './gemini/geminiAccounts.js'
import { resolveHuggingfaceApiKey } from './huggingface/huggingfaceAccounts.js'
import { resolveOpenaiAccount } from './openai/openaiAccounts.js'
import { resolveOpenrouterRequestAuth } from './openrouter/openrouterAccounts.js'

/** The families that fetch a live catalogue (or its adjacent key probe). */
export type CatalogueFamily = 'huggingface' | 'openrouter' | 'gemini' | 'openai' | 'local'

export type CatalogueGateVerdict =
  | { allowed: true; exempt?: 'local-endpoint' }
  | {
      allowed: false
      why: 'no-credential' | 'traffic-off'
      /** Operator-actionable words — surfaces render this verbatim. */
      reason: string
    }

const FAMILY_NAMES: Record<Exclude<CatalogueFamily, 'local'>, string> = {
  huggingface: 'Hugging Face',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  openai: 'OpenAI',
}

/** The ruled signed-out sentence, one spelling for every surface; surfaces
 *  append their own action hint (↵ runs /logins, HF_TOKEN works too, …). */
export function connectToBrowseReason(family: Exclude<CatalogueFamily, 'local'>): string {
  return `connect ${FAMILY_NAMES[family]} to browse its models`
}

function credentialPresent(family: Exclude<CatalogueFamily, 'local'>, env: NodeJS.ProcessEnv): boolean {
  switch (family) {
    case 'huggingface':
      return resolveHuggingfaceApiKey(env) !== undefined
    case 'openrouter':
      return resolveOpenrouterRequestAuth(env) !== undefined
    case 'gemini':
      return resolveGeminiAccount(env) !== undefined
    case 'openai':
      return resolveOpenaiAccount(env) !== undefined
  }
}

/**
 * The door. Sync, pure over (env, credential stores) — safe at every seam
 * that already reads availability. Refusals name their remedy.
 */
export function catalogueTrafficVerdict(
  family: CatalogueFamily,
  env: NodeJS.ProcessEnv = process.env,
): CatalogueGateVerdict {
  if (family === 'local') return { allowed: true, exempt: 'local-endpoint' }
  if (!credentialPresent(family, env)) {
    return {
      allowed: false,
      why: 'no-credential',
      reason: `${connectToBrowseReason(family)} — /logins connects`,
    }
  }
  const trafficOff = getEssentialTrafficOnlyReason(env)
  if (trafficOff) {
    return {
      allowed: false,
      why: 'traffic-off',
      reason: `catalogue traffic is off (${trafficOff}) — unset it to browse live models`,
    }
  }
  return { allowed: true }
}
