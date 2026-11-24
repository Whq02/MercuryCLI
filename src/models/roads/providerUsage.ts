import { hostRentalUsage } from '../hosting/costs.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  getSubscriptionType,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
} from '../sign-in/credentials/auth.js'
import { invalidateOnDiskChange } from '../sign-in/lifecycle/oauthLifecycle.js'
import { getEngineModel } from '../catalogue/engineModel.js'
import { buildProviderSnapshot, type ProviderSnapshot } from './modelRegistry.js'
import type { ProviderFamilyId } from './providerAdapter.js'
import { formatClock, formatCountdown, quotaWindows, type QuotaWindow } from '../../screen/cockpit-gauges/quota.js'
import {
  anthropicWindowClosedUntil,
  anthropicWindowFact,
  currentLimits,
  getEndpointExtraUsage,
  getRateLimitDisplayName,
  getRawUtilization,
  getUsageCredentialEpoch,
  getUsageRecordVersion,
  WEEKLY_POOL_CLAIMS,
  weeklyPoolClaimForModel,
  windowClaimBindsModel,
  type AnthropicExtraUsageRecord,
  type AnthropicMoney,
  type AnthropicLimits,
  type AnthropicWindowFact,
  type RateLimitType,
  type WeeklyPoolClaim,
} from './anthropic/anthropicLimits.js'
import { rateLimitWindowName } from './anthropic/rateLimitMessages.js'
import { readSignInRecord, subscribeSignInEpoch } from '../sign-in/account-ledger/signInLedger.js'
import { recordUsageObservations } from '../usage/usageHistory.js'
import { PROVIDER_CREDENTIAL_ENV_VARS } from '../sign-in/credentials/credentialEnvSpellings.js'
import { credentialFingerprint } from '../sign-in/account-ledger/credentialIdentity.js'
import { activeWalletEntry, anthropicCredentialAccount, walletEntries, type WalletEntry } from '../wallet/wallet.js'
import { accountIdentityShown, familyAccountWord } from '../wallet/identityWords.js'
import { declaredRouteOf, PROVIDER_ID_SPACES, providerDisplayName } from './routeLaw.js'
import {
  NO_USAGE_READ_WORDS,
  usageAgeWords,
  usageFreshHorizonMs,
  usageFreshness,
  usageSourceWords,
  usageStaleAfterMs,
  usageStaleTail,
  type UsageFeed,
} from './usageFreshness.js'
import {
  openaiLimitWindow,
  type OpenaiLimitWindow,
  type OpenaiObservedUsage,
} from './openai/openaiLimitState.js'
import { openaiSubscriptionUsage, openaiUsageReaderState } from './openai/openaiUsageState.js'
import type { OpenrouterKeySource } from './openrouter/openrouterAccounts.js'
import {
  refreshOpenrouterKeyUsage,
  type OpenrouterKeyUsage,
  type OpenrouterLimitWindow,
} from './openrouter/openrouterUsageState.js'
import type { GeminiAccountRef } from './gemini/geminiAccounts.js'
import type { GeminiLimitWindow } from './gemini/geminiUsageState.js'
export { geminiLaneModelsByLastUse, geminiPlanQuotaFoldWords, geminiPlanQuotaView, type GeminiPlanQuotaView } from './gemini/geminiPlanQuota.js'
import {
  resolveHuggingfaceAccount,
  type HuggingfaceAccountRef,
} from './huggingface/huggingfaceAccounts.js'
import {
  refreshHuggingfaceAccountFacts,
  type HuggingfaceAccountFacts,
  type HuggingfaceAccountFactsFailure,
  type HuggingfaceLimitWindow,
} from './huggingface/huggingfaceUsageState.js'
import type { LocalAccountRef } from './local/localAccounts.js'
import { refreshLocalDiscovery } from './local/localDiscovery.js'
import { spendForRoute } from './provider-usage/spend.js'
export { ADVISOR_WORK_WORD, advisorSessionSpend, advisorUsageLine, providerSessionSpend, SCHEDULED_WORK_WORD, scheduledSessionSpend, scheduledUsageLine, sessionSpendByModel, sessionSpendOfFacts } from './provider-usage/spend.js'
import { refreshXaiSubscriptionCredits, refreshXaiUsage, xaiObservedSubscriptionCredits, xaiObservedUsage } from './xai/xaiUsageState.js'
import { deepseekUsageView } from './provider-usage/deepseek.js'
import { geminiUsageView } from './provider-usage/gemini.js'
export { geminiPlanUsageFigures } from './provider-usage/gemini.js'
import { huggingfaceUsageView } from './provider-usage/huggingface.js'
export { huggingfacePlanFigures } from './provider-usage/huggingface.js'
import { localUsageView } from './provider-usage/local.js'
import { metaUsageView } from './provider-usage/meta.js'
export { metaMuseCodeUsage } from './provider-usage/meta.js'
import { minimaxUsageView } from './provider-usage/minimax.js'
export { minimaxPlanWindowViews } from './provider-usage/minimax.js'
import { mistralUsageView } from './provider-usage/mistral.js'
import { moonshotUsageView } from './provider-usage/moonshot.js'
export { KIMI_EXTRA_USAGE_NOT_READ_WORDS, KIMI_EXTRA_USAGE_UNSTATED_WORDS, kimiManagedWindowViews } from './provider-usage/moonshot.js'
import { nousUsageView } from './provider-usage/nous.js'
import { openrouterUsageView } from './provider-usage/openrouter.js'
export { openrouterObservedWindowViews } from './provider-usage/openrouter.js'
import { API_BILLING_TIER, CARRY_NOTHING_TAIL, CARRY_UNSTATED, CREDITS_UNREPORTED, CREDITS_UNREPORTED_WORDS, planWord, usageWindowLabel } from './provider-usage/shared.js'
export { CARRY_NOTHING_TAIL, CARRY_UNSTATED_COMPACT, CARRY_UNSTATED_WORDS, CREDITS_UNREPORTED_WORDS, usageWindowLabel } from './provider-usage/shared.js'
import { togetherUsageView } from './provider-usage/together.js'
import { xaiUsageView } from './provider-usage/xai.js'
export { XAI_POOL_NOT_READ_WORDS, XAI_POOL_UNSTATED_WORDS, xaiPurchasedCreditsCarry, xaiSubscriptionWindowViews } from './provider-usage/xai.js'
import { zaiUsageView } from './provider-usage/zai.js'
export { zaiAccountFacts, zaiQuotaFigures, zaiQuotaWindowViews } from './provider-usage/zai.js'
import { zenUsageView } from './provider-usage/zen.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'
export { zenGoWindowViews } from './provider-usage/zen.js'

export type UsageProvider = 'anthropic' | 'openai'

export interface ProviderSessionSpend {
  inputTokens: number
  outputTokens: number
  costUSD: number
  models: number
  pricing?: { estimatedModels: number; unpricedModels: number; unpricedTurns: number }
  scheduled?: ProviderSessionSpend
  advisor?: ProviderSessionSpend
}

export interface ProviderUsageView {
  provider: UsageProvider
  activeEntry?: WalletEntry
  entries: WalletEntry[]
  sessionSpend: ProviderSessionSpend
  limits:
    | { kind: 'anthropic-windows'; status: typeof currentLimits.status; raw: ReturnType<typeof getRawUtilization> }
    | { kind: 'openai-observed'; window: OpenaiLimitWindow }
}


export interface ProviderFamilyPresence {
  id: ProviderFamilyId
  available: boolean
  reason?: string
  credentialed: boolean
  credentialLabel?: string
  identity?: string
}

export interface ProviderFamilyReads {
  claudeSubscriber?: () => boolean
  subscriptionType?: () => string | null
  anthropicApiKeyPresent?: () => boolean
  bearerTokenSource?: () => { source: string; hasToken: boolean }
  anthropicEmail?: () => string | undefined
  engineIdentity?: (id: ProviderFamilyId) => string | undefined
}

export function presenceIdentityWords(
  presence: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'> & { id: string },
  shown: boolean = accountIdentityShown(),
): string | undefined {
  if (!presence.credentialed) return undefined
  if (shown || presence.identity === undefined) return presence.identity ?? presence.credentialLabel
  return familyAccountWord(presence.id) ?? 'signed in'
}

function engineIdentityLive(id: ProviderFamilyId): string | undefined {
  try {
    if (id === 'openai') {
      const { resolveOpenaiAccount } =
        require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.email
    }
    if (id === 'xai') {
      const { resolveXaiAccount } = require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')
      return resolveXaiAccount()?.email
    }
    if (id === 'meta') {
      const { resolveMetaAccount } = require('./meta/metaAccounts.js') as typeof import('./meta/metaAccounts.js')
      return resolveMetaAccount()?.email
    }
    if (id === 'huggingface') return resolveHuggingfaceAccount()?.username
    if (id === 'mistral') {
      const { mistralObservedIdentityWords } = require('./mistral/mistralUsageState.js') as typeof import('./mistral/mistralUsageState.js')
      return mistralObservedIdentityWords()
    }
  } catch (error) {
    passedOver(error)
  }
  return undefined
}

export function anthropicCredentialPresence(
  reads?: ProviderFamilyReads,
): { credentialed: boolean; credentialLabel?: string; identity?: string; expired?: boolean } {
  if (reads === undefined) invalidateOnDiskChange()
  const subscriber = reads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const plan = reads?.subscriptionType?.() ?? getSubscriptionType()
  const keyPresent =
    reads?.anthropicApiKeyPresent?.() ??
    ((): boolean => {
      try {
        return getAnthropicApiKey() !== null
      } catch (error) {
        passedOver(error)
        return false
      }
    })()
  const bearer = reads?.bearerTokenSource?.() ?? readBearerTokenSource()
  const envBearer =
    bearer.hasToken && bearer.source !== 'claude.ai' && bearer.source !== 'credentials.keyCommand' && bearer.source !== 'none'
  const credentialLabel = subscriber
    ? `Claude subscription${plan ? ` (${plan})` : ''}`
    : keyPresent
      ? 'Anthropic API key'
      : envBearer
        ? `Anthropic bearer token (${bearer.source})`
        : undefined
  const expired = ((): boolean => {
    try {
      return isAnthropicOAuthSignInExpired()
    } catch (error) {
      passedOver(error)
      return false
    }
  })()
  const identity = subscriber ? anthropicSignInEmail(reads) : undefined
  return {
    credentialed: credentialLabel !== undefined,
    ...(credentialLabel !== undefined ? { credentialLabel } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(expired ? { expired: true } : {}),
  }
}

export function anthropicSignInEmail(reads?: ProviderFamilyReads): string | undefined {
  try {
    const email = reads?.anthropicEmail ? reads.anthropicEmail() : anthropicCredentialAccount(getClaudeAIOAuthTokens())?.email
    return typeof email === 'string' && email.trim() !== '' ? email.trim() : undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function readBearerTokenSource(): { source: string; hasToken: boolean } {
  try {
    return getAuthTokenSource()
  } catch (error) {
    passedOver(error)
    return { source: 'none', hasToken: false }
  }
}

export function providerFamilyPresences(
  providers: ProviderSnapshot['providers'] = buildProviderSnapshot().providers,
  reads?: ProviderFamilyReads,
): ProviderFamilyPresence[] {
  return providers.map((provider): ProviderFamilyPresence => {
    if (provider.id === 'anthropic') {
      return {
        id: provider.id,
        available: provider.available,
        ...(provider.reason !== undefined ? { reason: provider.reason } : {}),
        ...anthropicCredentialPresence(reads),
      }
    }
    const account = provider.description.account
    const identity = account.kind !== 'none' ? (reads?.engineIdentity ?? engineIdentityLive)(provider.id) : undefined
    return {
      id: provider.id,
      available: provider.available,
      ...(provider.reason !== undefined ? { reason: provider.reason } : {}),
      credentialed: account.kind !== 'none',
      ...(account.kind !== 'none' ? { credentialLabel: account.label } : {}),
      ...(identity !== undefined && identity !== '' ? { identity } : {}),
    }
  })
}

export function anyProviderCredentialed(): boolean {
  return providerFamilyPresences().some(family => family.credentialed)
}

export interface ModelSessionSpend {
  model: string
  spend: ProviderSessionSpend
}


export interface UsageWindowView {
  key: string
  label: string
  state: 'live' | 'unavailable'
  usedPct?: number
  resetsAtMs?: number
  observedAtMs?: number
  source?: UsageFeed
  freshForMs?: number
}

export interface UsageBindingView {
  window: UsageWindowView
  claim?: RateLimitType
  windowName: string
}

export interface UsageCreditsView {
  state: 'reported' | 'unreported'
  display?: string
  compact?: string
  source?: UsageFeed
  observedAtMs?: number
  freshForMs?: number
  reason?: string
}

export interface UsageCarryView {
  state: 'carries' | 'nothing' | 'unstated'
  display: string
  compact: string
  source?: UsageFeed
  observedAtMs?: number
  freshForMs?: number
}

export type ActiveUsageShape = 'subscription-windows' | 'api-spend' | 'none'

export interface UsageFigureView {
  key: string
  label: string
  value: string
  observedAtMs?: number
  resetsAtMs?: number
  source?: UsageFeed
  freshForMs?: number
}

export interface ActiveSourceUsage {
  provider: ProviderFamilyId | 'unrecognised'
  sourceKind: 'subscription-oauth' | 'oauth' | 'api-key' | 'keyless' | 'none'
  label: string
  shape: ActiveUsageShape
  windows: UsageWindowView[]
  pools: UsageWindowView[]
  binding?: UsageBindingView
  credits?: UsageCreditsView
  carry?: UsageCarryView
  spend: ProviderSessionSpend
  limited?: { resetsAtMs: number; claim?: RateLimitType; windowName?: string }
  balance?: {
    display: string
    observedAtMs: number
  }
  figures?: UsageFigureView[]
  readerNote?: string
  readerNoteCompact?: string
  readerWait?: boolean
  readerRecord?: string
  absence?: string
  whyNot?: string
  tier?: string
  rental?: ReturnType<typeof hostRentalUsage>
}

export interface ActiveUsageReads {
  route?: (model: string) => ProviderFamilyId
  activeEntry?: (provider: UsageProvider) => WalletEntry | undefined
  anySignedIn?: () => boolean
  anthropicWindows?: () => { fiveHour: QuotaWindow; sevenDay: QuotaWindow }
  anthropicPoolWindows?: () => UsageWindowView[]
  anthropicExtraUsage?: () => AnthropicExtraUsageRecord | null
  anthropicLimits?: () => AnthropicLimits
  anthropicWindow?: () => AnthropicWindowFact | undefined
  openaiObserved?: () => OpenaiObservedUsage
  openaiLimited?: () => OpenaiLimitWindow
  zaiKeyPresent?: () => boolean
  zaiAccount?: () => { plan: 'general' | 'coding'; source: 'env' | 'stored' } | undefined
  zaiQuota?: () => ZaiObservedQuotaView | null
  zaiQuotaFailure?: () => ZaiQuotaFailureView | null
  openrouterKeyPresent?: () => boolean
  openrouterObserved?: () => { usage: OpenrouterKeyUsage | null; lastError?: string; errorSource?: OpenrouterKeySource }
  openrouterLimited?: () => OpenrouterLimitWindow
  geminiAccount?: () => GeminiAccountRef | undefined
  geminiLimited?: () => GeminiLimitWindow
  huggingfaceAccount?: () => HuggingfaceAccountRef | undefined
  huggingfaceLimited?: () => HuggingfaceLimitWindow
  huggingfaceRate?: () => { remaining: number; resetsAtMs?: number; observedAtMs: number } | null
  huggingfaceAccountFacts?: () => HuggingfaceAccountFacts | null
  huggingfaceAccountFactsFailure?: () => HuggingfaceAccountFactsFailure | null
  localAccount?: () => LocalAccountRef | undefined
  laneCredentialed?: (provider: ProviderFamilyId) => boolean
  deepseekBalance?: () => DeepseekObservedBalanceView | null
  xaiAccount?: () => { kind: 'grok-subscription' | 'api-key' } | undefined
  xaiManagementKeyPresent?: () => boolean
  xaiObserved?: typeof xaiObservedUsage
  xaiSubscriptionCredits?: typeof xaiObservedSubscriptionCredits
  mistralAdminKeyPresent?: () => boolean
  mistralObserved?: () => { identity: { email?: string; name?: string; organization?: string; workspace?: string } | null; limits: import('./mistral/mistralUsageState.js').MistralObservedLimits | null; failure: import('./mistral/mistralUsageState.js').MistralUsageFailure | null }
  moonshotAccount?: () => { kind: 'kimi-oauth' | 'api-key' } | undefined
  moonshotBalance?: () => MoonshotObservedBalanceView | null
  kimiManagedUsage?: () => KimiManagedUsageView | null
  kimiManagedError?: () => string | undefined
  spend?: (route: ProviderFamilyId) => ProviderSessionSpend
  anthropicPlan?: () => string | null
  nousAccount?: () => NousObservedAccountView | null
  nousAccountFailure?: () => NousAccountFailureView | null
  nousSignedIn?: () => boolean
  zenGoUsage?: () => ZenGoObservationView
  minimaxPlanUsage?: () => MinimaxPlanObservationView
}

export interface NousObservedAccountView {
  observedAtMs: number
  accountTier?: string
  subscription?: { plan?: string; tier?: number; monthlyCredits?: number; currentPeriodEnd?: string; creditsRemaining?: number; rolloverCredits?: number }
  paidAccess?: { allowed?: boolean; reason?: string; hasActiveSubscription?: boolean; totalUsableCredits?: number; subscriptionCreditsRemaining?: number; purchasedCreditsRemaining?: number; memberSpendCapUsd?: number; memberSpendUsd?: number; memberSpendCapRemainingUsd?: number }
}

export interface NousAccountFailureView {
  kind: 'refused' | 'unreachable'
  atMs: number
  status?: number
  message: string
}

export interface DeepseekObservedBalanceView {
  observedAtMs: number
  isAvailable: boolean
  balances: { currency: string; totalBalance: string }[]
}

export interface ZenGoObservationView {
  usage: { observedAtMs: number; windows: { name: '5 hour' | 'weekly' | 'monthly'; status: 'ok' | 'rate-limited'; usedPercent: number; resetsAtMs?: number }[] } | null
  plan: 'go' | 'none' | 'unknown'
  failure: { atMs: number; kind: 'refused' | 'unreachable' | 'invalid'; status?: number } | null
}

export interface MinimaxPlanObservationView {
  usage: { observedAtMs: number; windows: { model: string; name: '5 hour' | 'weekly'; usedPercent: number; resetsAtMs?: number }[] } | null
  plan: 'm-plan' | 'none' | 'unknown'
  failure: { atMs: number; kind: 'refused' | 'unreachable' | 'invalid'; status?: number } | null
}

export interface UsageRefreshIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}

export async function refreshProviderUsage(provider: ProviderFamilyId, io?: UsageRefreshIo): Promise<void> {
  try {
    switch (provider) {
      case 'openai': {
        const { refreshOpenaiUsage } = require('./openai/openaiUsageState.js') as typeof import('./openai/openaiUsageState.js')
        await refreshOpenaiUsage(io)
        return
      }
      case 'openrouter':
        await refreshOpenrouterKeyUsage(io)
        return
      case 'orcarouter': {
        const { refreshOrcarouterUsage } = await import('./orcarouter/orcarouterUsageState.js')
        await refreshOrcarouterUsage(io)
        return
      }
      case 'xai': {
        const { resolveXaiAccount } = require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')
        if (resolveXaiAccount()?.kind === 'grok-subscription') await refreshXaiSubscriptionCredits(io)
        else await refreshXaiUsage(io)
        return
      }
      case 'deepseek': {
        const { refreshDeepseekBalance } =
          require('./deepseek/deepseekUsageState.js') as typeof import('./deepseek/deepseekUsageState.js')
        await refreshDeepseekBalance(io)
        return
      }
      case 'moonshot': {
        const { refreshKimiManagedUsage, refreshMoonshotBalance } =
          require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
        const { resolveMoonshotAccount } =
          require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
        const account = resolveMoonshotAccount(io?.env)
        if (account?.kind === 'kimi-oauth') await refreshKimiManagedUsage(io)
        else if (account?.kind === 'api-key') await refreshMoonshotBalance(io)
        return
      }
      case 'zai': {
        const { refreshZaiQuota } = require('./zai/zaiUsageState.js') as typeof import('./zai/zaiUsageState.js')
        await refreshZaiQuota(io)
        return
      }
      case 'anthropic': {
        const { refreshAnthropicUsage } =
          require('./anthropic/anthropicUsageState.js') as typeof import('./anthropic/anthropicUsageState.js')
        await refreshAnthropicUsage({
          ...(io?.reason !== undefined ? { reason: io.reason } : {}),
          ...(io?.now !== undefined ? { now: io.now } : {}),
        })
        return
      }
      case 'nous': {
        const { refreshNousAccount } = require('./nous/nousUsageState.js') as typeof import('./nous/nousUsageState.js')
        await refreshNousAccount(io)
        return
      }
      case 'local':
        await refreshLocalDiscovery({
          ...(io?.env !== undefined ? { env: io.env } : {}),
          ...(io?.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io?.now !== undefined ? { now: io.now } : {}),
          ...(io?.force !== undefined ? { force: io.force } : {}),
        })
        return
      case 'huggingface':
        await refreshHuggingfaceAccountFacts({
          ...(io?.env !== undefined ? { env: io.env } : {}),
          ...(io?.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io?.now !== undefined ? { now: io.now } : {}),
          ...(io?.force !== undefined ? { force: io.force } : {}),
        })
        return
      case 'mistral': {
        const { refreshMistralUsage } = require('./mistral/mistralUsageState.js') as typeof import('./mistral/mistralUsageState.js')
        await refreshMistralUsage(io)
        return
      }
      case 'meta': {
        const { refreshMetaMuseCodeUsage } = require('./meta/metaUsageState.js') as typeof import('./meta/metaUsageState.js')
        await refreshMetaMuseCodeUsage(io)
        return
      }
      case 'zen': {
        const { refreshZenGoUsage } = require('./zen/zenUsageState.js') as typeof import('./zen/zenUsageState.js')
        await refreshZenGoUsage(io)
        return
      }
      case 'minimax': {
        const { refreshMinimaxPlanUsage } = require('./minimax/minimaxUsageState.js') as typeof import('./minimax/minimaxUsageState.js')
        await refreshMinimaxPlanUsage(io)
        return
      }
      case 'gemini': {
        const { refreshGeminiPlanQuota } = require('./gemini/geminiPlanQuota.js') as typeof import('./gemini/geminiPlanQuota.js')
        await refreshGeminiPlanQuota(io)
        const { rereadGeminiPlanTierOnShow } = require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
        await rereadGeminiPlanTierOnShow({
          ...(io?.env !== undefined ? { env: io.env } : {}),
          ...(io?.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io?.now !== undefined ? { now: io.now } : {}),
          ...(io?.force !== undefined ? { force: io.force } : {}),
        })
        return
      }
      default:
        return
    }
  } catch (error) {
    passedOver(error)
  } finally {
    try {
      const view = usageForProvider(provider)
      const account = provider === 'anthropic' || provider === 'openai' ? activeWalletEntry(provider)?.id : engineIdentityLive(provider)
      const envIdentity = credentialFingerprint(PROVIDER_CREDENTIAL_ENV_VARS[provider].map(name => hostEnv()[name] ?? '').join('\0'))
      const key = `${view.sourceKind}:${account ?? 'unidentified'}:${readSignInRecord(provider)?.at ?? 'untimed'}:${envIdentity}`
      await recordUsageObservations(provider, key, [...view.windows, ...view.pools])
    } catch (error) {
      passedOver(error)
    }
  }
}

let shownMeters = 0
let shownFamily: (() => ProviderFamilyId | 'unrecognised') | null = null
let unsubscribeSignIns: (() => void) | null = null

function readShownFamily(reason: 'open' | 'sign-in'): void {
  const family = shownFamily?.() ?? 'unrecognised'
  if (family === 'unrecognised') return
  void refreshProviderUsage(family, { reason })
}

export function watchProviderUsageWhileShown(opts: { family: () => ProviderFamilyId | 'unrecognised' }): () => void {
  shownFamily = opts.family
  shownMeters += 1
  if (unsubscribeSignIns === null) {
    unsubscribeSignIns = subscribeSignInEpoch(() => readShownFamily('sign-in'))
  }
  readShownFamily('open')
  let released = false
  return () => {
    if (released) return
    released = true
    shownMeters -= 1
    if (shownMeters <= 0) {
      shownMeters = 0
      unsubscribeSignIns?.()
      unsubscribeSignIns = null
      shownFamily = null
    }
  }
}

export function providerUsageMeterShown(): boolean {
  return shownMeters > 0
}

export interface MoonshotObservedBalanceView {
  observedAtMs: number
  availableBalance: number
}

export interface KimiManagedUsageView {
  observedAtMs: number
  quota?: KimiUsageWindowView
  windows: KimiUsageWindowView[]
  extraUsage?: { balance: string; currency: string }
}
export interface KimiUsageWindowView {
  name?: string
  windowMinutes?: number
  used?: number
  limit?: number
  usedRatio?: number
  resetsAtMs?: number
}

export interface ZaiObservedQuotaView {
  observedAtMs: number
  level?: string
  windows: ZaiQuotaWindowView[]
}
export interface ZaiQuotaWindowView {
  kind: 'credit' | 'tool-calls'
  windowMinutes?: number
  usedPct: number
  used?: number
  limit?: number
  remaining?: number
  resetsAtMs?: number
}
export interface ZaiQuotaFailureView {
  kind: 'refused' | 'unreachable'
  atMs: number
  status?: number
  code?: number
  message?: string
}

export function anthropicWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const { fiveHour, sevenDay } = (reads?.anthropicWindows ?? quotaWindows)()
  const view = (w: QuotaWindow): UsageWindowView => ({
    key: w.key,
    label: w.key,
    state: w.state === 'live' ? 'live' : 'unavailable',
    ...(w.usedPct !== null ? { usedPct: w.usedPct } : {}),
    ...(w.resetsAtMs !== null ? { resetsAtMs: w.resetsAtMs } : {}),
    ...(w.source !== undefined ? { source: w.source, freshForMs: usageStaleAfterMs() } : {}),
    ...(w.observedAtMs !== undefined ? { observedAtMs: w.observedAtMs } : {}),
  })
  return [view(fiveHour), view(sevenDay)]
}

const POOL_LABELS: Record<WeeklyPoolClaim, string> = {
  seven_day_fable: 'Fable',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
}

export function anthropicPoolWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  if (reads?.anthropicPoolWindows) return reads.anthropicPoolWindows()
  const raw = getRawUtilization()
  const views: UsageWindowView[] = []
  for (const claim of WEEKLY_POOL_CLAIMS) {
    const pool = raw[claim]
    if (!pool || !Number.isFinite(pool.utilization) || !Number.isFinite(pool.resets_at)) continue
    views.push({
      key: claim,
      label: POOL_LABELS[claim],
      state: 'live',
      usedPct: pool.utilization * 100,
      resetsAtMs: pool.resets_at * 1000,
      ...(pool.source !== undefined ? { source: pool.source, freshForMs: usageStaleAfterMs() } : {}),
      ...(pool.observedAtMs !== undefined ? { observedAtMs: pool.observedAtMs } : {}),
    })
  }
  return views
}

export const EXTRA_USAGE_NOT_READ_WORDS = 'not read yet — /usage samples the usage endpoint'
export const EXTRA_USAGE_OFF_WORDS = 'extra usage off'
export const EXTRA_USAGE_UNSTATED_WORDS = 'not stated by the endpoint'
export const EXTRA_USAGE_NO_FIGURE_WORDS = 'extra usage on — the endpoint states no figure'

function moneyFigure(m: AnthropicMoney): string {
  return (m.amount / 10 ** m.exponent).toFixed(Math.max(0, Math.min(6, m.exponent)))
}

function moneyShort(m: AnthropicMoney): string {
  return moneyFigure(m).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function moneyWords(m: AnthropicMoney): string {
  return `${m.currency} ${moneyFigure(m)}`
}

export function anthropicExtraUsageCredits(reads?: ActiveUsageReads): UsageCreditsView {
  const record = (reads?.anthropicExtraUsage ?? getEndpointExtraUsage)()
  if (record === null) return { state: 'unreported', reason: EXTRA_USAGE_NOT_READ_WORDS, compact: 'not read yet' }
  const stamp = { source: record.source, observedAtMs: record.observedAtMs, freshForMs: usageStaleAfterMs() }
  if (!record.stated) return { state: 'unreported', reason: EXTRA_USAGE_UNSTATED_WORDS, compact: 'not stated', ...stamp }
  if (!record.enabled) {
    if (record.disabledReason === 'org_level_disabled_until') {
      return { state: 'unreported', reason: 'Extra usage is temporarily disabled by your organisation. Included plan usage continues within its limits.', compact: 'extra off', ...stamp }
    }
    const reason = record.disabledReason ? `${extraUsageDisabledWords(record.disabledReason)}.` : EXTRA_USAGE_OFF_WORDS
    return { state: 'unreported', reason, compact: 'extra off', ...stamp }
  }
  if (record.used === undefined) return { state: 'unreported', reason: EXTRA_USAGE_NO_FIGURE_WORDS, compact: 'not stated', ...stamp }
  const figure = extraUsageFigure(record, record.used)
  const reached = record.limitReached === true ? ' · limit reached' : ''
  const balance = record.balance !== undefined ? ` · balance ${moneyWords(record.balance)}` : ''
  return { state: 'reported', display: `extra usage ${figure.display}${reached}${balance}`, compact: `extra ${figure.compact}`, ...stamp }
}

function extraUsageFigure(record: AnthropicExtraUsageRecord, used: AnthropicMoney): { display: string; compact: string } {
  const cap = record.limit
  const period = record.period === 'month' ? ' this month' : ''
  return cap !== undefined
    ? { display: `${moneyWords(used)} of ${moneyFigure(cap)}${period}`, compact: `${moneyFigure(used)}/${moneyShort(cap)}` }
    : { display: `${moneyWords(used)}${period}`, compact: moneyFigure(used) }
}

function extraUsageDisabledWords(reason: string | undefined): string {
  if (reason === 'org_level_disabled_until') return 'Extra usage is temporarily disabled by your organisation'
  if (reason === 'out_of_credits') return 'Extra usage is out of credits'
  return reason ? 'Extra usage is disabled' : EXTRA_USAGE_OFF_WORDS
}

export function anthropicExtraUsageCarry(reads?: ActiveUsageReads): UsageCarryView {
  const record = (reads?.anthropicExtraUsage ?? getEndpointExtraUsage)()
  const limits = reads?.anthropicLimits?.() ?? (reads === undefined ? currentLimits : undefined)
  const stamp = record !== null ? { source: record.source, observedAtMs: record.observedAtMs, freshForMs: usageStaleAfterMs() } : {}
  if (record !== null && record.stated && record.enabled && record.limitReached === true) {
    return { state: 'nothing', display: `extra usage limit reached — ${CARRY_NOTHING_TAIL}`, compact: 'extra usage limit reached', ...stamp }
  }
  if (limits !== undefined && limits.status === 'rejected' && limits.overageStatus === 'rejected') {
    const reason = limits.overageDisabledReason
    if (reason === 'out_of_credits') return { state: 'nothing', display: `extra usage out of credits — ${CARRY_NOTHING_TAIL}`, compact: 'extra usage out of credits', source: 'headers' }
    if (reason === undefined) return { state: 'nothing', display: `extra usage refused — ${CARRY_NOTHING_TAIL}`, compact: 'extra usage refused', source: 'headers' }
    return { state: 'nothing', display: `${extraUsageDisabledWords(reason)} — ${CARRY_NOTHING_TAIL}`, compact: EXTRA_USAGE_OFF_WORDS, source: 'headers' }
  }
  if (record === null) {
    if (limits?.isUsingOverage === true) return { state: 'carries', display: 'on extra usage', compact: 'on extra usage', source: 'headers' }
    return { state: 'unstated', display: `extra usage ${EXTRA_USAGE_NOT_READ_WORDS}`, compact: 'extra usage not read yet' }
  }
  if (!record.stated) return { state: 'unstated', display: `extra usage ${EXTRA_USAGE_UNSTATED_WORDS}`, compact: 'extra usage not stated', ...stamp }
  if (!record.enabled) {
    return { state: 'nothing', display: `${extraUsageDisabledWords(record.disabledReason)} — ${CARRY_NOTHING_TAIL}`, compact: EXTRA_USAGE_OFF_WORDS, ...stamp }
  }
  if (record.used === undefined) return { state: 'carries', display: 'on extra usage — the endpoint states no figure', compact: 'on extra usage', ...stamp }
  const figure = extraUsageFigure(record, record.used)
  return { state: 'carries', display: `on extra usage · ${figure.display}`, compact: `on extra usage ${figure.compact}`, ...stamp }
}

export function anthropicLimitedWindow(reads?: ActiveUsageReads, now: number = Date.now()): NonNullable<ActiveSourceUsage['limited']> | undefined {
  const fact = (reads?.anthropicWindow ?? anthropicWindowFact)()
  const until = anthropicWindowClosedUntil(fact, now)
  if (until === undefined) return undefined
  const claim = fact?.claim
  return { resetsAtMs: until, ...(claim !== undefined ? { claim, windowName: getRateLimitDisplayName(claim) } : {}) }
}

export function limitBindsWords(claim: RateLimitType | undefined, model: string): string {
  if (claim === undefined || !isOneOf(WEEKLY_POOL_CLAIMS, claim)) return `binds every model, ${model} among them`
  return windowClaimBindsModel(claim, model) ? `binds ${model}` : `binds the ${POOL_LABELS[claim]} models, not ${model}`
}

export function worstLiveWindow(windows: readonly UsageWindowView[]): UsageWindowView | null {
  const live = windows.filter(
    w => w.state === 'live' && typeof w.usedPct === 'number' && Number.isFinite(w.usedPct),
  )
  if (live.length === 0) return null
  return live.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a))
}

export function anthropicClaimOf(view: UsageWindowView): RateLimitType {
  if (view.key === '5h') return 'five_hour'
  if (view.key === '7d') return 'seven_day'
  return view.key as RateLimitType
}

export function usageWindowWord(view: UsageWindowView): string {
  if (view.key === 'cap' || view.label === 'cap') return 'credit cap'
  if (view.label === 'quota') return 'quota'
  if (view.label === 'wk') return 'weekly window'
  if (view.label === 'win') return 'usage window'
  return `${view.label} window`
}

export function bindingWindowOf(
  view: Pick<ActiveSourceUsage, 'provider' | 'shape' | 'windows' | 'pools'>,
  model: string,
): UsageBindingView | undefined {
  const firstParty = view.provider === 'anthropic' && view.shape === 'subscription-windows'
  const applicable = [...view.windows]
  if (firstParty) {
    const claim = weeklyPoolClaimForModel(model)
    for (const pool of view.pools) if (pool.key === claim) applicable.push(pool)
  }
  const worst = worstLiveWindow(applicable)
  if (worst === null) return undefined
  if (firstParty) {
    const claim = anthropicClaimOf(worst)
    return { window: worst, claim, windowName: rateLimitWindowName(claim) }
  }
  return { window: worst, windowName: usageWindowWord(worst) }
}

export function bindingWindowFor(model: string, reads?: ActiveUsageReads): UsageBindingView | undefined {
  return activeSourceUsage({ model, ...(reads !== undefined ? { reads } : {}) }).binding
}

export function usageResetWords(resetsAtMs: number | undefined, now: number = Date.now()): string | undefined {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return undefined
  return `resets ${formatClock(resetsAtMs)} (in ${formatCountdown(resetsAtMs - now)})`
}

export function usageCreditsWords(
  credits: UsageCreditsView | undefined,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  if (credits === undefined) return undefined
  if (credits.state === 'unreported') {
    return style === 'compact' ? (credits.compact ?? 'not reported') : (credits.reason ?? CREDITS_UNREPORTED_WORDS)
  }
  if (style === 'compact') {
    const stale = usageStaleTail(credits, now)
    return `${credits.compact ?? credits.display ?? ''}${stale !== undefined ? ` ${stale}` : ''}`
  }
  const words = usageSourceWords(credits, now)
  return `${credits.display ?? ''}${words !== undefined ? ` · ${words}` : ''}`
}

export function usageCreditsLine(
  credits: UsageCreditsView | undefined,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  const words = usageCreditsWords(credits, now, style)
  if (words === undefined) return undefined
  return style === 'compact' ? `credits ${words}` : `credits: ${words}`
}

export function usageCarryWords(
  carry: UsageCarryView | undefined,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  if (carry === undefined) return undefined
  if (style === 'compact') {
    const stale = usageStaleTail(carry, now)
    return `${carry.compact}${stale !== undefined ? ` ${stale}` : ''}`
  }
  const age = usageViewIsStale(carry, now) ? usageAgeWords(carry, now) : undefined
  return `${carry.display}${age !== undefined ? ` · ${age}` : ''}`
}

export function usageWindowReached(
  view: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited'>,
  now: number = Date.now(),
): 'wall' | 'full' | null {
  if (view.limited !== undefined && view.limited.resetsAtMs > now) return 'wall'
  const full = [...view.windows, ...view.pools].some(
    w => w.state === 'live' && typeof w.usedPct === 'number' && Math.round(w.usedPct) >= 100 && (w.resetsAtMs === undefined || w.resetsAtMs > now),
  )
  return full ? 'full' : null
}

export function usageReachedWords(
  view: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited' | 'carry'>,
  now: number = Date.now(),
  style: 'prose' | 'compact' = 'prose',
): string | undefined {
  const reached = usageWindowReached(view, now)
  if (reached === null) return undefined
  const carry = usageCarryWords(view.carry, now, style)
  if (reached === 'wall') {
    const reset = view.limited !== undefined ? (style === 'compact' ? `resets ${formatCountdown(view.limited.resetsAtMs - now)}` : usageResetWords(view.limited.resetsAtMs, now)) : undefined
    return ['limit reached', reset, carry].filter((part): part is string => part !== undefined).join(' · ')
  }
  return carry !== undefined ? `100% · ${carry}` : '100%'
}

export function freshestUsageView(views: readonly UsageWindowView[]): UsageWindowView | undefined {
  let best: UsageWindowView | undefined
  for (const v of views) {
    if (v.state !== 'live') continue
    if (best === undefined || (v.observedAtMs ?? -1) > (best.observedAtMs ?? -1)) best = v
  }
  return best
}

export function usageSummaryWords(view: ActiveSourceUsage, now: number = Date.now()): string {
  if (view.sourceKind === 'none') return view.whyNot ?? 'not connected'
  const parts: string[] = []
  if (view.tier !== undefined) parts.push(view.tier)
  const metered = [...view.windows, ...view.pools].filter(w => w.state === 'live' && w.usedPct !== undefined)
  for (const w of metered) {
    const reset = usageResetWords(w.resetsAtMs, now)
    parts.push(`${w.label} ${Math.round(w.usedPct ?? 0)}%${reset !== undefined ? ` · ${reset}` : ''}`)
  }
  const stamped = freshestUsageView(metered)
  const source = stamped !== undefined ? usageSourceWords(stamped, now) : undefined
  if (source !== undefined) parts.push(source)
  if (metered.length === 0 && view.shape === 'subscription-windows') {
    parts.push(`${NO_USAGE_READ_WORDS} yet — fills after the first reply, or /usage samples it`)
  }
  if (view.absence !== undefined) parts.push(view.absence)
  const credits = usageCreditsLine(view.credits, now)
  if (credits !== undefined) parts.push(credits)
  if (view.readerNote !== undefined) parts.push(view.readerNote)
  if (view.readerRecord !== undefined) parts.push(view.readerRecord)
  const reached = usageReachedWords(view, now)
  if (reached !== undefined) parts.push(reached)
  return parts.join(' · ')
}

export function usageViewIsStale(view: Pick<UsageWindowView, 'source' | 'observedAtMs' | 'freshForMs'>, now: number = Date.now()): boolean {
  return usageFreshness(view, now).state === 'stale'
}

export function openaiObservedWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  return openaiWindowViews(reads)
}

export function openaiSubscriptionCredits(reads?: ActiveUsageReads): UsageCreditsView {
  const credits = (reads?.openaiObserved ?? openaiSubscriptionUsage)().credits
  if (credits === undefined) return { state: 'unreported', reason: 'not stated on this reply yet', compact: 'not stated yet' }
  const source = credits.source ?? 'headers'
  const stamp = { source, observedAtMs: credits.observedAtMs, freshForMs: usageFreshHorizonMs(source) }
  if (credits.unlimited) return { state: 'reported', display: 'unlimited', compact: 'unlimited', ...stamp }
  if (credits.balance !== undefined) return { state: 'reported', ...openaiBalanceWords(credits.balance), ...stamp }
  return { state: 'unreported', reason: credits.hasCredits ? 'balance not stated on this reply' : 'no credits on this plan', compact: credits.hasCredits ? 'not stated' : 'none on this plan', ...stamp }
}

function openaiBalanceWords(balance: string): { display: string; compact: string } {
  const [integer, decimal] = balance.split('.')
  const display = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimal !== undefined ? `.${decimal}` : '')
  const value = Number(balance)
  const compact = Number.isSafeInteger(Math.trunc(value)) && value >= 1000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase() : display
  return { display, compact }
}

export const OPENAI_CREDITS_NOT_READ_WORDS = 'credits not read yet — /usage samples the usage endpoint'

export function openaiCreditsCarry(reads?: ActiveUsageReads): UsageCarryView {
  const credits = (reads?.openaiObserved ?? openaiSubscriptionUsage)().credits
  if (credits === undefined) return { state: 'unstated', display: OPENAI_CREDITS_NOT_READ_WORDS, compact: 'credits not read yet' }
  const source = credits.source ?? 'headers'
  const stamp = { source, observedAtMs: credits.observedAtMs, freshForMs: usageFreshHorizonMs(source) }
  if (credits.unlimited) return { state: 'carries', display: 'on credits · unlimited', compact: 'on credits unlimited', ...stamp }
  if (!credits.hasCredits) return { state: 'nothing', display: `no credits — ${CARRY_NOTHING_TAIL}`, compact: 'no credits', ...stamp }
  if (credits.balance === undefined) return { state: 'carries', display: 'on credits — the balance is not stated', compact: 'on credits', ...stamp }
  const balance = openaiBalanceWords(credits.balance)
  return { state: 'carries', display: `on credits · ${balance.display} left`, compact: `on credits ${balance.compact}`, ...stamp }
}

function openaiWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openaiObserved ?? openaiSubscriptionUsage)()
  const bands = [observed.primary, observed.secondary].filter(
    (b): b is NonNullable<typeof b> => b !== undefined && b.usedPct !== undefined,
  )
  bands.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return bands.map(band => {
    const label = usageWindowLabel(band.windowMinutes)
    const stamp = { observedAtMs: band.observedAtMs, source: band.source ?? 'headers' as const }
    const horizon = usageFreshHorizonMs(stamp.source)
    const freshForMs = band.resetsAtMs !== undefined ? Math.min(horizon, band.resetsAtMs - band.observedAtMs - 1) : horizon
    return {
      key: label,
      label,
      state: 'live' as const,
      usedPct: band.usedPct!,
      ...(band.resetsAtMs !== undefined ? { resetsAtMs: band.resetsAtMs } : {}),
      ...stamp,
      freshForMs,
    }
  })
}

const ACTIVE_USAGE_CACHE_MS = 2_000
let activeUsageCache: { model: string; atMs: number; epoch: number; record: number; value: ActiveSourceUsage } | null = null

export function activeSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  if (opts?.reads === undefined) {
    const model = opts?.model ?? getEngineModel()
    const now = Date.now()
    const epoch = getUsageCredentialEpoch()
    const record = getUsageRecordVersion()
    if (
      activeUsageCache !== null &&
      activeUsageCache.model === model &&
      activeUsageCache.epoch === epoch &&
      activeUsageCache.record === record &&
      now - activeUsageCache.atMs < ACTIVE_USAGE_CACHE_MS &&
      (activeUsageCache.value.limited === undefined || activeUsageCache.value.limited.resetsAtMs > now)
    ) {
      return activeUsageCache.value
    }
    const value = deriveActiveSourceUsage({ model })
    activeUsageCache = { model, atMs: now, epoch, record, value }
    return value
  }
  return deriveActiveSourceUsage(opts)
}

const ALL_FAMILIES: readonly ProviderFamilyId[] = ['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)]

const OTHER_USAGES_CACHE_MS = 2_000
let otherUsagesCache: {
  primary: ProviderFamilyId | 'unrecognised'
  atMs: number
  epoch: number
  record: number
  value: ActiveSourceUsage[]
} | null = null

export function windowSourceUsages(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): { primary: ActiveSourceUsage; others: ActiveSourceUsage[] } {
  const primary = activeSourceUsage(opts)
  if (opts?.reads !== undefined) {
    return { primary, others: deriveOtherWindowUsages(primary.provider, opts.reads) }
  }
  const now = Date.now()
  const epoch = getUsageCredentialEpoch()
  const record = getUsageRecordVersion()
  if (
    otherUsagesCache !== null &&
    otherUsagesCache.primary === primary.provider &&
    otherUsagesCache.epoch === epoch &&
    otherUsagesCache.record === record &&
    now - otherUsagesCache.atMs < OTHER_USAGES_CACHE_MS
  ) {
    return { primary, others: otherUsagesCache.value }
  }
  const value = deriveOtherWindowUsages(primary.provider, undefined)
  otherUsagesCache = { primary: primary.provider, atMs: now, epoch, record, value }
  return { primary, others: value }
}

function deriveOtherWindowUsages(
  primary: ProviderFamilyId | 'unrecognised',
  reads: ActiveUsageReads | undefined,
): ActiveSourceUsage[] {
  const others: ActiveSourceUsage[] = []
  for (const provider of ALL_FAMILIES) {
    if (provider === primary) continue
    const u = usageForProvider(provider, reads)
    if (u.windows.some(w => w.state === 'live')) others.push(u)
  }
  return others
}

const API_KEY_USAGE_ABSENCE_NOTE =
  'no usage endpoint is read for an API key on this lane — the provider console is the view'

function deriveActiveSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  const reads = opts?.reads
  const model = opts?.model ?? getEngineModel()
  const provider = (reads?.route ?? ((m: string) => declaredRouteOf(m) ?? 'unrecognised'))(model)
  const rental = reads === undefined && provider === 'openai-compat' ? hostRentalUsage(model) : undefined
  const view = { ...usageForProvider(provider, reads), ...(rental ? { rental } : {}) }
  const binding = bindingWindowOf(view, model)
  return binding !== undefined ? { ...view, binding } : view
}

export function usageForProvider(
  provider: ProviderFamilyId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const view = deriveUsageForProvider(provider, reads)
  if (view.sourceKind === 'none' || view.carry !== undefined) return view
  return { ...view, carry: CARRY_UNSTATED }
}

function deriveUsageForProvider(
  provider: ProviderFamilyId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const spend = provider === 'unrecognised' ? spendForRoute(provider) : (reads?.spend ?? spendForRoute)(provider)

  if (provider === 'zai') return zaiUsageView(provider, spend, reads)

  if (provider === 'openrouter') return openrouterUsageView(provider, spend, reads)

  if (provider === 'gemini') return geminiUsageView(provider, spend, reads)

  if (provider === 'huggingface') return huggingfaceUsageView(provider, spend, reads)

  if (provider === 'local') return localUsageView(provider, spend, reads)

  if (provider === 'moonshot') return moonshotUsageView(provider, spend, reads)

  if (provider === 'xai') return xaiUsageView(provider, spend, reads)
  if (provider === 'meta') return metaUsageView(provider, spend, reads)
  if (provider === 'mistral') return mistralUsageView(provider, spend, reads)
  if (provider === 'nous') return nousUsageView(provider, spend, reads)
  if (provider === 'zen') return zenUsageView(provider, spend, reads)
  if (provider === 'minimax') return minimaxUsageView(provider, spend, reads)
  if (provider === 'together' || provider === 'cohere') return togetherUsageView(provider, spend, reads)
  if (provider === 'groq') {
    const { groqUsageView } = require('./groq/groqUsageState.js') as typeof import('./groq/groqUsageState.js')
    return groqUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'melious') {
    const { meliousUsageView } = require('./melious/meliousUsageState.js') as typeof import('./melious/meliousUsageState.js')
    return meliousUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'orcarouter') {
    const { orcarouterUsageView } = require('./orcarouter/orcarouterUsageState.js') as typeof import('./orcarouter/orcarouterUsageState.js')
    return orcarouterUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'cerebras') {
    const { cerebrasUsageView } = require('./cerebras/cerebrasUsageState.js') as typeof import('./cerebras/cerebrasUsageState.js')
    return cerebrasUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'fireworks') {
    const { fireworksUsageView } = require('./fireworks/fireworksUsageState.js') as typeof import('./fireworks/fireworksUsageState.js')
    return fireworksUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'qwen') {
    const { qwenUsageView } = require('./qwen/qwenUsageState.js') as typeof import('./qwen/qwenUsageState.js')
    return qwenUsageView(spend, reads?.laneCredentialed?.(provider))
  }
  if (provider === 'deepseek' || provider === 'openai-compat') return deepseekUsageView(provider, spend, reads)

  if (provider === 'unrecognised') {
    const signedIn = (reads?.anySignedIn ?? anyProviderCredentialed)()
    return {
      provider,
      sourceKind: 'none',
      label: signedIn ? 'Unrecognised model usage' : 'Usage',
      shape: 'none',
      windows: [],
      pools: [],
      spend,
      whyNot: signedIn ? 'no provider family declares the session model — /model picks a listed row' : 'not signed in — /logins signs in',
    }
  }
  const entry = (reads?.activeEntry ?? activeWalletEntry)(provider)
  if (entry === undefined) {
    const title = providerDisplayName(provider)
    const whyNot = `not connected — /logins connects ${title}`
    return { provider, sourceKind: 'none', label: `${title} usage`, shape: 'none', windows: [], pools: [], spend, whyNot }
  }
  if (entry.kind === 'api-key') {
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      tier: API_BILLING_TIER,
      absence: API_KEY_USAGE_ABSENCE_NOTE,
    }
  }
  if (provider === 'anthropic') {
    const plan = (reads?.anthropicPlan ?? getSubscriptionType)()
    const reader = reads === undefined ? liveAnthropicReaderWords() : {}
    const limited = anthropicLimitedWindow(reads)
    return {
      provider,
      sourceKind: 'subscription-oauth',
      label: 'Anthropic usage',
      shape: 'subscription-windows',
      windows: anthropicWindowViews(reads),
      pools: anthropicPoolWindowViews(reads),
      credits: anthropicExtraUsageCredits(reads),
      carry: anthropicExtraUsageCarry(reads),
      spend,
      ...(limited !== undefined ? { limited } : {}),
      tier: plan ? `Claude ${planWord(plan)}` : 'Claude subscription',
      ...(reader.note !== undefined ? { readerNote: reader.note } : {}),
      ...(reader.compact !== undefined ? { readerNoteCompact: reader.compact } : {}),
      ...(reader.record !== undefined ? { readerRecord: reader.record } : {}),
      ...(reader.wait === true ? { readerWait: true } : {}),
    }
  }
  const limitedWindow = (reads?.openaiLimited ?? (() => openaiLimitWindow('chatgpt-subscription')))()
  const openaiPlan = entry.identity?.plan
  return {
    provider,
    sourceKind: 'subscription-oauth',
    label: 'OpenAI usage',
    shape: 'subscription-windows',
    windows: openaiWindowViews(reads),
    pools: [],
    credits: openaiSubscriptionCredits(reads),
    carry: openaiCreditsCarry(reads),
    ...(reads === undefined ? openaiUsageReaderState() : {}),
    spend,
    tier: openaiPlan ? `ChatGPT ${planWord(openaiPlan)}` : 'ChatGPT subscription',
    ...(limitedWindow.state === 'limited' ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } } : {}),
  }
}

function liveAnthropicReaderWords(): { note?: string; compact?: string; record?: string; wait?: boolean } {
  try {
    const { anthropicUsageReaderNote, anthropicUsageReadStatus, isServerWait, usageReaderRecordWords } =
      require('./anthropic/anthropicUsageState.js') as typeof import('./anthropic/anthropicUsageState.js')
    const now = Date.now()
    const note = anthropicUsageReaderNote(now, 'prose')
    const compact = anthropicUsageReaderNote(now, 'compact')
    const record = usageReaderRecordWords()
    const wait = isServerWait(anthropicUsageReadStatus().failure)
    return {
      ...(note !== undefined ? { note } : {}),
      ...(compact !== undefined ? { compact } : {}),
      ...(record !== undefined ? { record } : {}),
      ...(wait ? { wait: true } : {}),
    }
  } catch (error) {
    passedOver(error)
    return {}
  }
}

export function providerUsageView(provider: UsageProvider): ProviderUsageView {
  const entries = walletEntries().filter(e => e.provider === provider)
  const activeEntry = activeWalletEntry(provider)
  if (provider === 'anthropic') {
    return {
      provider,
      ...(activeEntry ? { activeEntry } : {}),
      entries,
      sessionSpend: spendForRoute('anthropic'),
      limits: { kind: 'anthropic-windows', status: currentLimits.status, raw: getRawUtilization() },
    }
  }
  return {
    provider,
    ...(activeEntry ? { activeEntry } : {}),
    entries,
    sessionSpend: spendForRoute('openai'),
    limits: {
      kind: 'openai-observed',
      window: openaiLimitWindow(activeEntry?.kind === 'api-key' ? 'api-key' : 'chatgpt-subscription'),
    },
  }
}
