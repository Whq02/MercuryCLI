import { scanAccountScopes } from '../../utils/accounts/scopeScan.js'
import { getAnthropicApiKeyWithSource, getClaudeAIOAuthTokens, isClaudeAISubscriber } from '../../utils/auth.js'
import {
  openaiSubscriptionRef,
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
import {
  kimiRegionLabel,
  moonshotLoginRegion,
  moonshotStoredTokens,
  resolveMoonshotAccount,
  resolveMoonshotApiKey,
} from '../providers/moonshot/moonshotAccounts.js'
import {
  huggingfaceOauthIdentity,
  huggingfaceStoredTokens,
  resolveHuggingfaceApiKey,
} from '../providers/huggingface/huggingfaceAccounts.js'
import { maskedKeyTail } from '../providers/credentialIdentity.js'
import { kimiHostWords } from './identityWords.js'
import {
  credentialEnvNames,
  readStoredHuggingfaceApiKey,
  readStoredOpenrouterApiKey,
} from '../../utils/router/providerSecrets.js'
import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'
import { providerDisplayName } from '../providers/routeLaw.js'

export type WalletProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'moonshot' | 'huggingface'

export type WalletIdentitySource = 'profile' | 'receipt'

export type WalletAuthKind = 'subscription-oauth' | 'oauth' | 'api-key'

export type WalletEntryId = string

export interface WalletEntry {
  id: WalletEntryId
  provider: WalletProvider
  kind: WalletAuthKind
  label: string
  identity?: { email?: string; name?: string; accountId?: string; plan?: string; source?: WalletIdentitySource }
  keyTail?: string
  host?: string
  custodian:
    | 'anthropic-slots'
    | 'anthropic-auth'
    | 'openai-accounts'
    | 'openrouter-accounts'
    | 'gemini-accounts'
    | 'moonshot-accounts'
    | 'huggingface-accounts'
    | 'provider-secrets'
}

function anthropicCredentialAccount(): { email: string; uuid?: string; source: WalletIdentitySource } | undefined {
  try {
    const tokens = getClaudeAIOAuthTokens()
    const profile = tokens?.profile?.account
    const profileEmail = profile?.email?.trim() ?? ''
    if (profile !== undefined && profileEmail !== '') {
      return { email: profileEmail, ...(profile.uuid ? { uuid: profile.uuid } : {}), source: 'profile' }
    }
    const receipt = tokens?.tokenAccount
    const receiptEmail = receipt?.emailAddress?.trim() ?? ''
    if (receipt !== undefined && receiptEmail !== '') {
      return { email: receiptEmail, ...(receipt.uuid ? { uuid: receipt.uuid } : {}), source: 'receipt' }
    }
  } catch {
    return undefined
  }
  return undefined
}

function recordedAccountSource(email: string): WalletIdentitySource | undefined {
  const typed = process.env.MERCURY_USER_EMAIL?.trim().toLowerCase()
  return typed !== undefined && typed !== '' && typed === email.trim().toLowerCase() ? undefined : 'profile'
}

const ENTRIES_TTL_MS = 5_000
let entriesMemo: { at: number; key: string; entries: WalletEntry[] } | null = null

function entriesKey(): string {
  let env = ''
  for (const name of credentialEnvNames()) env += `${name}=${process.env[name] ?? ''}\u0000`
  return `${signInLedgerEpoch()}:${env}`
}

export function resetWalletEntriesMemo(): void {
  entriesMemo = null
  activeMemo.clear()
}

export function walletEntries(): WalletEntry[] {
  const key = entriesKey()
  const now = Date.now()
  if (entriesMemo !== null && entriesMemo.key === key && now - entriesMemo.at < ENTRIES_TTL_MS) return entriesMemo.entries
  const entries = composeWalletEntries()
  entriesMemo = { at: now, key, entries }
  return entries
}

function composeWalletEntries(): WalletEntry[] {
  const entries: WalletEntry[] = []

  for (const scope of scanAccountScopes()) {
    if (scope.foreignHarness || !scope.authed) continue
    const own = scope.isCurrent ? anthropicCredentialAccount() : undefined
    const email = own !== undefined ? own.email : scope.email
    const uuid = own?.uuid ?? scope.uuid
    const source = own !== undefined ? own.source : scope.email !== undefined ? recordedAccountSource(scope.email) : undefined
    entries.push({
      id: `anthropic:oauth:${scope.name}`,
      provider: 'anthropic',
      kind: 'subscription-oauth',
      label: email ? `Claude account (${email})` : `Claude account (${scope.name})`,
      identity: {
        ...(email ? { email } : {}),
        ...(uuid ? { accountId: uuid } : {}),
        ...(email && source !== undefined ? { source } : {}),
      },
      custodian: 'anthropic-slots',
    })
  }

  try {
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if ((key !== null || source === 'apiKeyHelper') && source !== 'none' && !isClaudeAISubscriber()) {
      const keyTail = maskedKeyTail(key ?? undefined)
      entries.push({
        id: `anthropic:api-key:${source === 'ANTHROPIC_API_KEY' ? 'env' : source === 'apiKeyHelper' ? 'helper' : 'managed'}`,
        provider: 'anthropic',
        kind: 'api-key',
        label: `Anthropic API key (${source})`,
        ...(keyTail !== '' ? { keyTail } : {}),
        custodian: 'anthropic-auth',
      })
    }
  } catch {
  }

  if (subscriptionConnected()) {
    const subscription = openaiSubscriptionRef()
    const accountId = subscription?.accountId
    const plan = subscription?.planType
    const email = subscription?.email
    entries.push({
      id: `openai:oauth:${accountId ? accountId.slice(0, 8) : 'subscription'}`,
      provider: 'openai',
      kind: 'subscription-oauth',
      label: subscription?.label ?? 'ChatGPT subscription',
      identity: {
        ...(email ? { email, source: 'receipt' as const } : {}),
        ...(accountId ? { accountId } : {}),
        ...(plan ? { plan } : {}),
      },
      custodian: 'openai-accounts',
    })
  }
  const openaiKey = resolveOpenaiApiKey()
  if (openaiKey) {
    const keyTail = maskedKeyTail(openaiKey.key)
    entries.push({
      id: `openai:api-key:${openaiKey.source}`,
      provider: 'openai',
      kind: 'api-key',
      label: `OpenAI API key (${openaiKey.source})`,
      ...(keyTail !== '' ? { keyTail } : {}),
      custodian: openaiKey.source === 'env' ? 'openai-accounts' : 'provider-secrets',
    })
  }

  const minted = readMintedOpenrouterKey()
  if (minted) {
    const keyTail = maskedKeyTail(minted.key)
    entries.push({
      id: 'openrouter:oauth-key',
      provider: 'openrouter',
      kind: 'api-key',
      label: 'OpenRouter (OAuth-minted key)',
      ...(keyTail !== '' ? { keyTail } : {}),
      custodian: 'openrouter-accounts',
    })
  }
  {
    const envKey = process.env.OPENROUTER_API_KEY?.trim()
    const storedKey = readStoredOpenrouterApiKey()
    if (envKey || storedKey) {
      const keyTail = maskedKeyTail(envKey || storedKey)
      entries.push({
        id: `openrouter:api-key:${envKey ? 'env' : 'stored'}`,
        provider: 'openrouter',
        kind: 'api-key',
        label: envKey ? 'OpenRouter API key (env)' : 'OpenRouter API key (stored)',
        ...(keyTail !== '' ? { keyTail } : {}),
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
      const keyTail = maskedKeyTail(geminiKey.key)
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
        ...(keyTail !== '' ? { keyTail } : {}),
        custodian: geminiKey.source === 'stored' ? 'provider-secrets' : 'gemini-accounts',
      })
    }
  }

  if (moonshotStoredTokens()) {
    const region = moonshotLoginRegion()
    entries.push({
      id: 'moonshot:oauth',
      provider: 'moonshot',
      kind: 'oauth',
      label: `Kimi account (device-code sign-in · ${kimiRegionLabel(region)})`,
      host: kimiHostWords(region),
      custodian: 'moonshot-accounts',
    })
  }
  {
    const moonshotKey = resolveMoonshotApiKey()
    if (moonshotKey) {
      const keyTail = maskedKeyTail(moonshotKey.key)
      entries.push({
        id: `moonshot:api-key:${moonshotKey.source}`,
        provider: 'moonshot',
        kind: 'api-key',
        label: moonshotKey.source === 'env' ? 'MOONSHOT_API_KEY (env)' : 'Moonshot API key (stored, auth-scoped)',
        ...(keyTail !== '' ? { keyTail } : {}),
        custodian: moonshotKey.source === 'env' ? 'moonshot-accounts' : 'provider-secrets',
      })
    }
  }

  if (huggingfaceStoredTokens()) {
    const identity = huggingfaceOauthIdentity()
    const username = identity?.username?.trim()
    entries.push({
      id: 'huggingface:oauth',
      provider: 'huggingface',
      kind: 'oauth',
      label: username ? `Hugging Face account (${username})` : 'Hugging Face account (OAuth device flow)',
      identity: username ? { name: username, source: 'profile' } : {},
      custodian: 'huggingface-accounts',
    })
  }
  {
    const envKey = process.env.HF_TOKEN?.trim()
    const storedKey = readStoredHuggingfaceApiKey()
    if (envKey || storedKey) {
      const keyTail = maskedKeyTail(envKey || storedKey)
      entries.push({
        id: `huggingface:api-key:${envKey ? 'env' : 'stored'}`,
        provider: 'huggingface',
        kind: 'api-key',
        label: envKey ? 'HF_TOKEN (env)' : 'Hugging Face token (stored, auth-scoped)',
        ...(keyTail !== '' ? { keyTail } : {}),
        custodian: envKey ? 'huggingface-accounts' : 'provider-secrets',
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
  const key = entriesKey()
  const now = Date.now()
  const hit = activeMemo.get(provider)
  if (hit !== undefined && hit.key === key && now - hit.at < ENTRIES_TTL_MS) return hit.entry
  const entry = composeActiveWalletEntry(provider)
  activeMemo.set(provider, { at: now, key, entry })
  return entry
}

const activeMemo = new Map<WalletProvider, { at: number; key: string; entry: WalletEntry | undefined }>()

function composeActiveWalletEntry(provider: WalletProvider): WalletEntry | undefined {
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
  if (provider === 'moonshot') {
    const active = resolveMoonshotAccount()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'moonshot' &&
        (active.kind === 'kimi-oauth' ? e.kind === 'oauth' : e.id === `moonshot:api-key:${active.keySource}`),
    )
  }
  if (provider === 'huggingface') {
    const active = resolveHuggingfaceApiKey()
    if (!active) return undefined
    return entries.find(
      e =>
        e.provider === 'huggingface' &&
        (active.source === 'oauth' ? e.kind === 'oauth' : e.id === `huggingface:api-key:${active.source}`),
    )
  }
  const scopes = scanAccountScopes()
  const current = scopes.find(s => s.isCurrent && s.authed && !s.foreignHarness)
  if (current) {
    return entries.find(e => e.id === `anthropic:oauth:${current.name}`)
  }
  return entries.find(e => e.provider === 'anthropic' && e.kind === 'api-key')
}
