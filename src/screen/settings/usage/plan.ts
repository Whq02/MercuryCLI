import { recentSignIns, mostRecentSignInFamily } from '../../../models/catalogue/computedDefault.js'
import { getUserSpecifiedModelSetting, parseUserSpecifiedModel } from '../../../models/catalogue/engineModel.js'
import { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import type { ProviderFamilyId } from '../../../models/roads/providerAdapter.js'
import type { ProviderFamilyPresence } from '../../../models/roads/providerUsage.js'
import { focusedSessionModelFacts } from '../../../engine/connector/focusedConnector.js'
import { LOCAL_SETUP_OFFER } from '../../../commands/localsetup/words.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export const ENGINE_USAGE_PRESENTATION: Record<
  string,
  { title: string; connect: string; limitsNote: string }
> = {
  openai: {
    title: 'OpenAI usage',
    connect: '/logins adds an OpenAI account',
    limitsNote: 'Usage bills to your OpenAI account; no polled limit meter exists here.',
  },
  zai: {
    title: 'Z.AI usage',
    connect: '/logins zai adds a Z.AI API key (general or GLM Coding Plan; ZAI_API_KEY works too)',
    limitsNote: 'A GLM Coding Plan key meters its 5-hour and weekly credit windows; a general key bills usage to your Z.AI account.',
  },
  openrouter: {
    title: 'OpenRouter usage',
    connect: '/logins adds OpenRouter (OAuth mints a key, or paste one)',
    limitsNote: 'Usage bills OpenRouter credits; the key endpoint serves live credit truth.',
  },
  gemini: {
    title: 'Gemini usage',
    connect: '/logins adds Gemini (API key, or Google OAuth with your own client)',
    limitsNote: 'Usage bills to your Google account; the connected section states what the provider publishes.',
  },
  moonshot: {
    title: 'Moonshot usage',
    connect: '/logins moonshot adds Kimi (device-code sign-in, or a Moonshot API key; MOONSHOT_API_KEY works too)',
    limitsNote: 'A Kimi sign-in meters its plan windows; a key bills to your Moonshot account balance.',
  },
  meta: {
    title: 'Meta usage',
    connect: '/logins meta signs in with Meta or adds a Model API key (MODEL_API_KEY)',
    limitsNote: 'A Muse Code subscription meters its window and weekly allowance from the key endpoint; API keys bill pay-as-you-go at dev.meta.ai.',
  },
  deepseek: {
    title: 'DeepSeek usage',
    connect: '/logins deepseek adds a DeepSeek API key (DEEPSEEK_API_KEY works too)',
    limitsNote: 'Usage bills to your DeepSeek account balance.',
  },
  xai: {
    title: 'xAI usage',
    connect: '/logins xai adds a Grok subscription sign-in or an xAI API key (XAI_API_KEY works too)',
    limitsNote: 'A Grok subscription meters its included pool and purchased credits from the Grok proxy; a management key reads the API team’s prepaid credits, billing-cycle usage and postpaid spending limit.',
  },
  'openai-compat': {
    title: 'Custom endpoint usage',
    connect: 'set MERCURY_COMPAT_BASE_URL (key optional — MERCURY_COMPAT_API_KEY)',
    limitsNote: 'Usage bills to the endpoint you configured; no polled limit meter exists here.',
  },
  mistral: {
    title: 'Mistral usage',
    connect: '/logins mistral adds a Mistral API key (MISTRAL_API_KEY works too)',
    limitsNote: 'A key draws on the plan’s included monthly usage, then pay-as-you-go when that is on; an Admin API key reads the organisation’s usage against its monthly limit and the rate limits.',
  },
  huggingface: {
    title: 'Hugging Face usage',
    connect: '/logins adds Hugging Face (device-code sign-in, or paste a token; HF_TOKEN works too)',
    limitsNote: 'Usage bills to your Hugging Face account; the connected section states what the provider publishes.',
  },
  minimax: {
    title: 'MiniMax usage',
    connect: '/logins minimax adds a MiniMax API key or M Plan API key (MINIMAX_API_KEY works too)',
    limitsNote: 'A pay-as-you-go key draws the Open Platform balance shown at platform.minimax.io; an M Plan API key meters its 5-hour and weekly windows here.',
  },
  together: {
    title: 'Together AI usage',
    connect: '/logins together adds a Together AI API key (TOGETHER_API_KEY works too)',
    limitsNote: 'One key bills the prepaid balance at each model\'s price; the balance and spend controls live at api.together.ai/settings/billing — no polled meter exists here.',
  },
  cohere: {
    title: 'Cohere usage',
    connect: '/logins cohere adds a Cohere API key (COHERE_API_KEY works too)',
    limitsNote: 'A trial key is rate-limited for evaluation; a production key bills pay-as-you-go, with spend shown at dashboard.cohere.com — no polled meter exists here.',
  },
  groq: { title: 'Groq usage', connect: '/logins groq adds an API key (GROQ_API_KEY works too)', limitsNote: 'Rate limits are read from response headers; account spend is shown at console.groq.com/dashboard/usage.' },
  melious: { title: 'Melious AI usage', connect: '/logins melious adds an API key (MELIOUS_API_KEY works too)', limitsNote: 'Melious AI bills in EUR; melious.ai/account/usage shows account spend.' },
  orcarouter: { title: 'OrcaRouter usage', connect: '/logins orcarouter connects an account (ORCAROUTER_API_KEY works too)', limitsNote: 'Manage credits and spending limits at orcarouter.ai/console/billing.' },
  cerebras: { title: 'Cerebras usage', connect: '/logins cerebras adds an API key (CEREBRAS_API_KEY works too)', limitsNote: 'The session ledger counts tokens and spend; the cloud console shows account limits and credits.' },
  fireworks: { title: 'Fireworks usage', connect: '/logins fireworks adds an API key (FIREWORKS_API_KEY works too)', limitsNote: 'The session ledger counts spend and response headers state TPM limits; app.fireworks.ai/account/billing shows account credits.' },
  qwen: { title: 'Qwen usage', connect: '/logins qwen adds a QwenCloud or Model Studio API key (DASHSCOPE_API_KEY works too)', limitsNote: 'Neither QwenCloud nor Model Studio states a usage, balance or quota endpoint an API key can read; the session ledger counts this key\'s tokens and spend, and the QwenCloud or Model Studio console shows the account.' },
  zen: {
    title: 'OpenCode Zen usage',
    connect: '/logins zen adds an OpenCode Zen API key (OPENCODE_API_KEY works too)',
    limitsNote: 'One key bills the pay-as-you-go balance at the vendor\'s prices; the OpenCode console shows the balance and auto-reload. An OpenCode Go plan on the same key meters its 5-hour, weekly and monthly windows here.',
  },
  local: {
    title: 'Local models usage',
    connect: `start Ollama, LM Studio, vLLM or llama.cpp-server (or set MERCURY_LOCAL_BASE_URL), then ollama pull qwen3.5:9b (tool-capable), ${LOCAL_SETUP_OFFER}`,
    limitsNote: 'local · no metering',
  },
  nous: {
    title: 'Nous Portal usage',
    connect: '/logins nous adds a Nous Portal API key (NOUS_API_KEY works too)',
    limitsNote: 'Usage bills the Portal credits or subscription behind the key; the Portal account endpoint states the usable credits and plan when it resolves the key.',
  },
}

export interface UsageSection {
  id: ProviderFamilyId
  kind: 'anthropic' | 'engine'
  title: string
  connect: string
  limitsNote: string
  family: ProviderFamilyPresence
}

export function orderUsageSections(plan: UsageSection[], recency: readonly string[], sessionFamily?: string): UsageSection[] {
  const rank = new Map<string, number>(recency.map((family, index) => [family, index]))
  const byRecency = (a: UsageSection, b: UsageSection): number =>
    (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
  const signedIn = plan.filter(section => section.family.credentialed).sort(byRecency)
  const lead = signedIn.findIndex(section => sessionFamily !== undefined && section.id === sessionFamily)
  if (lead > 0) signedIn.unshift(...signedIn.splice(lead, 1))
  const absent = plan.filter(section => !section.family.credentialed)
  return [...signedIn, ...absent]
}

export function liveSessionFamily(): string | undefined {
  const seated = focusedSessionModelFacts()?.effective
  if (seated) return declaredRouteOf(seated) ?? undefined
  const setting = getUserSpecifiedModelSetting()
  if (setting !== null) return declaredRouteOf(parseUserSpecifiedModel(setting)) ?? undefined
  try {
    return mostRecentSignInFamily()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function liveSignInRecency(): string[] {
  try {
    return recentSignIns().map(credential => credential.family)
  } catch (error) {
    passedOver(error)
    return []
  }
}

export function usageSectionPlan(families: ProviderFamilyPresence[]): UsageSection[] {
  return families
    .map(family => {
      if (family.id === 'anthropic') {
        return {
          id: family.id,
          kind: 'anthropic' as const,
          title: 'Anthropic usage',
          connect: '/logins connects one',
          limitsNote: '',
          family,
        }
      }
      const meta = ENGINE_USAGE_PRESENTATION[family.id] ?? {
        title: `${family.id} usage`,
        connect: 'connect an account for this provider (see /capabilities)',
        limitsNote: 'No polled usage meter exists for this provider in Mercury.',
      }
      return { id: family.id, kind: 'engine' as const, ...meta, family }
    })
}
