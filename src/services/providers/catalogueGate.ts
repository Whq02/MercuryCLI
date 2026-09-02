import { getEssentialTrafficOnlyReason } from '../../utils/privacyLevel.js'
import { resolveGeminiAccount } from './gemini/geminiAccounts.js'
import { resolveHuggingfaceApiKey } from './huggingface/huggingfaceAccounts.js'
import { resolveOpenaiAccount } from './openai/openaiAccounts.js'
import { resolveOpenrouterRequestAuth } from './openrouter/openrouterAccounts.js'

export type CatalogueFamily = 'huggingface' | 'openrouter' | 'gemini' | 'openai' | 'local'

export type CatalogueGateVerdict =
  | { allowed: true; exempt?: 'local-endpoint' }
  | {
      allowed: false
      why: 'no-credential' | 'traffic-off'
      reason: string
    }

const FAMILY_NAMES: Record<Exclude<CatalogueFamily, 'local'>, string> = {
  huggingface: 'Hugging Face',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  openai: 'OpenAI',
}

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
