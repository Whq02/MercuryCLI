import { getAnthropicApiKey, isClaudeAISubscriber } from '../../utils/auth.js'
import { currentLimits } from '../claudeAiLimits.js'
import { getGptSeatAvailability } from './openai/openaiCatalogue.js'
import { providerDisplayName } from './routeLaw.js'

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

export interface ProviderUsability {
  provider: ProviderId | 'unrecognised'
  credential: 'oauth' | 'api-key' | 'keyless' | 'none'
  limit: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'
  usable: boolean
  blockers: string[]
  delegationCapped?: boolean
}

export interface ProviderUsabilityReads {
  anthropicApiKey: () => string | null
  anthropicSubscriber: () => boolean
  anthropicBearerToken?: () => boolean
  anthropicLimitStatus: () => 'allowed' | 'allowed_warning' | 'rejected'
  gptSeat: () => { state: 'ready' | 'disabled'; reason?: string; why?: string }
  zaiKeyPresent: () => boolean
  moonshotAccount?: () => { kind: 'kimi-oauth' | 'api-key' } | undefined
  deepseekKeyPresent?: () => boolean
  compatConfigured?: () => boolean
  compatAccount?: () => { kind: 'api-key' | 'keyless' } | undefined
  huggingfaceAccount?: () => { kind: 'oauth' | 'api-key' } | undefined
  localServerPresent?: () => boolean
  openrouterKeyPresent?: () => boolean
  geminiAccount?: () => { kind: 'oauth' | 'api-key' } | undefined
  openaiLimitWindow?: () => { state: 'limited' | 'clear' }
  openrouterLimitWindow?: () => { state: 'limited' | 'clear' }
  geminiLimitWindow?: () => { state: 'limited' | 'clear' }
  huggingfaceLimitWindow?: () => { state: 'limited' | 'clear' }
  huggingfaceBillingState?: () => { state: 'credit-exhausted' | 'clear' }
  laneBillingState?: (
    lane: ProviderId,
  ) => { state: 'credit-exhausted'; detail: string; remedy: string } | { state: 'clear' }
}

function liveProviderUsabilityReads(): ProviderUsabilityReads {
  return {
    anthropicApiKey: () => {
      try {
        return getAnthropicApiKey()
      } catch {
        return null
      }
    },
    anthropicSubscriber: () => isClaudeAISubscriber(),
    anthropicBearerToken: () => {
      const { anthropicCredentialPresence } =
        require('./providerUsage.js') as typeof import('./providerUsage.js')
      return anthropicCredentialPresence({
        claudeSubscriber: () => false,
        anthropicApiKeyPresent: () => false,
      }).credentialed
    },
    anthropicLimitStatus: () => currentLimits.status,
    gptSeat: () => getGptSeatAvailability(),
    zaiKeyPresent: () => {
      const { resolveZaiApiKey } =
        require('../../utils/router/providerDiscovery.js') as typeof import('../../utils/router/providerDiscovery.js')
      return resolveZaiApiKey() !== undefined
    },
    moonshotAccount: () => {
      const { resolveMoonshotAccount } =
        require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
      return resolveMoonshotAccount()
    },
    deepseekKeyPresent: () => {
      const { resolveDeepseekApiKey } =
        require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
      return resolveDeepseekApiKey() !== undefined
    },
    compatConfigured: () => {
      const { resolveCompatSlotConfig } =
        require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
      return resolveCompatSlotConfig() !== undefined
    },
    compatAccount: () => {
      const { resolveCompatAccount } =
        require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
      return resolveCompatAccount()
    },
    huggingfaceAccount: () => {
      const { resolveHuggingfaceAccount } =
        require('./huggingface/huggingfaceAccounts.js') as typeof import('./huggingface/huggingfaceAccounts.js')
      return resolveHuggingfaceAccount()
    },
    localServerPresent: () => {
      const { resolveLocalAccount } =
        require('./local/localAccounts.js') as typeof import('./local/localAccounts.js')
      return resolveLocalAccount() !== undefined
    },
    openrouterKeyPresent: () => {
      const { resolveOpenrouterApiKey } =
        require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')
      return resolveOpenrouterApiKey() !== undefined
    },
    geminiAccount: () => {
      const { resolveGeminiAccount } =
        require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
      return resolveGeminiAccount()
    },
    openaiLimitWindow: () => {
      const { openaiLimitWindow } =
        require('./openai/openaiLimitState.js') as typeof import('./openai/openaiLimitState.js')
      const { resolveOpenaiAccount } =
        require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      const active = resolveOpenaiAccount()
      return active === undefined ? { state: 'clear' } : openaiLimitWindow(active.kind)
    },
    openrouterLimitWindow: () => {
      const { openrouterLimitWindow } =
        require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
      return openrouterLimitWindow()
    },
    geminiLimitWindow: () => {
      const { geminiLimitWindow } =
        require('./gemini/geminiUsageState.js') as typeof import('./gemini/geminiUsageState.js')
      return geminiLimitWindow()
    },
    huggingfaceLimitWindow: () => {
      const { huggingfaceLimitWindow } =
        require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
      return huggingfaceLimitWindow()
    },
    huggingfaceBillingState: () => {
      const { huggingfaceBillingState } =
        require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
      return huggingfaceBillingState()
    },
    laneBillingState: lane => {
      const { laneBillingState } =
        require('./laneBillingState.js') as typeof import('./laneBillingState.js')
      return laneBillingState(lane)
    },
  }
}

export function resolveProviderUsability(
  reads: ProviderUsabilityReads = liveProviderUsabilityReads(),
): Record<ProviderId, ProviderUsability> {
  const subscriber = reads.anthropicSubscriber()
  const key = reads.anthropicApiKey()
  const bearer = reads.anthropicBearerToken?.() ?? false
  const anthropicCredential: ProviderUsability['credential'] = subscriber
    ? 'oauth'
    : key
      ? 'api-key'
      : bearer
        ? 'oauth'
        : 'none'
  const limit = anthropicCredential === 'none' ? 'unknown' : reads.anthropicLimitStatus()
  const anthropicBlockers: string[] = []
  if (anthropicCredential === 'none') {
    anthropicBlockers.push('no Anthropic credential — /logins (or ANTHROPIC_API_KEY)')
  }
  if (limit === 'rejected') {
    anthropicBlockers.push('the Anthropic usage window is reached — resets per /usage')
  }
  const anthropic: ProviderUsability = {
    provider: 'anthropic',
    credential: anthropicCredential,
    limit,
    usable: anthropicBlockers.length === 0,
    blockers: anthropicBlockers,
    delegationCapped: limit === 'rejected',
  }

  const seat = reads.gptSeat()
  const openaiBlockers: string[] = []
  if (seat.state !== 'ready') openaiBlockers.push(seat.reason ?? 'GPT lane unavailable')
  const seatCredentialAbsent =
    seat.state !== 'ready' &&
    (seat.why === 'no-account' ||
      seat.why === 'auth-expired' ||
      (seat.why === undefined && (seat.reason ?? '').includes('no OpenAI account')))
  const openai: ProviderUsability = {
    provider: 'openai',
    credential: seatCredentialAbsent ? 'none' : 'oauth',
    limit: 'unknown',
    usable: seat.state === 'ready',
    blockers: openaiBlockers,
  }

  const zaiKey = reads.zaiKeyPresent()
  const zaiBlockers: string[] = []
  if (!zaiKey) zaiBlockers.push('no Z.AI API key — /logins zai (or ZAI_API_KEY)')
  const zai: ProviderUsability = {
    provider: 'zai',
    credential: zaiKey ? 'api-key' : 'none',
    limit: 'unknown',
    usable: zaiBlockers.length === 0,
    blockers: zaiBlockers,
  }

  const keyLane = (
    provider: ProviderId,
    present: boolean,
    blocker: string,
    credential: ProviderUsability['credential'] = 'api-key',
  ): ProviderUsability => ({
    provider,
    credential: present ? credential : 'none',
    limit: 'unknown',
    usable: present,
    blockers: present ? [] : [blocker],
  })
  const moonshotAccount = reads.moonshotAccount?.()
  const moonshot = keyLane(
    'moonshot',
    moonshotAccount !== undefined,
    'no Kimi sign-in or Moonshot API key — /logins moonshot (or MOONSHOT_API_KEY)',
    moonshotAccount?.kind === 'kimi-oauth' ? 'oauth' : 'api-key',
  )
  const deepseek = keyLane(
    'deepseek',
    reads.deepseekKeyPresent?.() ?? false,
    'no DeepSeek API key — /logins deepseek (or DEEPSEEK_API_KEY)',
  )
  const compatAccount = reads.compatAccount?.()
  const compat = keyLane(
    'openai-compat',
    compatAccount !== undefined || (reads.compatConfigured?.() ?? false),
    'no endpoint configured — MERCURY_COMPAT_BASE_URL',
    compatAccount?.kind === 'keyless' ? 'keyless' : 'api-key',
  )

  const huggingfaceAccount = reads.huggingfaceAccount?.()
  const huggingface = keyLane(
    'huggingface',
    huggingfaceAccount !== undefined,
    'no Hugging Face credential — /logins (or HF_TOKEN)',
    huggingfaceAccount?.kind === 'oauth' ? 'oauth' : 'api-key',
  )
  const local = keyLane(
    'local',
    reads.localServerPresent?.() ?? false,
    'no local server discovered — start Ollama/LM Studio/vLLM/llama.cpp-server or set MERCURY_LOCAL_BASE_URL',
    'keyless',
  )

  const openrouter = keyLane(
    'openrouter',
    reads.openrouterKeyPresent?.() ?? false,
    'no OpenRouter credential — /logins (or OPENROUTER_API_KEY)',
  )
  const geminiAccount = reads.geminiAccount?.()
  const gemini = keyLane(
    'gemini',
    geminiAccount !== undefined,
    'no Gemini credential — /logins (or GOOGLE_API_KEY / GEMINI_API_KEY)',
    geminiAccount?.kind === 'oauth' ? 'oauth' : 'api-key',
  )

  const applyObservedLimit = (
    lane: ProviderUsability,
    window: { state: 'limited' | 'clear' } | undefined,
  ): ProviderUsability => {
    if (window?.state !== 'limited' || lane.credential === 'none') return lane
    return {
      ...lane,
      limit: 'rejected',
      usable: false,
      blockers: [
        ...lane.blockers,
        `the ${lane.provider} usage window is reached — resets per /usage`,
      ],
    }
  }
  const applyObservedBilling = (
    lane: ProviderUsability,
    billing: { state: 'credit-exhausted' | 'clear' } | undefined,
  ): ProviderUsability => {
    if (billing?.state !== 'credit-exhausted' || lane.credential === 'none') return lane
    return {
      ...lane,
      usable: false,
      blockers: [
        ...lane.blockers,
        'Inference Providers credits exhausted (the wire refused with 402) — top up at huggingface.co/settings/billing; a successful turn clears this',
      ],
    }
  }

  const applyLaneBilling = (lane: ProviderUsability): ProviderUsability => {
    if (lane.provider === 'unrecognised') return lane
    const billing = reads.laneBillingState?.(lane.provider)
    if (billing?.state !== 'credit-exhausted' || lane.credential === 'none') return lane
    return {
      ...lane,
      usable: false,
      blockers: [
        ...lane.blockers,
        `the ${lane.provider} wire refused the last turn for billing (${billing.detail}) — ${billing.remedy} A successful turn clears this.`,
      ],
    }
  }

  return {
    anthropic,
    openai: applyLaneBilling(applyObservedLimit(openai, reads.openaiLimitWindow?.())),
    zai: applyLaneBilling(zai),
    moonshot: applyLaneBilling(moonshot),
    deepseek: applyLaneBilling(deepseek),
    'openai-compat': applyLaneBilling(compat),
    openrouter: applyLaneBilling(applyObservedLimit(openrouter, reads.openrouterLimitWindow?.())),
    gemini: applyLaneBilling(applyObservedLimit(gemini, reads.geminiLimitWindow?.())),
    huggingface: applyObservedBilling(
      applyObservedLimit(huggingface, reads.huggingfaceLimitWindow?.()),
      reads.huggingfaceBillingState?.(),
    ),
    local: applyLaneBilling(local),
  }
}

export function nonAnthropicBootNotice(
  map: Record<ProviderId, ProviderUsability> = resolveProviderUsability(),
): string | null {
  if (map.anthropic.credential !== 'none') return null
  const usable = (Object.values(map) as ProviderUsability[])
    .filter(lane => lane.provider !== 'anthropic' && lane.usable)
    .map(lane => providerDisplayName(lane.provider))
  if (usable.length === 0) return null
  return (
    `${usable.join(', ')} ${usable.length === 1 ? 'is' : 'are'} the working lane${usable.length === 1 ? '' : 's'}: ` +
    'tools, subagents and workflows run on the session\'s own family. ' +
    'No Anthropic credential — the Claude-account surfaces (the Anthropic usage windows) stay dormant; /logins adds one any time.'
  )
}

export function usabilityForRoute(
  route: ProviderId | 'unrecognised',
  reads?: ProviderUsabilityReads,
): ProviderUsability {
  if (route === 'unrecognised') {
    return {
      provider: 'unrecognised',
      credential: 'none',
      limit: 'unknown',
      usable: false,
      blockers: ['no provider family declares the target id — /model picks a listed row'],
    }
  }
  return resolveProviderUsability(reads)[route]
}

export function delegationDispatchBlocker(
  route: ProviderId,
  map: Record<ProviderId, ProviderUsability> = resolveProviderUsability(),
): string | null {
  const lane = map[route]
  const blocked =
    route === 'anthropic'
      ? lane.delegationCapped === true
      : lane.limit === 'rejected'
  if (!blocked) return null
  const usableAlternatives = (Object.values(map) as ProviderUsability[])
    .filter(p => p.provider !== route && p.usable)
    .map(p => p.provider)
  const why = lane.blockers.length > 0 ? lane.blockers.join('; ') : 'lane unavailable'
  const alternatives =
    usableAlternatives.length > 0
      ? ` Lanes with usage right now: ${usableAlternatives.join(', ')} — dispatch there by naming a model explicitly (the Agent model parameter).`
      : ' No other lane is usable right now — wait for the window to reset.'
  return (
    `the ${route} lane cannot take delegated work right now (${why}). ` +
    `Delegated agents are never silently rerouted across providers.` +
    alternatives
  )
}
