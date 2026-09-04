import { providerDisplayName, declaredRouteOf, type CallModelRoute } from './routeLaw.js'
import { PROVIDER_CREDENTIAL_ENV_VARS } from './credentialEnvSpellings.js'
import {
  clearScopeIdentitySnapshot,
  forgetScopeIdentity,
  type ScopeIdentityState,
} from '../../utils/accounts/accountIdentity.js'
import { noteCredentialChange } from '../../utils/accounts/signInLedger.js'
import {
  dropCredentialMemos,
  getAnthropicApiKeyWithSource,
  isClaudeAISubscriber,
  removeApiKey,
  type ApiKeySource,
} from '../../utils/auth.js'
import { revokeOAuthToken } from '../oauth/client.js'
import { getSecureStorage, removeSecureStorageField } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig } from '../../utils/config/globalConfig.js'
import { resetUserCache } from '../../utils/user.js'
import { logError } from '../../utils/log.js'
import {
  scanAccountScopes,
  type AccountScope,
} from '../../utils/accounts/scopeScan.js'
import {
  readStoredGeminiApiKey,
  readStoredOpenrouterApiKey,
  readStoredZaiApiKey,
  readStoredZaiKeyPlan,
  writeStoredGeminiApiKey,
  readStoredCompatApiKey,
  readStoredDeepseekApiKey,
  readStoredHuggingfaceApiKey,
  readStoredLocalApiKey,
  readStoredMoonshotApiKey,
  writeStoredCompatApiKey,
  writeStoredDeepseekApiKey,
  writeStoredHuggingfaceApiKey,
  writeStoredLocalApiKey,
  writeStoredMoonshotApiKey,
  writeStoredOpenaiApiKey,
  writeStoredOpenrouterApiKey,
  writeStoredZaiApiKey,
} from '../../utils/router/providerSecrets.js'
import {
  disconnectOpenrouterOauthKey,
  readMintedOpenrouterKey,
} from './openrouter/openrouterAccounts.js'
import {
  disconnectGeminiOauth,
  geminiOauthConnected,
  resolveGeminiAccount,
  type GeminiAccountRef,
} from './gemini/geminiAccounts.js'
import {
  disconnectMoonshotOauth,
  kimiRegionLabel,
  moonshotLoginRegion,
  moonshotStoredTokens,
  type KimiRegion,
} from './moonshot/moonshotAccounts.js'
import {
  disconnectHuggingfaceOauth,
  huggingfaceOauthIdentity,
  huggingfaceStoredTokenIdentity,
  huggingfaceStoredTokens,
  type HuggingfaceIdentity,
} from './huggingface/huggingfaceAccounts.js'
import { resolveLocalAccount, type LocalAccountRef } from './local/localAccounts.js'
import {
  buildRouterModelSnapshot,
  type RouterModelSnapshot,
} from '../../utils/router/modelRegistry.js'
import {
  disconnectOpenaiSubscription,
  openaiSubscriptionPresence,
  openaiSubscriptionRef,
  resolveOpenaiAccount,
  resolveOpenaiApiKey,
  type OpenaiAccountRef,
} from './openai/openaiAccounts.js'
import {
  presenceIdentityWords,
  providerFamilyPresences,
  type ProviderFamilyPresence,
  type ProviderFamilyReads,
} from './providerUsage.js'

export type AccountSlotKind = 'oauth' | 'subscription' | 'api-key'

export type SlotRemoval =
  | { route: 'anthropic-oauth'; dir: string }
  | { route: 'anthropic-managed-key' }
  | { route: 'openai-subscription' }
  | { route: 'openai-stored-key' }
  | { route: 'zai-stored-key' }
  | { route: 'openrouter-oauth-key' }
  | { route: 'openrouter-stored-key' }
  | { route: 'gemini-oauth' }
  | { route: 'gemini-stored-key' }
  | { route: 'moonshot-stored-key' }
  | { route: 'moonshot-oauth' }
  | { route: 'deepseek-stored-key' }
  | { route: 'compat-stored-key' }
  | { route: 'huggingface-oauth' }
  | { route: 'huggingface-stored-key' }
  | { route: 'local-stored-key' }
  | { route: 'env'; envVar: string }
  | { route: 'settings'; note: string }
  | { route: 'owner'; note: string }
  | { route: 'excluded'; note: string }

export interface AccountSlot {
  family: string
  id: string
  name: string
  kind: AccountSlotKind
  kindLabel: string
  identity: string
  active: boolean
  envPinned: boolean
  signedIn: boolean
  scope?: AccountScope
  stateNote?: string
  removal: SlotRemoval
}

export interface FamilySlotGroup {
  family: ProviderFamilyPresence
  slots: AccountSlot[]
}

export interface AccountSlotReads {
  familyReads?: ProviderFamilyReads
  scanScopes?: () => AccountScope[]
  anthropicApiKey?: () => { key: string | null; source: ApiKeySource }
  openaiSubscription?: () => OpenaiAccountRef | undefined
  openaiSubscriptionPresence?: () => { state: 'connected' | 'expired' | 'absent'; email?: string; planType?: string }
  openaiActiveAccount?: () => OpenaiAccountRef | undefined
  openaiApiKey?: () => { key: string; source: 'env' | 'stored' } | undefined
  zaiEnvKey?: () => string | undefined
  zaiStoredKey?: () => string | undefined
  zaiStoredKeyPlan?: () => 'coding' | undefined
  openrouterEnvKey?: () => string | undefined
  openrouterMintedKey?: () => { key: string; mintedAtMs: number } | undefined
  openrouterStoredKey?: () => string | undefined
  geminiOauthConnected?: () => boolean
  geminiActiveAccount?: () => GeminiAccountRef | undefined
  geminiEnvGoogleKey?: () => string | undefined
  geminiEnvGeminiKey?: () => string | undefined
  geminiStoredKey?: () => string | undefined
  moonshotEnvKey?: () => string | undefined
  moonshotStoredKey?: () => string | undefined
  moonshotOauth?: () =>
    | { accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number }
    | undefined
  moonshotOauthRegion?: () => KimiRegion
  deepseekEnvKey?: () => string | undefined
  deepseekStoredKey?: () => string | undefined
  compatEnvKey?: () => string | undefined
  compatStoredKey?: () => string | undefined
  huggingfaceEnvKey?: () => string | undefined
  huggingfaceOauth?: () =>
    | { accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number }
    | undefined
  huggingfaceOauthIdentity?: () => HuggingfaceIdentity | undefined
  huggingfaceStoredKey?: () => string | undefined
  huggingfaceStoredKeyIdentity?: (key: string | undefined) => HuggingfaceIdentity | undefined
  localEnvKey?: () => string | undefined
  localStoredKey?: () => string | undefined
  localAccount?: () => LocalAccountRef | undefined
}

export function maskedKeyTail(key: string | undefined): string {
  const trimmed = key?.trim() ?? ''
  return trimmed.length >= 10 ? `…${trimmed.slice(-4)}` : ''
}

export function familyDisplayName(id: string): string {
  return providerDisplayName(id)
}


const FAMILY_SIGNIN_CEILINGS: Readonly<Record<string, number>> = {
  anthropic: 2,
  openai: 2,
}

export function familySigninCeiling(family: string): number | undefined {
  return FAMILY_SIGNIN_CEILINGS[family]
}


export type SlotIdentityRead = ScopeIdentityState | { state: 'checking' }
export type SlotIdentities = Readonly<Record<string, SlotIdentityRead | undefined>>

export type SlotSigninBasis =
  | 'verified-live'
  | 'credential-present'
  | 'checking'
  | 'expired'
  | 'signed-out'
  | 'unverified'
  | 'excluded'
  | 'absent'

export type SlotSigninState =
  | { signedIn: true; basis: 'verified-live' | 'credential-present' }
  | { signedIn: false; basis: Exclude<SlotSigninBasis, 'verified-live' | 'credential-present'> }

export function slotSigninState(slot: AccountSlot, identities: SlotIdentities): SlotSigninState {
  if (slot.scope === undefined) {
    return slot.signedIn
      ? { signedIn: true, basis: 'credential-present' }
      : { signedIn: false, basis: 'absent' }
  }
  if (slot.scope.claudeFamily) return { signedIn: false, basis: 'excluded' }
  if (!slot.signedIn) return { signedIn: false, basis: 'signed-out' }
  const identity = identities[slot.id]
  switch (identity?.state) {
    case 'verified':
      return { signedIn: true, basis: 'verified-live' }
    case 'expired':
      return { signedIn: false, basis: 'expired' }
    case 'signed-out':
      return { signedIn: false, basis: 'signed-out' }
    case 'unverified':
      return { signedIn: false, basis: 'unverified' }
    default:
      return { signedIn: false, basis: 'checking' }
  }
}

export function scopeSlotTail(
  state: SlotSigninState,
  read: SlotIdentityRead | undefined,
  slot: Pick<AccountSlot, 'scope' | 'family'>,
): string {
  const snapshot = slot.scope?.email
  switch (state.basis) {
    case 'excluded':
      return "another tool's credential scope — never billable from Mercury"
    case 'checking':
      return `${snapshot !== undefined ? `snapshot ${snapshot} · ` : ''}verifying identity…`
    case 'verified-live':
      return `${read?.state === 'verified' ? read.email : 'signed in'} · verified live · ↵ opens Logins to re-login · ⌫ signs out`
    case 'expired':
      return `expired${read?.state === 'expired' && read.snapshotEmail ? ` (snapshot ${read.snapshotEmail})` : ''} · not signed in · ↵ opens Logins to reauth`
    case 'signed-out':
      return snapshot !== undefined
        ? `snapshot ${snapshot} — signed out · ↵ opens Logins to re-login · ⌫ clears the snapshot`
        : familyAbsentWords(slot.family)
    case 'absent':
      return familyAbsentWords(slot.family)
    case 'unverified':
      return read?.state === 'unverified'
        ? `unverified — ${read.note}${read.email ? ` · snapshot ${read.email}` : ''} · not counted as signed in`
        : 'unverified · not counted as signed in'
    case 'credential-present':
      return 'credential present'
  }
}


export function familyRouteWords(family: string): string {
  if (family === 'local') return 'Ollama · LM Studio · vLLM · llama.cpp, or MERCURY_LOCAL_BASE_URL'
  const { subModelConnectHome } =
    require('../../utils/model/subModelSlots.js') as typeof import('../../utils/model/subModelSlots.js')
  const home = subModelConnectHome(family)
  if (home.command === undefined) return home.note
  const envKey = (PROVIDER_CREDENTIAL_ENV_VARS as Partial<Record<string, readonly string[]>>)[family]?.[0]
  return envKey !== undefined ? `${home.command} or ${envKey}` : home.command
}

export function familyAbsentWords(family: string): string {
  const state = family === 'local' ? 'no server discovered' : 'not signed in'
  return `${state} · ↵ names the route — ${familyRouteWords(family)}`
}

export interface FamilySigninSummary {
  signedIn: number
  held: number
  checking: number
  unverified: number
}

export function familySigninSummary(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): FamilySigninSummary {
  const summary: FamilySigninSummary = { signedIn: 0, held: 0, checking: 0, unverified: 0 }
  for (const slot of slots) {
    const state = slotSigninState(slot, identities)
    if (state.signedIn) {
      summary.signedIn += 1
      if (!slot.envPinned) summary.held += 1
    } else if (state.basis === 'checking') {
      summary.checking += 1
    } else if (state.basis === 'unverified') {
      summary.unverified += 1
    }
  }
  return summary
}

export function familySigninCount(
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): number {
  return familySigninSummary(slots, identities).held
}

export function familySigninHeaderNote(
  family: string,
  slots: readonly AccountSlot[],
  identities: SlotIdentities,
): string {
  const ceiling = familySigninCeiling(family)
  if (ceiling === undefined) return ''
  const summary = familySigninSummary(slots, identities)
  const parts = [`${summary.held}/${ceiling} signed in`]
  if (summary.checking > 0) parts.push('verifying…')
  if (summary.unverified > 0) {
    parts.push(`${summary.unverified} unverified (offline)`)
  }
  return ` · ${parts.join(' · ')}`
}


export type MainLoopIdentityBasis =
  | 'verified-live'
  | 'credential-present'
  | 'discovered-live'
  | 'checking'
  | 'expired'
  | 'unverified'
  | 'not-signed-in'
  | 'excluded'

export interface MainLoopIdentity {
  route: CallModelRoute | 'unrecognised'
  family: string
  text: string
  basis: MainLoopIdentityBasis
}

export interface MainLoopIdentityInput {
  model: string
  presences: readonly ProviderFamilyPresence[]
  currentScopeIdentity?: SlotIdentityRead | undefined
  currentScopeClaudeFamily?: boolean
}

function connectHomeWords(route: CallModelRoute | string): string {
  const { subModelConnectHome } =
    require('../../utils/model/subModelSlots.js') as typeof import('../../utils/model/subModelSlots.js')
  const home = subModelConnectHome(route)
  return home.command ?? home.note
}

export function mainLoopIdentity(input: MainLoopIdentityInput): MainLoopIdentity {
  const route = declaredRouteOf(input.model) ?? 'unrecognised'
  const family = familyDisplayName(route)
  const presence = input.presences.find(candidate => (candidate.id as string) === route)
  const notSignedIn = (): MainLoopIdentity => ({
    route,
    family,
    text: `not signed in — ${connectHomeWords(route)}`,
    basis: 'not-signed-in',
  })
  if (presence === undefined || !presence.credentialed) return notSignedIn()
  const label = presence.credentialLabel ?? 'credential present'
  if (route !== 'anthropic') {
    const words = presenceIdentityWords(presence) ?? label
    return route === 'local'
      ? { route, family, text: `${words} · discovered live`, basis: 'discovered-live' }
      : { route, family, text: `${words} · credential present`, basis: 'credential-present' }
  }
  if (!label.startsWith('Claude subscription')) {
    return { route, family, text: `${label} · credential present`, basis: 'credential-present' }
  }
  if (input.currentScopeClaudeFamily) {
    return {
      route,
      family,
      text: "another tool's credential scope — never billable from Mercury",
      basis: 'excluded',
    }
  }
  const identity = input.currentScopeIdentity
  switch (identity?.state) {
    case 'verified':
      return { route, family, text: `${identity.email} · verified live`, basis: 'verified-live' }
    case 'expired':
      return {
        route,
        family,
        text: `not signed in — credential expired${identity.snapshotEmail ? ` (snapshot ${identity.snapshotEmail})` : ''} · ↵ on the Anthropic slot reauths`,
        basis: 'expired',
      }
    case 'signed-out':
      return notSignedIn()
    case 'unverified':
      return {
        route,
        family,
        text: `${label} · unverified — ${identity.note}${identity.email ? ` · snapshot ${identity.email}` : ''}`,
        basis: 'unverified',
      }
    default: {
      const snapshot = presence.identity
      return {
        route,
        family,
        text: `${label}${snapshot !== undefined ? ` · snapshot ${snapshot}` : ''} · verifying identity…`,
        basis: 'checking',
      }
    }
  }
}

export interface SigninCeilingRefusal {
  refused: true
  family: string
  ceiling: number
  current: number
  message: string
}
export function signinCeilingRefusal(
  family: string,
  currentSignins: number,
): SigninCeilingRefusal | undefined {
  const ceiling = familySigninCeiling(family)
  if (ceiling === undefined || currentSignins < ceiling) return undefined
  return {
    refused: true,
    family,
    ceiling,
    current: currentSignins,
    message: `${familyDisplayName(family)} is at its sign-in ceiling (${currentSignins}/${ceiling} concurrent) — sign out of one slot first (⌫ on /accounts); re-login of an existing slot is always allowed`,
  }
}

const label = (parts: (string | undefined)[]): string => parts.filter(Boolean).join(' ')

function readAnthropicApiKey(): { key: string | null; source: ApiKeySource } {
  try {
    return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
  } catch {
    return { key: null, source: 'none' }
  }
}

function anthropicSlots(reads: AccountSlotReads): AccountSlot[] {
  const scopes = (reads.scanScopes ?? scanAccountScopes)()
  const subscriberSeat = reads.familyReads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const slots: AccountSlot[] = scopes
    .filter(scope => scope.authed || scope.email !== undefined || scope.uuid !== undefined || scope.claudeFamily)
    .map(scope => ({
      family: 'anthropic',
      id: scope.dir,
      name: 'claude',
      kind: 'oauth' as const,
      kindLabel: 'OAuth',
      identity: scope.claudeFamily
        ? "another tool's credential scope"
        : (scope.email ?? (scope.authed ? 'signed in' : 'not signed in')),
      active: scope.claudeFamily ? scope.isCurrent : scope.isCurrent && subscriberSeat,
      envPinned: false,
      signedIn: scope.authed,
      scope,
      removal: scope.claudeFamily
        ? {
            route: 'excluded' as const,
            note: "another tool's credential scope is not a Mercury slot — nothing to remove here",
          }
        : { route: 'anthropic-oauth' as const, dir: scope.dir },
    }))
  const apiKey = reads.anthropicApiKey ? reads.anthropicApiKey() : readAnthropicApiKey()
  if (apiKey.key !== null || apiKey.source === 'apiKeyHelper') {
    const subscriber = subscriberSeat
    const env = apiKey.source === 'ANTHROPIC_API_KEY'
    const helper = apiKey.source === 'apiKeyHelper'
    slots.push({
      family: 'anthropic',
      id: 'anthropic:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : helper ? 'API key · helper' : 'API key',
      identity: label([
        env ? 'ANTHROPIC_API_KEY (env)' : helper ? 'apiKeyHelper (settings)' : apiKey.source,
        maskedKeyTail(apiKey.key ?? undefined),
      ]),
      active: !subscriber,
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'ANTHROPIC_API_KEY' }
        : helper
          ? {
              route: 'settings',
              note: 'the apiKeyHelper setting owns this key — remove the helper from settings to remove it',
            }
          : { route: 'anthropic-managed-key' },
    })
  }
  return slots
}

function openaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const subscription = (reads.openaiSubscription ?? openaiSubscriptionRef)()
  const key = (reads.openaiApiKey ?? resolveOpenaiApiKey)()
  const active = (reads.openaiActiveAccount ?? resolveOpenaiAccount)()
  const slots: AccountSlot[] = []
  if (subscription === undefined) {
    const presence = (reads.openaiSubscriptionPresence ?? openaiSubscriptionPresence)()
    if (presence.state === 'expired') {
      slots.push({
        family: 'openai',
        id: 'openai:subscription',
        name: 'chatgpt',
        kind: 'subscription',
        kindLabel: presence.planType ? `${presence.planType} subscription` : 'subscription',
        identity: presence.email ?? 'ChatGPT sign-in',
        active: false,
        envPinned: false,
        signedIn: false,
        stateNote: 'sign-in expired — /logins openai signs in again',
        removal: { route: 'openai-subscription' },
      })
    }
  }
  if (subscription) {
    slots.push({
      family: 'openai',
      id: 'openai:subscription',
      name: 'chatgpt',
      kind: 'subscription',
      kindLabel: subscription.planType
        ? `${subscription.planType} subscription`
        : 'subscription',
      identity: subscription.email ?? subscription.label,
      active: active?.kind === 'chatgpt-subscription',
      envPinned: false,
      signedIn: true,
      removal: { route: 'openai-subscription' },
    })
  }
  if (key) {
    const env = key.source === 'env'
    slots.push({
      family: 'openai',
      id: 'openai:api-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: env ? 'API key · env' : 'API key',
      identity: label([
        env ? 'OPENAI_API_KEY (env)' : 'stored key (auth-scoped)',
        maskedKeyTail(key.key),
      ]),
      active: active?.kind === 'api-key',
      envPinned: env,
      signedIn: true,
      removal: env
        ? { route: 'env', envVar: 'OPENAI_API_KEY' }
        : { route: 'openai-stored-key' },
    })
  }
  return slots
}

function zaiSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.zaiEnvKey ? reads.zaiEnvKey() : process.env.ZAI_API_KEY?.trim() || undefined
  const storedKey = (reads.zaiStoredKey ?? readStoredZaiApiKey)()
  const storedPlan = (reads.zaiStoredKeyPlan ?? readStoredZaiKeyPlan)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'zai',
      id: 'zai:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['ZAI_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'ZAI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'zai',
      id: 'zai:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: storedPlan === 'coding' ? 'Coding Plan key' : 'API key',
      identity: label([
        storedPlan === 'coding' ? 'GLM Coding Plan key (auth-scoped)' : 'stored key (auth-scoped)',
        maskedKeyTail(storedKey),
      ]),
      active: !envKey,
      envPinned: false,
      signedIn: true,
      ...(envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: { route: 'zai-stored-key' },
    })
  }
  return slots
}

function openrouterSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey = reads.openrouterEnvKey
    ? reads.openrouterEnvKey()
    : process.env.OPENROUTER_API_KEY?.trim() || undefined
  const minted = (reads.openrouterMintedKey ?? readMintedOpenrouterKey)()
  const storedKey = (reads.openrouterStoredKey ?? readStoredOpenrouterApiKey)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['OPENROUTER_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'OPENROUTER_API_KEY' },
    })
  }
  if (minted) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:oauth-key',
      name: 'oauth',
      kind: 'oauth',
      kindLabel: 'OAuth-minted key',
      identity: label([
        `minted ${new Date(minted.mintedAtMs).toLocaleDateString()}`,
        maskedKeyTail(minted.key),
      ]),
      active: !envKey,
      envPinned: false,
      signedIn: true,
      ...(envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: { route: 'openrouter-oauth-key' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'openrouter',
      id: 'openrouter:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && !minted,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : minted
          ? { stateNote: 'shadowed — the OAuth-minted key wins' }
          : {}),
      removal: { route: 'openrouter-stored-key' },
    })
  }
  return slots
}

function keyLaneSlots(args: {
  family: string
  envVar: string
  envKey: string | undefined
  storedKey: string | undefined
  storedRemoval: SlotRemoval
}): AccountSlot[] {
  const slots: AccountSlot[] = []
  if (args.envKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:env-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label([`${args.envVar} (env)`, maskedKeyTail(args.envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: args.envVar },
    })
  }
  if (args.storedKey) {
    slots.push({
      family: args.family,
      id: `${args.family}:stored-key`,
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(args.storedKey)]),
      active: !args.envKey,
      envPinned: false,
      signedIn: true,
      ...(args.envKey ? { stateNote: 'shadowed — the env pin wins' } : {}),
      removal: args.storedRemoval,
    })
  }
  return slots
}

function geminiSlots(reads: AccountSlotReads): AccountSlot[] {
  const oauthConnected = (reads.geminiOauthConnected ?? geminiOauthConnected)()
  const active = (reads.geminiActiveAccount ?? resolveGeminiAccount)()
  const envGoogle = reads.geminiEnvGoogleKey
    ? reads.geminiEnvGoogleKey()
    : process.env.GOOGLE_API_KEY?.trim() || undefined
  const envGemini = reads.geminiEnvGeminiKey
    ? reads.geminiEnvGeminiKey()
    : process.env.GEMINI_API_KEY?.trim() || undefined
  const storedKey = (reads.geminiStoredKey ?? readStoredGeminiApiKey)()
  const slots: AccountSlot[] = []
  if (oauthConnected) {
    slots.push({
      family: 'gemini',
      id: 'gemini:oauth',
      name: 'google',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: 'Google account (OAuth)',
      active: active?.kind === 'oauth',
      envPinned: false,
      signedIn: true,
      removal: { route: 'gemini-oauth' },
    })
  }
  if (envGoogle) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-google-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GOOGLE_API_KEY (env)', maskedKeyTail(envGoogle)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-google',
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'GOOGLE_API_KEY' },
    })
  }
  if (envGemini) {
    slots.push({
      family: 'gemini',
      id: 'gemini:env-gemini-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['GEMINI_API_KEY (env)', maskedKeyTail(envGemini)]),
      active: active?.kind === 'api-key' && active.keySource === 'env-gemini',
      envPinned: true,
      signedIn: true,
      ...(envGoogle
        ? { stateNote: 'shadowed — GOOGLE_API_KEY wins (the documented precedence)' }
        : {}),
      removal: { route: 'env', envVar: 'GEMINI_API_KEY' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'gemini',
      id: 'gemini:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: active?.kind === 'api-key' && active.keySource === 'stored',
      envPinned: false,
      signedIn: true,
      ...(envGoogle || envGemini ? { stateNote: 'shadowed — an env pin wins' } : {}),
      removal: { route: 'gemini-stored-key' },
    })
  }
  return slots
}

function moonshotSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.moonshotEnvKey ? reads.moonshotEnvKey() : process.env.MOONSHOT_API_KEY?.trim() || undefined
  const oauth = (reads.moonshotOauth ?? moonshotStoredTokens)()
  const storedKey = (reads.moonshotStoredKey ?? readStoredMoonshotApiKey)()
  const slots: AccountSlot[] = []
  if (envKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key · env',
      identity: label(['MOONSHOT_API_KEY (env)', maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'MOONSHOT_API_KEY' },
    })
  }
  if (oauth) {
    const region = (reads.moonshotOauthRegion ?? moonshotLoginRegion)()
    const expiredUnrefreshable =
      oauth.accessTokenExpiresAtMs !== undefined &&
      oauth.accessTokenExpiresAtMs <= Date.now() &&
      !oauth.refreshToken
    slots.push({
      family: 'moonshot',
      id: 'moonshot:oauth',
      name: 'kimi',
      kind: 'oauth',
      kindLabel: 'Kimi sign-in',
      identity: label([
        `Kimi account (device-code sign-in · ${kimiRegionLabel(region)})`,
        maskedKeyTail(oauth.accessToken),
      ]),
      active: !envKey && !expiredUnrefreshable,
      envPinned: false,
      signedIn: !expiredUnrefreshable,
      ...(expiredUnrefreshable
        ? { stateNote: 'access token expired with no refresh route — /logins moonshot signs in again' }
        : envKey
          ? { stateNote: 'shadowed — the env pin wins' }
          : {}),
      removal: { route: 'moonshot-oauth' },
    })
  }
  if (storedKey) {
    slots.push({
      family: 'moonshot',
      id: 'moonshot:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'API key',
      identity: label(['stored key (auth-scoped)', maskedKeyTail(storedKey)]),
      active: !envKey && !oauth,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : oauth
          ? { stateNote: 'shadowed — the Kimi sign-in wins' }
          : {}),
      removal: { route: 'moonshot-stored-key' },
    })
  }
  return slots
}

function deepseekSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.deepseekEnvKey ? reads.deepseekEnvKey() : process.env.DEEPSEEK_API_KEY?.trim() || undefined
  const storedKey = (reads.deepseekStoredKey ?? readStoredDeepseekApiKey)()
  return keyLaneSlots({
    family: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'deepseek-stored-key' },
  })
}

function compatSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.compatEnvKey ? reads.compatEnvKey() : process.env.MERCURY_COMPAT_API_KEY?.trim() || undefined
  const storedKey = (reads.compatStoredKey ?? readStoredCompatApiKey)()
  return keyLaneSlots({
    family: 'openai-compat',
    envVar: 'MERCURY_COMPAT_API_KEY',
    envKey,
    storedKey,
    storedRemoval: { route: 'compat-stored-key' },
  })
}

function huggingfaceSlots(reads: AccountSlotReads): AccountSlot[] {
  const envKey =
    reads.huggingfaceEnvKey ? reads.huggingfaceEnvKey() : process.env.HF_TOKEN?.trim() || undefined
  const oauth = (reads.huggingfaceOauth ?? huggingfaceStoredTokens)()
  const storedKey = (reads.huggingfaceStoredKey ?? readStoredHuggingfaceApiKey)()
  const identityOf = reads.huggingfaceStoredKeyIdentity ?? huggingfaceStoredTokenIdentity
  const slots: AccountSlot[] = []
  if (envKey) {
    const identity = identityOf(envKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:env-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token · env',
      identity: label(['HF_TOKEN (env)', identity?.username, maskedKeyTail(envKey)]),
      active: true,
      envPinned: true,
      signedIn: true,
      removal: { route: 'env', envVar: 'HF_TOKEN' },
    })
  }
  if (oauth) {
    const identity = (reads.huggingfaceOauthIdentity ?? huggingfaceOauthIdentity)()
    const expiredUnrefreshable =
      oauth.accessTokenExpiresAtMs !== undefined &&
      oauth.accessTokenExpiresAtMs <= Date.now() &&
      !oauth.refreshToken
    slots.push({
      family: 'huggingface',
      id: 'huggingface:oauth',
      name: identity?.username ?? 'hf',
      kind: 'oauth',
      kindLabel: 'OAuth',
      identity: label([
        identity ? `Hugging Face account · ${identity.username}` : 'Hugging Face account (device flow)',
        maskedKeyTail(oauth.accessToken),
      ]),
      active: !envKey && !expiredUnrefreshable,
      envPinned: false,
      signedIn: !expiredUnrefreshable,
      ...(expiredUnrefreshable
        ? { stateNote: 'access token expired with no refresh route — /logins reconnects Hugging Face' }
        : envKey
          ? { stateNote: 'shadowed — the env pin wins' }
          : {}),
      removal: { route: 'huggingface-oauth' },
    })
  }
  if (storedKey) {
    const identity = identityOf(storedKey)
    slots.push({
      family: 'huggingface',
      id: 'huggingface:stored-key',
      name: 'api-key',
      kind: 'api-key',
      kindLabel: 'token',
      identity: label(['stored token (auth-scoped)', identity?.username, maskedKeyTail(storedKey)]),
      active: !envKey && !oauth,
      envPinned: false,
      signedIn: true,
      ...(envKey
        ? { stateNote: 'shadowed — the env pin wins' }
        : oauth
          ? { stateNote: 'shadowed — the OAuth sign-in wins' }
          : {}),
      removal: { route: 'huggingface-stored-key' },
    })
  }
  return slots
}

function localSlots(reads: AccountSlotReads): AccountSlot[] {
  const account = (reads.localAccount ?? resolveLocalAccount)()
  const envKey =
    reads.localEnvKey ? reads.localEnvKey() : process.env.MERCURY_LOCAL_API_KEY?.trim() || undefined
  const storedKey = (reads.localStoredKey ?? readStoredLocalApiKey)()
  const slots: AccountSlot[] = []
  if (account) {
    slots.push({
      family: 'local',
      id: 'local:servers',
      name: 'servers',
      kind: 'api-key',
      kindLabel: account.kind === 'keyless' ? 'keyless' : 'key',
      identity: `${account.label} · discovered live`,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: 'discovered live — stop the server (or unset MERCURY_LOCAL_BASE_URL) and the row leaves on the next probe',
      },
    })
  }
  slots.push(
    ...keyLaneSlots({
      family: 'local',
      envVar: 'MERCURY_LOCAL_API_KEY',
      envKey,
      storedKey,
      storedRemoval: { route: 'local-stored-key' },
    }),
  )
  return slots
}

function genericSlots(
  family: ProviderFamilyPresence,
  provider: RouterModelSnapshot['providers'][number] | undefined,
): AccountSlot[] {
  const account = provider?.description.account
  if (!account || account.kind === 'none') return []
  const kind: AccountSlotKind =
    account.kind === 'api-key' || account.kind === 'keyless'
      ? 'api-key'
      : account.kind === 'chatgpt-login'
        ? 'subscription'
        : 'oauth'
  return [
    {
      family: family.id,
      id: `${family.id}:account`,
      name: 'account',
      kind,
      kindLabel: kind === 'api-key' ? 'API key' : kind === 'subscription' ? 'subscription' : 'OAuth',
      identity: account.label,
      active: true,
      envPinned: false,
      signedIn: true,
      removal: {
        route: 'owner',
        note: `the ${family.id} credential lives with its owning store — see /capabilities for the route`,
      },
    },
  ]
}

export function deriveFamilySlotGroups(
  providers: RouterModelSnapshot['providers'] = buildRouterModelSnapshot().providers,
  reads: AccountSlotReads = {},
): FamilySlotGroup[] {
  const presences = providerFamilyPresences(providers, reads.familyReads)
  return presences
    .map(family => {
      const slots =
        family.id === 'anthropic'
          ? anthropicSlots(reads)
          : family.id === 'openai'
            ? openaiSlots(reads)
            : family.id === 'zai'
              ? zaiSlots(reads)
              : family.id === 'openrouter'
                ? openrouterSlots(reads)
                : family.id === 'gemini'
                  ? geminiSlots(reads)
                  : family.id === 'moonshot'
                    ? moonshotSlots(reads)
                    : family.id === 'deepseek'
                      ? deepseekSlots(reads)
                      : family.id === 'openai-compat'
                        ? compatSlots(reads)
                        : family.id === 'huggingface'
                          ? huggingfaceSlots(reads)
                          : family.id === 'local'
                            ? localSlots(reads)
                            : genericSlots(
                            family,
                            providers.find(provider => provider.id === family.id),
                          )
      return { family, slots }
    })
}


export interface SlotRemovalOwners {
  disconnectOpenaiSubscription?: () => void
  clearStoredOpenaiKey?: () => void
  clearStoredZaiKey?: () => void
  disconnectOpenrouterOauthKey?: () => void
  clearStoredOpenrouterKey?: () => void
  disconnectGeminiOauth?: () => void
  clearStoredGeminiKey?: () => void
  clearStoredMoonshotKey?: () => void
  disconnectMoonshotOauth?: () => void
  clearStoredDeepseekKey?: () => void
  clearStoredCompatKey?: () => void
  disconnectHuggingfaceOauth?: () => void
  clearStoredHuggingfaceKey?: () => void
  clearStoredLocalKey?: () => void
  clearManagedAnthropicKey?: () => void
  signOutAnthropicOauth?: () => void
  revokeAnthropicToken?: (refreshToken: string) => Promise<void>
  openaiApiKeyAfter?: () => { key: string; source: 'env' | 'stored' } | undefined
}

export interface AnthropicSlotSignOutIo {
  revoke?: (refreshToken: string) => Promise<void>
}

export function signOutAnthropicSlot(
  dir: string,
  io: AnthropicSlotSignOutIo = {},
): { loginLeft: boolean } {
  let refreshToken: string | null = null
  try {
    const stored = getSecureStorage().read()?.claudeAiOauth?.refreshToken
    refreshToken = typeof stored === 'string' && stored.length > 0 ? stored : null
  } catch (error) {
    logError(error)
  }
  let loginLeft = false
  try {
    const removal = removeSecureStorageField('claudeAiOauth')
    loginLeft = removal.removed
    if (!removal.success) {
      logError(new Error('the per-slot sign-out could not rewrite the credential store — the Claude login field stays until the store is writable'))
    }
  } catch (error) {
    logError(error)
  }
  try {
    saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  } catch (error) {
    logError(error)
  }
  clearScopeIdentitySnapshot(dir)
  forgetScopeIdentity(dir)
  dropCredentialMemos()
  noteCredentialChange()
  resetUserCache()
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    logError(error)
  }
  if (refreshToken !== null) {
    void (io.revoke ?? revokeOAuthToken)(refreshToken).catch(logError)
  }
  return { loginLeft }
}

export function executeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners = {},
): { note: string; mutated: boolean } {
  const outcome = routeSlotRemoval(slot, owners)
  if (outcome.mutated) afterCredentialLeft(slot)
  return outcome
}

function afterCredentialLeft(slot: AccountSlot): void {
  forgetFamilyObservations(slot.family, slot.kind)
  try {
    const { clearCapHandoffForFamily } = require('../capFailover.js') as typeof import('../capFailover.js')
    clearCapHandoffForFamily(slot.family)
  } catch {
  }
}

function forgetFamilyObservations(family: string, kind: AccountSlotKind): void {
  try {
    switch (family) {
      case 'openai': {
        const { forgetOpenaiLimitSource } =
          require('./openai/openaiLimitState.js') as typeof import('./openai/openaiLimitState.js')
        forgetOpenaiLimitSource(kind === 'api-key' ? 'api-key' : 'chatgpt-subscription')
        return
      }
      case 'openrouter': {
        const { forgetOpenrouterObservedLimit } =
          require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
        forgetOpenrouterObservedLimit()
        return
      }
      case 'gemini': {
        const { forgetGeminiObservedLimit } =
          require('./gemini/geminiUsageState.js') as typeof import('./gemini/geminiUsageState.js')
        forgetGeminiObservedLimit()
        return
      }
      case 'huggingface': {
        const { forgetHuggingfaceObservedLimits } =
          require('./huggingface/huggingfaceUsageState.js') as typeof import('./huggingface/huggingfaceUsageState.js')
        forgetHuggingfaceObservedLimits()
        return
      }
      default:
        return
    }
  } catch {
  }
}

function routeSlotRemoval(
  slot: AccountSlot,
  owners: SlotRemovalOwners,
): { note: string; mutated: boolean } {
  const removal = slot.removal
  switch (removal.route) {
    case 'excluded':
    case 'owner':
    case 'settings':
      return { note: removal.note, mutated: false }
    case 'env':
      return {
        note: `${removal.envVar} is the shell's env pin — unset it in your shell to remove; Mercury never edits your environment`,
        mutated: false,
      }
    case 'anthropic-oauth': {
      const snapshot =
        slot.scope !== undefined && (slot.scope.uuid !== undefined || slot.scope.email !== undefined)
      if (!slot.signedIn && !snapshot) {
        forgetScopeIdentity(removal.dir)
        return { note: 'not signed in — nothing to sign out (↵ signs in)', mutated: false }
      }
      let loginLeft = slot.signedIn
      if (owners.signOutAnthropicOauth) owners.signOutAnthropicOauth()
      else {
        loginLeft = signOutAnthropicSlot(removal.dir, {
          ...(owners.revokeAnthropicToken ? { revoke: owners.revokeAnthropicToken } : {}),
        }).loginLeft
      }
      return loginLeft
        ? {
            note: 'signing out this Claude login — tokens revoked and dropped; the home, transcripts, and config stay (/logout stays the global verb)',
            mutated: true,
          }
        : {
            note: 'no Claude login was stored here — the stale identity snapshot cleared; the home, transcripts, and config stay (↵ signs in)',
            mutated: true,
          }
    }
    case 'anthropic-managed-key':
      ;(owners.clearManagedAnthropicKey ?? (() => void removeApiKey()))()
      return { note: 'clearing the /logins managed key (config + keychain)', mutated: true }
    case 'openai-subscription': {
      ;(owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription)()
      const key = (owners.openaiApiKeyAfter ?? resolveOpenaiApiKey)()
      return {
        note: `ChatGPT subscription disconnected — tokens dropped.${key ? ` The OpenAI API key (${key.source}) still resolves as the api-key source.` : ''}`,
        mutated: true,
      }
    }
    case 'openai-stored-key':
      ;(owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null)))()
      return { note: 'stored OpenAI API key cleared from the auth-scoped store', mutated: true }
    case 'zai-stored-key':
      ;(owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null)))()
      return { note: 'stored Z.AI API key cleared from the auth-scoped store', mutated: true }
    case 'openrouter-oauth-key':
      ;(owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey)()
      return {
        note: 'OAuth-minted OpenRouter key dropped locally — revoke it at openrouter.ai → Settings → Keys to kill it server-side',
        mutated: true,
      }
    case 'openrouter-stored-key':
      ;(owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null)))()
      return { note: 'stored OpenRouter API key cleared from the auth-scoped store', mutated: true }
    case 'gemini-oauth':
      ;(owners.disconnectGeminiOauth ?? disconnectGeminiOauth)()
      return {
        note: 'Google OAuth tokens dropped — full revocation lives at myaccount.google.com → Security → Third-party access',
        mutated: true,
      }
    case 'gemini-stored-key':
      ;(owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null)))()
      return { note: 'stored Gemini API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-stored-key':
      ;(owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null)))()
      return { note: 'stored Moonshot API key cleared from the auth-scoped store', mutated: true }
    case 'moonshot-oauth':
      ;(owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth)()
      return {
        note: 'Kimi sign-in disconnected — tokens dropped (the region choice stays remembered for the next /logins moonshot).',
        mutated: true,
      }
    case 'deepseek-stored-key':
      ;(owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null)))()
      return { note: 'stored DeepSeek API key cleared from the auth-scoped store', mutated: true }
    case 'compat-stored-key':
      ;(owners.clearStoredCompatKey ?? (() => writeStoredCompatApiKey(null)))()
      return { note: 'stored endpoint API key cleared from the auth-scoped store', mutated: true }
    case 'huggingface-oauth':
      ;(owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth)()
      return {
        note: 'Hugging Face OAuth tokens dropped — revoke the grant at huggingface.co → Settings → Connected applications to kill it server-side',
        mutated: true,
      }
    case 'huggingface-stored-key':
      ;(owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null)))()
      return { note: 'stored Hugging Face token cleared from the auth-scoped store', mutated: true }
    case 'local-stored-key':
      ;(owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null)))()
      return { note: 'stored local-server key cleared from the auth-scoped store', mutated: true }
  }
}


export function signOutEveryEngineCredential(owners: SlotRemovalOwners = {}): void {
  const steps: Array<[AccountSlot['removal']['route'], () => void]> = [
    ['openai-subscription', owners.disconnectOpenaiSubscription ?? disconnectOpenaiSubscription],
    ['openai-stored-key', owners.clearStoredOpenaiKey ?? (() => writeStoredOpenaiApiKey(null))],
    ['zai-stored-key', owners.clearStoredZaiKey ?? (() => writeStoredZaiApiKey(null))],
    ['openrouter-oauth-key', owners.disconnectOpenrouterOauthKey ?? disconnectOpenrouterOauthKey],
    ['openrouter-stored-key', owners.clearStoredOpenrouterKey ?? (() => writeStoredOpenrouterApiKey(null))],
    ['gemini-oauth', owners.disconnectGeminiOauth ?? disconnectGeminiOauth],
    ['gemini-stored-key', owners.clearStoredGeminiKey ?? (() => writeStoredGeminiApiKey(null))],
    ['moonshot-oauth', owners.disconnectMoonshotOauth ?? disconnectMoonshotOauth],
    ['moonshot-stored-key', owners.clearStoredMoonshotKey ?? (() => writeStoredMoonshotApiKey(null))],
    ['deepseek-stored-key', owners.clearStoredDeepseekKey ?? (() => writeStoredDeepseekApiKey(null))],
    ['compat-stored-key', owners.clearStoredCompatKey ?? (() => writeStoredCompatApiKey(null))],
    ['huggingface-oauth', owners.disconnectHuggingfaceOauth ?? disconnectHuggingfaceOauth],
    ['huggingface-stored-key', owners.clearStoredHuggingfaceKey ?? (() => writeStoredHuggingfaceApiKey(null))],
    ['local-stored-key', owners.clearStoredLocalKey ?? (() => writeStoredLocalApiKey(null))],
  ]
  for (const [, step] of steps) {
    try {
      step()
    } catch (error) {
      logError(error)
    }
  }
  for (const [family, kind] of [
    ['openai', 'subscription'],
    ['openai', 'api-key'],
    ['openrouter', 'api-key'],
    ['gemini', 'oauth'],
    ['huggingface', 'oauth'],
  ] as const) {
    forgetFamilyObservations(family, kind)
  }
}
