import type { AccountScope } from '../../sign-in/account-ledger/scopeScan.js'
import type { ProviderFamilyPresence, ProviderFamilyReads } from '../providerUsage.js'
import type { ApiKeySource } from '../../sign-in/credentials/auth.js'
import type { OpenaiAccountRef } from '../openai/openaiAccounts.js'
import type { OpenrouterMintedKey } from '../openrouter/openrouterAccounts.js'
import type { geminiExpiredSignIns, geminiPlanFacts, GeminiAccountRef } from '../gemini/geminiAccounts.js'
import type { KimiRegion } from '../moonshot/moonshotAccounts.js'
import type { xaiStoredTokens } from '../xai/xaiOauth.js'
import type { nousStoredTokens } from '../nous/nousOauth.js'
import type { HuggingfaceIdentity } from '../huggingface/huggingfaceAccounts.js'
import type { LocalAccountRef } from '../local/localAccounts.js'

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
  | { route: 'gemini-plan' }
  | { route: 'gemini-stored-key' }
  | { route: 'moonshot-stored-key' }
  | { route: 'moonshot-oauth' }
  | { route: 'deepseek-stored-key' }
  | { route: 'xai-oauth' }
  | { route: 'xai-stored-key' }
  | { route: 'xai-management-key' }
  | { route: 'meta-muse-code' }
  | { route: 'meta-stored-key' }
  | { route: 'zen-stored-key' }
  | { route: 'minimax-stored-key' }
  | { route: 'together-stored-key' }
  | { route: 'cohere-stored-key' }
  | { route: 'groq-stored-key' }
  | { route: 'melious-stored-key' }
  | { route: 'orcarouter-stored-key' }
  | { route: 'cerebras-stored-key' }
  | { route: 'fireworks-stored-key' }
  | { route: 'qwen-stored-key' }
  | { route: 'compat-stored-key'; endpoint?: string }
  | { route: 'huggingface-oauth' }
  | { route: 'huggingface-stored-key' }
  | { route: 'local-stored-key' }
  | { route: 'mistral-stored-key' }
  | { route: 'mistral-admin-key' }
  | { route: 'nous-stored-key' }
  | { route: 'nous-signin' }
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
  signInEmail?: string
  credits?: import('../providerUsage.js').UsageCreditsView
  active: boolean
  envPinned: boolean
  signedIn: boolean
  expired?: boolean
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
  anthropicSignInExpired?: () => boolean
  anthropicApiKey?: () => { key: string | null; source: ApiKeySource }
  openaiSubscription?: () => OpenaiAccountRef | undefined
  openaiSubscriptionPresence?: () => { state: 'connected' | 'expired' | 'absent'; email?: string; planType?: string }
  openaiActiveAccount?: () => OpenaiAccountRef | undefined
  openaiApiKey?: () => { key: string; source: 'env' | 'stored' } | undefined
  zaiEnvKey?: () => string | undefined
  zaiStoredKey?: () => string | undefined
  zaiStoredKeyPlan?: () => 'coding' | undefined
  openrouterEnvKey?: () => string | undefined
  openrouterMintedKey?: () => OpenrouterMintedKey | undefined
  openrouterStoredKey?: () => string | undefined
  geminiOauthConnected?: () => boolean
  geminiPlanFacts?: () => ReturnType<typeof geminiPlanFacts>
  geminiExpiredSignIns?: () => ReturnType<typeof geminiExpiredSignIns>
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
  xaiOauth?: typeof xaiStoredTokens
  xaiEnvKey?: () => string | undefined
  xaiStoredKey?: () => string | undefined
  xaiManagementEnvKey?: () => string | undefined
  xaiManagementStoredKey?: () => string | undefined
  metaEnvKey?: () => string | undefined
  metaStoredKey?: () => string | undefined
  metaMuseCode?: () => import('../meta/metaAccounts.js').MetaMuseCodeFacts | undefined
  metaActiveAccount?: () => import('../meta/metaAccounts.js').MetaAccountRef | undefined
  mistralEnvKey?: () => string | undefined
  mistralStoredKey?: () => string | undefined
  mistralAdminEnvKey?: () => string | undefined
  mistralAdminStoredKey?: () => string | undefined
  nousEnvKey?: () => string | undefined
  nousStoredKey?: () => string | undefined
  nousSignin?: typeof nousStoredTokens
  zenEnvKey?: () => string | undefined
  zenStoredKey?: () => string | undefined
  minimaxEnvKey?: () => string | undefined
  minimaxStoredKey?: () => string | undefined
  togetherEnvKey?: () => string | undefined
  togetherStoredKey?: () => string | undefined
  cohereEnvKey?: () => string | undefined
  cohereStoredKey?: () => string | undefined
  groqEnvKey?: () => string | undefined
  meliousEnvKey?: () => string | undefined
  groqStoredKey?: () => string | undefined
  meliousStoredKey?: () => string | undefined
  orcarouterEnvKey?: () => string | undefined
  orcarouterStoredKey?: () => string | undefined
  cerebrasEnvKey?: () => string | undefined
  cerebrasStoredKey?: () => string | undefined
  fireworksEnvKey?: () => string | undefined
  fireworksStoredKey?: () => string | undefined
  qwenEnvKey?: () => string | undefined
  qwenStoredKey?: () => string | undefined
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

export interface SlotRemovalOwners {
  disconnectOpenaiSubscription?: () => void
  clearStoredOpenaiKey?: () => void
  clearStoredZaiKey?: () => void
  disconnectOpenrouterOauthKey?: () => void
  clearStoredOpenrouterKey?: () => void
  disconnectGeminiOauth?: () => void
  disconnectGeminiPlan?: () => void
  clearStoredGeminiKey?: () => void
  clearStoredMoonshotKey?: () => void
  disconnectMoonshotOauth?: () => void
  clearStoredDeepseekKey?: () => void
  clearXaiSubscription?: () => void
  clearStoredXaiKey?: () => void
  clearStoredXaiManagementKey?: () => void
  disconnectMetaMuseCode?: () => void
  clearStoredMetaKey?: () => void
  clearStoredMistralKey?: () => void
  clearStoredMistralAdminKey?: () => void
  clearStoredZenKey?: () => void
  clearStoredMinimaxKey?: () => void
  clearStoredTogetherKey?: () => void
  clearStoredCohereKey?: () => void
  clearStoredGroqKey?: () => void
  clearStoredMeliousKey?: () => void
  clearStoredOrcarouterKey?: () => void
  clearStoredCerebrasKey?: () => void
  clearStoredFireworksKey?: () => void
  clearStoredQwenKey?: () => void
  clearStoredCompatKey?: () => void
  disconnectHuggingfaceOauth?: () => void
  clearStoredHuggingfaceKey?: () => void
  clearStoredLocalKey?: () => void
  clearStoredNousKey?: () => void
  clearNousSignin?: () => void
  clearManagedAnthropicKey?: () => void
  signOutAnthropicOauth?: () => void
  revokeAnthropicToken?: (refreshToken: string) => Promise<void>
  openaiApiKeyAfter?: () => { key: string; source: 'env' | 'stored' } | undefined
}
