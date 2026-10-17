import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredZaiApiKey } from '../../../utils/router/providerSecrets.js'
import { ZAI_CODING_API_BASE_URL, zaiApiBase, type ZaiApiPlan } from './zaiClient.js'

interface ZaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

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
    ? ' (ZAI_API_KEY is set in the environment and overrides the stored key this session, using the general base.)'
    : ''
  const base = plan === 'coding' ? ZAI_CODING_API_BASE_URL : zaiApiBase({})
  return {
    ok: true,
    stored: true,
    receipt: `${zaiPlanLabel(plan)} stored (auth-scoped, mode 600). Requests ride ${base.replace(/^https:\/\//, '')}${plan === 'coding' ? ' (the Coding Plan base)' : ' under usage-based billing'}; the GLM rows join /model; the first turn proves the key (no key-check endpoint is wired for Z.AI).${shadowNote}`,
  }
}
