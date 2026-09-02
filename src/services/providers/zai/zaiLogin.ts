// ============================================================================
//  providers/zai/zaiLogin — the /logins card's GLM (Z.AI) key leg as ONE
//  driver, shared by the connect surface (which only paints) and the
//  loopback prover (which drives the same code path): the key is stored
//  auth-scoped WITH the plan it was minted under — a GLM Coding Plan key is
//  valid on https://api.z.ai/api/coding/paas/v4 and refused on the general
//  base, so the plan is a fact about the key and travels with it. Z.AI is
//  API-key only (docs.z.ai, fetched 2026-08-23 — bearer keys from
//  z.ai/manage-apikey, no OAuth/device flow), so no sign-in is invented.
//  No key-check endpoint is wired for this family: the receipt says the
//  first turn proves the key. Receipts never carry the key value.
// ============================================================================
import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredZaiApiKey } from '../../../utils/router/providerSecrets.js'
import { ZAI_CODING_API_BASE_URL, zaiApiBase, type ZaiApiPlan } from './zaiClient.js'

export interface ZaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

/** The plan words as Z.AI names them (the /logins card's choice). */
export function zaiPlanLabel(plan: ZaiApiPlan): string {
  return plan === 'coding' ? 'GLM Coding Plan key' : 'Z.AI API key (general)'
}

export function storeZaiApiKeyLogin(
  key: string,
  plan: ZaiApiPlan,
  env: NodeJS.ProcessEnv = process.env,
): ZaiKeyLoginOutcome {
  try {
    writeStoredZaiApiKey(key, plan === 'coding' ? 'coding' : undefined)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${errorMessageWithCause(error)}` }
  }
  const shadowNote = env.ZAI_API_KEY?.trim()
    ? ' NOTE: a ZAI_API_KEY env pin is set and WINS over the store this session (an env key rides the general base).'
    : ''
  const base = plan === 'coding' ? ZAI_CODING_API_BASE_URL : zaiApiBase({})
  return {
    ok: true,
    stored: true,
    receipt: `${zaiPlanLabel(plan)} stored (auth-scoped, mode 600). Requests ride ${base.replace(/^https:\/\//, '')}${plan === 'coding' ? ' (the Coding Plan base)' : ' under usage-based billing'}; the GLM rows join /model; the first turn proves the key (no key-check endpoint is wired for Z.AI).${shadowNote}`,
  }
}
