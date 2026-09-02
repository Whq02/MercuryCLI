import { scanAccountScopes } from '../../utils/accounts/scopeScan.js'
import { getAnthropicApiKeyWithSource, isClaudeAISubscriber } from '../../utils/auth.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiApiKey,
  subscriptionConnected,
} from '../providers/openai/openaiAccounts.js'
import {
  readMintedOpenrouterKey,
  resolveOpenrouterApiKey,
} from '../providers/openrouter/openrouterAccounts.js'
import {
  geminiOauthConnected,
  resolveGeminiAccount,
  resolveGeminiApiKey,
} from '../providers/gemini/geminiAccounts.js'
import { readStoredOpenrouterApiKey } from '../../utils/router/providerSecrets.js'
import { providerDisplayName } from '../providers/routeLaw.js'

export type WalletProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini'
export type WalletAuthKind = 'subscription-oauth' | 'oauth' | 'api-key'

export type WalletEntryId = string

export interface WalletEntry {
  id: WalletEntryId
  provider: WalletProvider
  kind: WalletAuthKind
  label: string
  identity?: { email?: string; accountId?: string; plan?: string }
  custodian:
    | 'anthropic-slots'
    | 'anthropic-auth'
    | 'openai-accounts'
    | 'openrouter-accounts'
    | 'gemini-accounts'
    | 'provider-secrets'
}

export function walletEntries(): WalletEntry[] {
  const entries: WalletEntry[] = []

  for (const scope of scanAccountScopes()) {
    if (scope.claudeFamily || !scope.authed) continue
    entries.push({
      id: `anthropic:oauth:${scope.name}`,
      provider: 'anthropic',
      kind: 'subscription-oauth',
      label: scope.email ? `Claude account (${scope.email})` : `Claude account (${scope.name})`,
      identity: {
        ...(scope.email ? { email: scope.email } : {}),
        ...(scope.uuid ? { accountId: scope.uuid } : {}),
      },
      custodian: 'anthropic-slots',
    })
  }

  try {
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if ((key !== null || source === 'apiKeyHelper') && source !== 'none' && !isClaudeAISubscriber()) {
      entries.push({
        id: `anthropic:api-key:${source === 'ANTHROPIC_API_KEY' ? 'env' : source === 'apiKeyHelper' ? 'helper' : 'managed'}`,
        provider: 'anthropic',
        kind: 'api-key',
        label: `Anthropic API key (${source})`,
        custodian: 'anthropic-auth',
      })
    }
  } catch {
  }

  if (subscriptionConnected()) {
    const armed = resolveOpenaiAccount()
    const accountId = armed?.kind === 'chatgpt-subscription' ? armed.accountId : undefined
    const plan = armed?.kind === 'chatgpt-subscription' ? armed.planType : undefined
    const email = armed?.kind === 'chatgpt-subscription' ? armed.email : undefined
    entries.push({
      id: `openai:oauth:${accountId ? accountId.slice(0, 8) : 'subscription'}`,
      provider: 'openai',
      kind: 'subscription-oauth',
      label: armed?.kind === 'chatgpt-subscription' ? armed.label : 'ChatGPT subscription',
      identity: {
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
        ...(plan ? { plan } : {}),
      },
      custodian: 'openai-accounts',
    })
  }
  const openaiKey = resolveOpenaiApiKey()
  if (openaiKey) {
    entries.push({
      id: `openai:api-key:${openaiKey.source}`,
      provider: 'openai',
      kind: 'api-key',
      label: `OpenAI API key (${openaiKey.source})`,
      custodian: openaiKey.source === 'env' ? 'openai-accounts' : 'provider-secrets',
    })
  }

  if (readMintedOpenrouterKey()) {
    entries.push({
      id: 'openrouter:oauth-key',
      provider: 'openrouter',
      kind: 'api-key',
      label: 'OpenRouter (OAuth-minted key)',
      custodian: 'openrouter-accounts',
    })
  }
  {
    const envKey = process.env.OPENROUTER_API_KEY?.trim()
    const storedKey = readStoredOpenrouterApiKey()
    if (envKey || storedKey) {
      entries.push({
        id: `openrouter:api-key:${envKey ? 'env' : 'stored'}`,
        provider: 'openrouter',
        kind: 'api-key',
        label: envKey ? 'OpenRouter API key (env)' : 'OpenRouter API key (stored)',
        custodian: envKey ? 'openrouter-accounts' : 'provider-secrets',
      })
    }
  }

  if (geminiOauthConnected()) {
    entries.push({
      id: 'gemini:oauth',
      provider: 'gemini',
      kind: 'oauth',
      label: 'Google account (OAuth)',
      custodian: 'gemini-accounts',
    })
  }
  {
    const geminiKey = resolveGeminiApiKey()
    if (geminiKey) {
      entries.push({
        id: `gemini:api-key:${geminiKey.source}`,
        provider: 'gemini',
        kind: 'api-key',
        label:
          geminiKey.source === 'env-google'
            ? 'Gemini API key (GOOGLE_API_KEY env)'
            : geminiKey.source === 'env-gemini'
              ? 'Gemini API key (GEMINI_API_KEY env)'
              : 'Gemini API key (stored)',
        custodian: geminiKey.source === 'stored' ? 'provider-secrets' : 'gemini-accounts',
      })
    }
  }

  return entries
}

export type NotLoggedInGate =
  | { state: 'ok' }
  | { state: 'not-logged-in' }
  | { state: 'provider-missing'; missingProvider: string; steering: string }

export function notLoggedInGateDecision(
  entries: readonly WalletEntry[],
  route: string | null,
): NotLoggedInGate {
  if (route !== 'anthropic' && route !== 'openai') return { state: 'ok' }
  const openaiConnected = entries.some(e => e.provider === 'openai')
  const anthropicConnected = entries.some(e => e.provider === 'anthropic')
  const sessionProviderConnected = route === 'openai' ? openaiConnected : anthropicConnected
  if (sessionProviderConnected) return { state: 'ok' }
  if (entries.length === 0) return { state: 'not-logged-in' }
  const missingProvider = providerDisplayName(route)
  const { familyRouteWords } =
    require('../providers/accountSlots.js') as typeof import('../providers/accountSlots.js')
  return {
    state: 'provider-missing',
    missingProvider,
    steering: `No ${missingProvider} account for the current model · /model switches to a connected provider · ${familyRouteWords(route)} adds one`,
  }
}

export function activeWalletEntry(provider: WalletProvider): WalletEntry | undefined {
  const entries = walletEntries()
  if (provider === 'openrouter') {
    const active = resolveOpenrouterApiKey()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'openrouter' &&
        (active.source === 'oauth' ? e.id === 'openrouter:oauth-key' : e.id.startsWith('openrouter:api-key')),
    )
  }
  if (provider === 'gemini') {
    const active = resolveGeminiAccount()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'gemini' &&
        (active.kind === 'oauth' ? e.kind === 'oauth' : e.kind === 'api-key'),
    )
  }
  if (provider === 'openai') {
    const active = resolveOpenaiAccount()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'openai' &&
        (active.kind === 'chatgpt-subscription'
          ? e.kind === 'subscription-oauth'
          : e.kind === 'api-key'),
    )
  }
  const scopes = scanAccountScopes()
  const current = scopes.find(s => s.isCurrent && s.authed && !s.claudeFamily)
  if (current) {
    return entries.find(e => e.id === `anthropic:oauth:${current.name}`)
  }
  return entries.find(e => e.provider === 'anthropic' && e.kind === 'api-key')
}
