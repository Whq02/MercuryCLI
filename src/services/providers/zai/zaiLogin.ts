import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredZaiApiKey } from '../providerSecrets.js'
import { probeZaiKey, type ZaiKeyProbe } from './zaiCatalogue.js'
import { ZAI_CODING_API_BASE_URL, zaiApiBase, type ZaiApiPlan } from './zaiClient.js'

interface ZaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export function zaiPlanLabel(plan: ZaiApiPlan): string {
  return plan === 'coding' ? 'GLM Coding Plan key' : 'Z.AI API key (general)'
}

export async function storeZaiApiKeyLogin(
  key: string,
  plan: ZaiApiPlan,
  env: NodeJS.ProcessEnv = process.env,
  io?: { fetchImpl?: typeof fetch; probeKey?: (key: string, plan: ZaiApiPlan) => Promise<ZaiKeyProbe> },
): Promise<ZaiKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: `Paste a non-empty ${zaiPlanLabel(plan)}.` }
  const base = plan === 'coding' ? ZAI_CODING_API_BASE_URL : zaiApiBase({})
  const host = base.replace(/^https:\/\//, '')
  const probe = await (io?.probeKey ?? ((probed: string, probedPlan: ZaiApiPlan) => probeZaiKey(probed, probedPlan, { env, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })))(key, plan)
  if (probe.state === 'refused') {
    const otherPlan = plan === 'coding' ? 'a general key is refused on the Coding Plan base' : 'a GLM Coding Plan key is refused on the general base'
    return { ok: false, stored: false, receipt: `Z.AI refused this key on ${host} (HTTP ${probe.status}${probe.message ? ` — ${probe.message}` : ''}) — nothing stored; ${otherPlan}, so pick the plan the key was minted under, or make a key at z.ai/manage-apikey and paste again.` }
  }
  try {
    writeStoredZaiApiKey(key, plan === 'coding' ? 'coding' : undefined)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${errorMessageWithCause(error).split(key).join('[redacted]')}` }
  }
  const shadowNote = env.ZAI_API_KEY?.trim()
    ? ' (ZAI_API_KEY is set in the environment and overrides the stored key this session; its plan is ZAI_KEY_PLAN, or read from its own models list.)'
    : ''
  const proof = probe.state === 'accepted'
    ? `${probe.models} GLM ${probe.models === 1 ? 'model' : 'models'} listed for the key`
    : `UNVERIFIED — the models list could not confirm the key (${probe.message}); the first turn proves it`
  return {
    ok: true,
    stored: true,
    receipt: `${zaiPlanLabel(plan)} stored (auth-scoped, mode 600). Requests ride ${host}${plan === 'coding' ? ' (the Coding Plan base)' : ' under usage-based billing'}; the GLM rows join /model; ${proof}.${shadowNote}`,
  }
}
