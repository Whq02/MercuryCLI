import { getModelUsage, getUnpricedTurns, getWorkloadUnpricedTurns, getWorkloadUsage, type ModelUsage } from '../../bootstrap/state.js'
import type { ModelSpendRowV1, UsageFactsV1 } from '../engine-connector/types.js'
import { formatLaneSpend } from '../../utils/spendSpelling.js'
import { formatTokens } from '../../utils/format.js'
import { WORKLOAD_ADVISOR, WORKLOAD_CRON } from '../../utils/workloadContext.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  getSubscriptionType,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getEngineModel } from '../../utils/model/model.js'
import { modelPricingBasis } from '../../utils/modelCost.js'
import { buildRouterModelSnapshot, type RouterModelSnapshot } from '../../utils/router/modelRegistry.js'
import { resolveZaiDispatch } from '../../utils/router/providerDiscovery.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import { formatClock, formatCountdown, quotaWindows, type QuotaWindow } from '../../utils/cockpit/quota.js'
import {
  currentLimits,
  getEndpointExtraUsage,
  getRawUtilization,
  getUsageCredentialEpoch,
  getUsageRecordVersion,
  WEEKLY_POOL_CLAIMS,
  weeklyPoolClaimForModel,
  type AnthropicExtraUsageRecord,
  type AnthropicMoney,
  type AnthropicLimits,
  type RateLimitType,
  type WeeklyPoolClaim,
} from '../anthropicLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { subscribeSignInEpoch } from '../../utils/accounts/signInLedger.js'
import { activeWalletEntry, anthropicCredentialAccount, walletEntries, type WalletEntry } from '../wallet/wallet.js'
import { accountIdentityShown, familyAccountWord } from '../wallet/identityWords.js'
import { providerDisplayName } from './routeLaw.js'
import { declaredRouteOf, PROVIDER_ID_SPACES } from './callModelRouter.js'
import {
  NO_USAGE_READ_WORDS,
  usageAgeWords,
  usageFreshHorizonMs,
  usageFreshness,
  usagePollTtlMs,
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
import { readMintedOpenrouterKey, resolveOpenrouterApiKey, type OpenrouterKeySource } from './openrouter/openrouterAccounts.js'
import {
  openrouterLimitWindow,
  openrouterObservedKeyUsage,
  openrouterLowBalanceNote,
  refreshOpenrouterKeyUsage,
  type OpenrouterKeyUsage,
  type OpenrouterLimitWindow,
} from './openrouter/openrouterUsageState.js'
import {
  resolveGeminiAccount,
  type GeminiAccountRef,
} from './gemini/geminiAccounts.js'
import { GEMINI_USAGE_ABSENCE_NOTE, geminiLimitWindow, type GeminiLimitWindow } from './gemini/geminiUsageState.js'
import {
  resolveHuggingfaceAccount,
  type HuggingfaceAccountRef,
} from './huggingface/huggingfaceAccounts.js'
import {
  HUGGINGFACE_USAGE_ABSENCE_NOTE,
  huggingfaceAccountFactsFailure,
  huggingfaceAccountFactsFailureWords,
  huggingfaceLimitWindow,
  huggingfaceObservedAccountFacts,
  huggingfaceObservedRate,
  refreshHuggingfaceAccountFacts,
  type HuggingfaceAccountFacts,
  type HuggingfaceAccountFactsFailure,
  type HuggingfaceLimitWindow,
} from './huggingface/huggingfaceUsageState.js'
import { resolveLocalAccount, type LocalAccountRef } from './local/localAccounts.js'
import { refreshLocalDiscovery } from './local/localDiscovery.js'
import { resolveXaiManagementApiKey } from './xai/xaiAccounts.js'
import { refreshXaiSubscriptionCredits, refreshXaiUsage, xaiObservedSubscriptionCredits, xaiObservedUsage, xaiUsageFailureWords, XAI_MANAGEMENT_KEY_HINT, type XaiSubscriptionCredits } from './xai/xaiUsageState.js'

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
  id: RouterProviderId
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
  engineIdentity?: (id: RouterProviderId) => string | undefined
}

export function presenceIdentityWords(
  presence: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'> & { id: string },
  shown: boolean = accountIdentityShown(),
): string | undefined {
  if (!presence.credentialed) return undefined
  if (shown || presence.identity === undefined) return presence.identity ?? presence.credentialLabel
  return familyAccountWord(presence.id) ?? 'signed in'
}

function engineIdentityLive(id: RouterProviderId): string | undefined {
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
    if (id === 'huggingface') return resolveHuggingfaceAccount()?.username
    if (id === 'mistral') {
      const { mistralObservedIdentityWords } = require('./mistral/mistralUsageState.js') as typeof import('./mistral/mistralUsageState.js')
      return mistralObservedIdentityWords()
    }
  } catch {
  }
  return undefined
}

export function anthropicCredentialPresence(
  reads?: ProviderFamilyReads,
): { credentialed: boolean; credentialLabel?: string; identity?: string; expired?: boolean } {
  const subscriber = reads?.claudeSubscriber?.() ?? isClaudeAISubscriber()
  const plan = reads?.subscriptionType?.() ?? getSubscriptionType()
  const keyPresent =
    reads?.anthropicApiKeyPresent?.() ??
    ((): boolean => {
      try {
        return getAnthropicApiKey() !== null
      } catch {
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
    } catch {
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
  } catch {
    return undefined
  }
}

function readBearerTokenSource(): { source: string; hasToken: boolean } {
  try {
    return getAuthTokenSource()
  } catch {
    return { source: 'none', hasToken: false }
  }
}

export function providerFamilyPresences(
  providers: RouterModelSnapshot['providers'] = buildRouterModelSnapshot().providers,
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

export function providerSessionSpend(route: RouterProviderId): ProviderSessionSpend {
  return spendForRoute(route)
}

function spendForRoute(route: RouterProviderId | 'unrecognised'): ProviderSessionSpend {
  const admit = (model: string): boolean => (declaredRouteOf(model) ?? 'unrecognised') === route
  const spend = spendOf(getModelUsage(), getUnpricedTurns(), admit)
  const scheduled = spendOf(scheduledUsage(), scheduledUnpricedTurns(), admit)
  if (scheduled.models > 0) spend.scheduled = scheduled
  const advisor = spendOf(advisorUsage(), advisorUnpricedTurns(), admit)
  if (advisor.models > 0) spend.advisor = advisor
  return spend
}

function spendOfRows(rows: readonly ModelSpendRowV1[], admit: (model: string) => boolean): ProviderSessionSpend {
  const usage: { [modelName: string]: ModelUsage } = {}
  const unpriced: { [modelName: string]: number } = {}
  for (const row of rows) {
    const record = usage[row.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
    record.inputTokens += row.inputTokens
    record.outputTokens += row.outputTokens
    record.cacheReadInputTokens += row.cacheReadInputTokens
    record.cacheCreationInputTokens += row.cacheCreationInputTokens
    record.costUSD += row.costUSD
    usage[row.model] = record
    if (row.unpricedTurns > 0) unpriced[row.model] = (unpriced[row.model] ?? 0) + row.unpricedTurns
  }
  return spendOf(usage, unpriced, admit)
}

export function sessionSpendOfFacts(
  facts: Pick<UsageFactsV1, 'modelSpend'>,
  route: RouterProviderId | 'unrecognised',
): ProviderSessionSpend | null {
  if (facts.modelSpend === undefined) return null
  const admit = (model: string): boolean => (declaredRouteOf(model) ?? 'unrecognised') === route
  const spend = spendOfRows(facts.modelSpend.filter(row => row.workload === undefined), admit)
  const scheduled = spendOfRows(facts.modelSpend.filter(row => row.workload === WORKLOAD_CRON), admit)
  if (scheduled.models > 0) spend.scheduled = scheduled
  const advisor = spendOfRows(facts.modelSpend.filter(row => row.workload === WORKLOAD_ADVISOR), admit)
  if (advisor.models > 0) spend.advisor = advisor
  return spend
}

export interface ModelSessionSpend {
  model: string
  spend: ProviderSessionSpend
}

export function sessionSpendByModel(
  facts: Pick<UsageFactsV1, 'modelSpend'>,
  route: RouterProviderId | 'unrecognised',
): ModelSessionSpend[] {
  if (facts.modelSpend === undefined) return []
  const own = facts.modelSpend.filter(row => row.workload === undefined && (declaredRouteOf(row.model) ?? 'unrecognised') === route)
  const out: ModelSessionSpend[] = []
  for (const row of own) {
    if (out.some(entry => entry.model === row.model)) continue
    out.push({ model: row.model, spend: spendOfRows(own.filter(r => r.model === row.model), () => true) })
  }
  return out
}

function scheduledUsage(): { [modelName: string]: ModelUsage } {
  return getWorkloadUsage()[WORKLOAD_CRON] ?? {}
}

function scheduledUnpricedTurns(): { [modelName: string]: number } {
  return getWorkloadUnpricedTurns()[WORKLOAD_CRON] ?? {}
}

function advisorUsage(): { [modelName: string]: ModelUsage } {
  return getWorkloadUsage()[WORKLOAD_ADVISOR] ?? {}
}

function advisorUnpricedTurns(): { [modelName: string]: number } {
  return getWorkloadUnpricedTurns()[WORKLOAD_ADVISOR] ?? {}
}

export function scheduledSessionSpend(): ProviderSessionSpend {
  return spendOf(scheduledUsage(), scheduledUnpricedTurns(), () => true)
}

export function advisorSessionSpend(): ProviderSessionSpend {
  return spendOf(advisorUsage(), advisorUnpricedTurns(), () => true)
}

export const ADVISOR_WORK_WORD = 'advisor'

export function advisorUsageLine(): string | null {
  const spend = advisorSessionSpend()
  if (spend.models === 0) return null
  return `${ADVISOR_WORK_WORD} ${formatTokens(spend.inputTokens + spend.outputTokens)} spent · ${formatLaneSpend(spend)}`
}

export const SCHEDULED_WORK_WORD = 'scheduled'

export function scheduledUsageLine(): string | null {
  const spend = scheduledSessionSpend()
  if (spend.models === 0) return null
  return `${SCHEDULED_WORK_WORD} ${formatTokens(spend.inputTokens + spend.outputTokens)} spent · ${formatLaneSpend(spend)}`
}

function spendOf(
  usage: { [modelName: string]: ModelUsage },
  unpriced: { [modelName: string]: number },
  admit: (model: string) => boolean,
): ProviderSessionSpend {
  const spend: ProviderSessionSpend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  let estimatedModels = 0
  let unpricedModels = 0
  let unpricedTurns = 0
  for (const [model, record] of Object.entries(usage)) {
    if (!admit(model)) continue
    spend.models += 1
    spend.inputTokens += record.inputTokens + record.cacheReadInputTokens + record.cacheCreationInputTokens
    spend.outputTokens += record.outputTokens
    spend.costUSD += record.costUSD
    const turns = unpriced[model] ?? 0
    if (turns > 0) {
      unpricedModels += 1
      unpricedTurns += turns
    } else {
      const basis = modelPricingBasis(model)
      if (basis === 'floor' || basis === 'family-estimate') estimatedModels += 1
    }
  }
  if (estimatedModels > 0 || unpricedTurns > 0) spend.pricing = { estimatedModels, unpricedModels, unpricedTurns }
  return spend
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

export const CREDITS_UNREPORTED_WORDS = 'not reported by the provider'

export interface UsageCarryView {
  state: 'carries' | 'nothing' | 'unstated'
  display: string
  compact: string
  source?: UsageFeed
  observedAtMs?: number
  freshForMs?: number
}

export const CARRY_NOTHING_TAIL = 'nothing carries requests until the reset'
export const CARRY_UNSTATED_WORDS = 'the provider states nothing about what carries requests past the window'
export const CARRY_UNSTATED_COMPACT = 'past window: not stated'
const CARRY_UNSTATED: UsageCarryView = { state: 'unstated', display: CARRY_UNSTATED_WORDS, compact: CARRY_UNSTATED_COMPACT }

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
  provider: RouterProviderId | 'unrecognised'
  sourceKind: 'subscription-oauth' | 'oauth' | 'api-key' | 'keyless' | 'none'
  label: string
  shape: ActiveUsageShape
  windows: UsageWindowView[]
  pools: UsageWindowView[]
  binding?: UsageBindingView
  credits?: UsageCreditsView
  carry?: UsageCarryView
  spend: ProviderSessionSpend
  limited?: { resetsAtMs: number }
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
}

export interface ActiveUsageReads {
  route?: (model: string) => RouterProviderId
  activeEntry?: (provider: UsageProvider) => WalletEntry | undefined
  anthropicWindows?: () => { fiveHour: QuotaWindow; sevenDay: QuotaWindow }
  anthropicPoolWindows?: () => UsageWindowView[]
  anthropicExtraUsage?: () => AnthropicExtraUsageRecord | null
  anthropicLimits?: () => AnthropicLimits
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
  laneCredentialed?: (provider: RouterProviderId) => boolean
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
  spend?: (route: RouterProviderId) => ProviderSessionSpend
  anthropicPlan?: () => string | null
}

export interface DeepseekObservedBalanceView {
  observedAtMs: number
  isAvailable: boolean
  balances: { currency: string; totalBalance: string }[]
}

export interface UsageRefreshIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}

export async function refreshProviderUsage(provider: RouterProviderId, io?: UsageRefreshIo): Promise<void> {
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
      default:
        return
    }
  } catch {
  }
}

let shownMeters = 0
let shownFamily: (() => RouterProviderId | 'unrecognised') | null = null
let unsubscribeSignIns: (() => void) | null = null

function readShownFamily(reason: 'open' | 'sign-in'): void {
  const family = shownFamily?.() ?? 'unrecognised'
  if (family === 'unrecognised') return
  void refreshProviderUsage(family, { reason })
}

export function watchProviderUsageWhileShown(opts: { family: () => RouterProviderId | 'unrecognised' }): () => void {
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

function laneCredentialedLive(provider: RouterProviderId): boolean {
  if (provider === 'xai') {
    const { resolveXaiAccount } = require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')
    return resolveXaiAccount() !== undefined
  }
  if (provider === 'meta') {
    const { resolveMetaApiKey } = require('./meta/metaAccounts.js') as typeof import('./meta/metaAccounts.js')
    return resolveMetaApiKey() !== undefined
  }
  if (provider === 'mistral') {
    const { resolveMistralApiKey } = require('./mistral/mistralAccounts.js') as typeof import('./mistral/mistralAccounts.js')
    return resolveMistralApiKey() !== undefined
  }
  if (provider === 'deepseek') {
    const { resolveDeepseekApiKey } =
      require('./deepseek/deepseekAccounts.js') as typeof import('./deepseek/deepseekAccounts.js')
    return resolveDeepseekApiKey() !== undefined
  }
  if (provider === 'openai-compat') {
    const { resolveCompatSlotConfig } =
      require('./openaicompat/compatAccounts.js') as typeof import('./openaicompat/compatAccounts.js')
    return resolveCompatSlotConfig() !== undefined
  }
  return false
}

function liveDeepseekBalance(): DeepseekObservedBalanceView | null {
  const { deepseekObservedBalance } =
    require('./deepseek/deepseekUsageState.js') as typeof import('./deepseek/deepseekUsageState.js')
  return deepseekObservedBalance()
}

function liveMoonshotBalance(): MoonshotObservedBalanceView | null {
  const { moonshotObservedBalance } =
    require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
  return moonshotObservedBalance()
}

function liveMoonshotAccount(): { kind: 'kimi-oauth' | 'api-key' } | undefined {
  const { resolveMoonshotAccount } =
    require('./moonshot/moonshotAccounts.js') as typeof import('./moonshot/moonshotAccounts.js')
  return resolveMoonshotAccount()
}

function liveKimiManagedUsage(): KimiManagedUsageView | null {
  const { kimiObservedManagedUsage } =
    require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')
  return kimiObservedManagedUsage()
}

export function zaiAccountFacts(): { plan: 'general' | 'coding'; source: 'env' | 'stored' } | undefined {
  const dispatch = resolveZaiDispatch()
  return dispatch ? { plan: dispatch.plan, source: dispatch.source } : undefined
}

function liveZaiQuota(): ZaiObservedQuotaView | null {
  const { zaiObservedQuota } = require('./zai/zaiUsageState.js') as typeof import('./zai/zaiUsageState.js')
  return zaiObservedQuota()
}

function liveZaiQuotaFailure(): ZaiQuotaFailureView | null {
  const { zaiLastQuotaFailure } = require('./zai/zaiUsageState.js') as typeof import('./zai/zaiUsageState.js')
  return zaiLastQuotaFailure()
}

export function zaiQuotaWindowViews(quota: ZaiObservedQuotaView | null): UsageWindowView[] {
  if (!quota) return []
  const seen = new Map<string, number>()
  const credit = quota.windows
    .filter(w => w.kind === 'credit')
    .sort((a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY))
  return credit.map(w => {
    const label = w.windowMinutes === 7 * 24 * 60 ? '7d' : usageWindowLabel(w.windowMinutes)
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      usedPct: w.usedPct,
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: quota.observedAtMs,
      source: 'endpoint',
    }
  })
}

export function zaiQuotaFigures(quota: ZaiObservedQuotaView | null): UsageFigureView[] {
  if (!quota) return []
  const stamp = { observedAtMs: quota.observedAtMs, source: 'endpoint' as const, freshForMs: usageStaleAfterMs() }
  return quota.windows
    .filter(w => w.kind === 'tool-calls')
    .map(w => ({
      key: 'tool-calls',
      label: 'MCP tool calls this month',
      value: w.used !== undefined && w.limit !== undefined ? `${w.used} of ${w.limit}` : `${Math.round(w.usedPct)}% used`,
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      ...stamp,
    }))
}

export function kimiManagedWindowViews(usage: KimiManagedUsageView | null): UsageWindowView[] {
  if (!usage) return []
  const seen = new Map<string, number>()
  const view = (w: KimiUsageWindowView, fallbackLabel: string): UsageWindowView => {
    const label = w.windowMinutes === 7 * 24 * 60 ? '7d' : w.windowMinutes !== undefined ? usageWindowLabel(w.windowMinutes) : fallbackLabel
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    const usedPct = w.usedRatio !== undefined ? w.usedRatio * 100 : w.used !== undefined && w.limit !== undefined && w.limit > 0 ? (w.used / w.limit) * 100 : undefined
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      ...(usedPct !== undefined ? { usedPct: Math.min(100, Math.max(0, usedPct)) } : {}),
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: usage.observedAtMs,
      source: 'endpoint',
    }
  }
  const windows = [...usage.windows].sort(
    (a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY),
  )
  const views = windows.map(w => view(w, w.name ?? 'win'))
  if (usage.quota) views.push(view(usage.quota, 'quota'))
  return views
}

export function usageWindowLabel(windowMinutes?: number): string {
  if (windowMinutes === undefined) return 'win'
  if (windowMinutes >= 6 * 24 * 60) return 'wk'
  if (windowMinutes >= 24 * 60) return `${Math.round(windowMinutes / (24 * 60))}d`
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`
  return `${Math.round(windowMinutes)}m`
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
  if (view.limited !== undefined) return 'wall'
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


export function openrouterObservedWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
  const usage = observed.usage
  if (!usage) return []
  const { limit, limitRemaining } = usage
  if (typeof limit !== 'number' || limit <= 0 || typeof limitRemaining !== 'number') return []
  const usedPct = Math.min(100, Math.max(0, ((limit - limitRemaining) / limit) * 100))
  return [
    {
      key: 'cap',
      label: 'cap',
      state: 'live',
      usedPct,
      observedAtMs: usage.observedAtMs,
      source: 'endpoint',
    },
  ]
}

function openrouterCredits(observed: { usage: OpenrouterKeyUsage | null; lastError?: string }): UsageCreditsView {
  const usage = observed.usage
  if (usage === null) {
    return observed.lastError !== undefined
      ? { state: 'unreported', reason: 'not read — see the failed key slot', compact: 'not read' }
      : { state: 'unreported', reason: 'not read yet — /usage samples the key endpoint', compact: 'not read yet' }
  }
  if (typeof usage.limitRemaining === 'number') {
    return {
      state: 'reported',
      display: `${usage.limitRemaining.toFixed(2)} remaining under the key cap`,
      compact: `cap ${usage.limitRemaining.toFixed(2)}`,
      source: 'endpoint',
      observedAtMs: usage.observedAtMs,
      freshForMs: usageStaleAfterMs(),
    }
  }
  if (usage.limit === null) {
    return {
      state: 'unreported',
      reason: 'the key endpoint states no balance for an uncapped key — the OpenRouter dashboard is the view',
      compact: 'not stated',
    }
  }
  return { state: 'unreported', reason: 'the key endpoint stated no cap or balance', compact: 'not stated' }
}

function kimiManagedCredits(usage: KimiManagedUsageView | null, error?: string): UsageCreditsView {
  if (usage === null) return { state: 'unreported', reason: error ?? 'not read yet — /usage samples Kimi /usages', compact: error ? 'not read' : 'not read yet' }
  if (usage.extraUsage === undefined) return {
    state: 'unreported',
    reason: 'Kimi /usages states no Extra Usage balance with a currency — Kimi Code Console shows membership billing',
    compact: 'not stated',
  }
  const amount = `${usage.extraUsage.currency} ${usage.extraUsage.balance}`
  return { state: 'reported', display: `${amount} Extra Usage balance`, compact: `${amount} extra`, source: 'endpoint', observedAtMs: usage.observedAtMs, freshForMs: usageStaleAfterMs() }
}

export const KIMI_EXTRA_USAGE_NOT_READ_WORDS = 'Extra Usage not read yet — /usage samples Kimi /usages'
export const KIMI_EXTRA_USAGE_UNSTATED_WORDS = 'no Extra Usage balance stated — Kimi Code Console shows membership billing'

function kimiExtraUsageCarry(usage: KimiManagedUsageView | null, error?: string): UsageCarryView {
  if (usage === null) return { state: 'unstated', display: error ?? KIMI_EXTRA_USAGE_NOT_READ_WORDS, compact: error ? 'Extra Usage not read' : 'Extra Usage not read yet' }
  const stamp = { source: 'endpoint' as const, observedAtMs: usage.observedAtMs, freshForMs: usageStaleAfterMs() }
  if (usage.extraUsage === undefined) return { state: 'unstated', display: KIMI_EXTRA_USAGE_UNSTATED_WORDS, compact: 'Extra Usage not stated', ...stamp }
  const amount = `${usage.extraUsage.currency} ${usage.extraUsage.balance}`
  const value = Number(usage.extraUsage.balance)
  if (Number.isFinite(value) && value <= 0) return { state: 'nothing', display: `Extra Usage balance ${amount} — ${CARRY_NOTHING_TAIL}`, compact: `Extra Usage ${amount}`, ...stamp }
  return { state: 'carries', display: `on Extra Usage · ${amount} left`, compact: `on Extra Usage ${amount}`, ...stamp }
}

export function xaiSubscriptionWindowViews(pool: XaiSubscriptionCredits | null): UsageWindowView[] {
  if (!pool || pool.usedPercent === undefined) return []
  const type = pool.period?.type ?? ''
  const span = pool.period?.startMs !== undefined && pool.period.endMs !== undefined && pool.period.endMs > pool.period.startMs
    ? (pool.period.endMs - pool.period.startMs) / 60_000
    : type.endsWith('WEEKLY') ? 7 * 24 * 60 : type.endsWith('MONTHLY') ? 30 * 24 * 60 : undefined
  const label = usageWindowLabel(span)
  return [{
    key: label,
    label,
    state: 'live',
    usedPct: Math.min(100, Math.max(0, pool.usedPercent)),
    ...(pool.period?.endMs !== undefined ? { resetsAtMs: pool.period.endMs } : {}),
    observedAtMs: pool.observedAtMs,
    source: 'endpoint',
    freshForMs: usageStaleAfterMs(),
  }]
}

export const XAI_POOL_NOT_READ_WORDS = 'not read yet — /usage samples the Grok pool endpoint'
export const XAI_POOL_UNSTATED_WORDS = 'the Grok pool endpoint stated no included usage for this period'

function xaiSubscriptionCredits(pool: XaiSubscriptionCredits | null, failed: boolean): UsageCreditsView {
  if (pool === null) return { state: 'unreported', reason: failed ? 'not read — see the usage reader note' : XAI_POOL_NOT_READ_WORDS, compact: failed ? 'not read' : 'not read yet' }
  if (pool.prepaidBalanceUsd === undefined) return { state: 'unreported', reason: 'the Grok pool endpoint stated no purchased-credits balance', compact: 'not stated' }
  const amount = `USD ${pool.prepaidBalanceUsd.toFixed(2)}`
  return { state: 'reported', display: `${amount} purchased credits`, compact: `${amount} purchased`, source: 'endpoint', observedAtMs: pool.observedAtMs, freshForMs: usageStaleAfterMs() }
}

export function xaiPurchasedCreditsCarry(pool: XaiSubscriptionCredits | null, failed: boolean): UsageCarryView {
  if (pool === null) return { state: 'unstated', display: failed ? 'not read — see the usage reader note' : XAI_POOL_NOT_READ_WORDS, compact: failed ? 'not read' : 'not read yet' }
  const stamp = { source: 'endpoint' as const, observedAtMs: pool.observedAtMs, freshForMs: usageStaleAfterMs() }
  if (pool.prepaidBalanceUsd === undefined) return { state: 'unstated', display: 'the Grok pool endpoint stated no purchased-credits balance', compact: CARRY_UNSTATED_COMPACT, ...stamp }
  const amount = `USD ${pool.prepaidBalanceUsd.toFixed(2)}`
  if (pool.prepaidBalanceUsd <= 0) return { state: 'nothing', display: `purchased credits ${amount} — ${CARRY_NOTHING_TAIL}`, compact: `purchased credits ${amount}`, ...stamp }
  return { state: 'carries', display: `on purchased credits · ${amount} left`, compact: `on purchased credits ${amount}`, ...stamp }
}

function polledBalanceCredits(balance: { display: string; observedAtMs: number } | undefined): UsageCreditsView {
  return balance !== undefined
    ? { state: 'reported', display: balance.display, compact: balance.display, source: 'endpoint', observedAtMs: balance.observedAtMs, freshForMs: usageStaleAfterMs() }
    : { state: 'unreported', reason: 'not read yet — /usage samples the balance endpoint', compact: 'not read yet' }
}

const CREDITS_UNREPORTED: UsageCreditsView = { state: 'unreported', reason: CREDITS_UNREPORTED_WORDS, compact: 'not reported' }

export function openrouterCreditFacts(reads?: ActiveUsageReads): {
  usage: OpenrouterKeyUsage | null
  lastError?: string
} {
  return (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
}

export function openaiSubscriptionCredits(reads?: ActiveUsageReads): UsageCreditsView {
  const credits = (reads?.openaiObserved ?? openaiSubscriptionUsage)().credits
  if (credits === undefined) return { state: 'unreported', reason: 'not stated on this reply yet', compact: 'not stated yet' }
  const source = credits.source ?? 'headers'
  const stamp = { source, observedAtMs: credits.observedAtMs, freshForMs: (require('./usageFreshness.js') as typeof import('./usageFreshness.js')).usageFreshHorizonMs(source) }
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
    const horizon = (require('./usageFreshness.js') as typeof import('./usageFreshness.js')).usageFreshHorizonMs(stamp.source)
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
      now - activeUsageCache.atMs < ACTIVE_USAGE_CACHE_MS
    ) {
      return activeUsageCache.value
    }
    const value = deriveActiveSourceUsage({ model })
    activeUsageCache = { model, atMs: now, epoch, record, value }
    return value
  }
  return deriveActiveSourceUsage(opts)
}

const ALL_FAMILIES: readonly RouterProviderId[] = ['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)]

const OTHER_USAGES_CACHE_MS = 2_000
let otherUsagesCache: {
  primary: RouterProviderId | 'unrecognised'
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
  primary: RouterProviderId | 'unrecognised',
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

function planWord(plan: string): string {
  return plan.length > 0 ? plan[0]!.toUpperCase() + plan.slice(1) : plan
}

const API_BILLING_TIER = 'API billing'

const ZAI_GENERAL_KEY_ABSENCE_NOTE =
  'No usage road for a general Z.AI key — https://z.ai/manage-apikey/billing is the view'
const ZAI_NO_PLAN_NOTE = 'usage: not on a coding plan'
const COMPAT_USAGE_ABSENCE_NOTE =
  "a custom endpoint publishes no usage Mercury reads — the endpoint's own dashboard is the view"
const API_KEY_USAGE_ABSENCE_NOTE =
  'no usage endpoint is read for an API key on this lane — the provider console is the view'

function openrouterFigures(usage: OpenrouterKeyUsage | null): UsageFigureView[] {
  if (!usage) return []
  const observedAtMs = usage.observedAtMs
  const stamp = { observedAtMs, source: 'endpoint' as const, freshForMs: usageStaleAfterMs() }
  const figures: UsageFigureView[] = []
  if (usage.usage !== undefined) {
    figures.push({ key: 'credits-all-time', label: 'credits used (all-time)', value: usage.usage.toFixed(2), ...stamp })
  }
  if (usage.usageWeekly !== undefined) {
    figures.push({ key: 'credits-week', label: 'credits used this week', value: usage.usageWeekly.toFixed(2), ...stamp })
  }
  if (typeof usage.limitRemaining === 'number') {
    figures.push({ key: 'cap-remaining', label: 'remaining under the key cap', value: usage.limitRemaining.toFixed(2), ...stamp })
  } else if (usage.limit === null) {
    figures.push({ key: 'cap', label: 'key cap', value: 'uncapped', ...stamp })
  }
  if (usage.isFreeTier === true) {
    figures.push({ key: 'tier', label: 'account', value: 'free tier', ...stamp })
  }
  return figures
}

export function huggingfacePlanFigures(facts: HuggingfaceAccountFacts | null): UsageFigureView[] {
  if (facts === null || facts.isPro === undefined) return []
  const label =
    facts.canPay === true ? 'plan · payment method on file' : facts.canPay === false ? 'plan · no payment method' : 'plan'
  return [
    {
      key: 'plan',
      label,
      value: facts.isPro ? 'PRO' : 'free',
      observedAtMs: facts.observedAtMs,
      ...(facts.periodEndMs !== undefined ? { resetsAtMs: facts.periodEndMs } : {}),
      source: 'endpoint',
      freshForMs: usageStaleAfterMs(),
    },
  ]
}

function huggingfaceTier(kind: 'oauth' | 'api-key', facts: HuggingfaceAccountFacts | null): string {
  if (kind !== 'oauth') return API_BILLING_TIER
  if (facts?.isPro === true) return 'Hugging Face PRO'
  if (facts?.isPro === false) return 'Hugging Face free'
  return 'Hugging Face sign-in'
}

function deriveActiveSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  const reads = opts?.reads
  const model = opts?.model ?? getEngineModel()
  const provider = (reads?.route ?? ((m: string) => declaredRouteOf(m) ?? 'unrecognised'))(model)
  const view = usageForProvider(provider, reads)
  const binding = bindingWindowOf(view, model)
  return binding !== undefined ? { ...view, binding } : view
}

export function usageForProvider(
  provider: RouterProviderId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const view = deriveUsageForProvider(provider, reads)
  if (view.sourceKind === 'none' || view.carry !== undefined) return view
  return { ...view, carry: CARRY_UNSTATED }
}

function deriveUsageForProvider(
  provider: RouterProviderId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const spend = provider === 'unrecognised' ? spendForRoute(provider) : (reads?.spend ?? spendForRoute)(provider)

  if (provider === 'zai') {
    const account = reads?.zaiAccount ? reads.zaiAccount() : zaiAccountFacts()
    const keyPresent = reads?.zaiKeyPresent?.() ?? account !== undefined
    if (!keyPresent) {
      return { provider, sourceKind: 'none', label: 'Z.AI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins zai adds a key' }
    }
    if (account?.plan !== 'coding') {
      return { provider, sourceKind: 'api-key', label: 'Z.AI usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_GENERAL_KEY_ABSENCE_NOTE, credits: CREDITS_UNREPORTED }
    }
    const quota = reads?.zaiQuota ? reads.zaiQuota() : liveZaiQuota()
    const failure = reads?.zaiQuotaFailure ? reads.zaiQuotaFailure() : liveZaiQuotaFailure()
    const { isZaiNoPlanFailure, zaiQuotaFailureWords } = require('./zai/zaiUsageState.js') as typeof import('./zai/zaiUsageState.js')
    if (quota === null && failure !== null && isZaiNoPlanFailure(failure)) {
      return { provider, sourceKind: 'api-key', label: 'Z.AI usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_NO_PLAN_NOTE, credits: CREDITS_UNREPORTED }
    }
    const figures = zaiQuotaFigures(quota)
    const note = failure !== null && (quota === null || failure.atMs > quota.observedAtMs) ? zaiQuotaFailureWords(failure) : undefined
    return {
      provider,
      sourceKind: 'api-key',
      label: 'GLM Coding Plan usage',
      shape: 'subscription-windows',
      windows: zaiQuotaWindowViews(quota),
      pools: [],
      spend,
      tier: quota?.level ? `GLM Coding ${planWord(quota.level)}` : 'GLM Coding Plan',
      ...(figures.length > 0 ? { figures } : {}),
      ...(note !== undefined ? { readerNote: note, readerNoteCompact: note } : {}),
    }
  }

  if (provider === 'openrouter') {
    const keyPresent = reads?.openrouterKeyPresent?.() ?? resolveOpenrouterApiKey() !== undefined
    if (!keyPresent) {
      const refused = readMintedOpenrouterKey()?.expiredMessage !== undefined
      return {
        provider, sourceKind: 'none', label: 'OpenRouter usage', shape: 'none', windows: [], pools: [], spend,
        whyNot: refused ? 'no usable key — the OAuth-minted key was refused; /logins adds OpenRouter' : 'not connected — /logins adds OpenRouter',
        ...(refused ? { readerNote: 'OAuth-minted key refused — no usable key', readerNoteCompact: 'OAuth-minted key refused — no usable key' } : {}),
      }
    }
    const limitedWindow = (reads?.openrouterLimited ?? openrouterLimitWindow)()
    const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
    const figures = openrouterFigures(observed.usage)
    const source = observed.errorSource ?? resolveOpenrouterApiKey()?.source
    const slot = source === 'oauth' ? 'OAuth-minted key' : source === 'env' ? 'API key (env)' : 'API key (stored)'
    const readerNote = observed.lastError !== undefined ? `credit truth unavailable for ${slot}` : openrouterLowBalanceNote(observed.usage)
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: openrouterObservedWindowViews(reads),
      pools: [],
      credits: openrouterCredits(observed),
      spend,
      tier: API_BILLING_TIER,
      ...(figures.length > 0 ? { figures } : {}),
      ...(readerNote !== undefined
        ? { readerNote, readerNoteCompact: readerNote }
        : observed.usage !== null && figures.length === 0
          ? { readerNote: 'the key endpoint stated no credit facts' }
          : {}),
      ...(limitedWindow.state === 'limited'
        ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
        : {}),
    }
  }

  if (provider === 'gemini') {
    const account = reads?.geminiAccount ? reads.geminiAccount() : resolveGeminiAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Gemini usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Gemini' }
    }
    const limitedWindow = (reads?.geminiLimited ?? geminiLimitWindow)()
    return {
      provider,
      sourceKind: account.kind === 'oauth' ? 'oauth' : 'api-key',
      label: account.kind === 'oauth' ? 'Gemini usage' : 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      absence: GEMINI_USAGE_ABSENCE_NOTE,
      tier: account.kind === 'oauth' ? 'Google sign-in' : API_BILLING_TIER,
      ...(limitedWindow.state === 'limited'
        ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } }
        : {}),
    }
  }

  if (provider === 'huggingface') {
    const account = reads?.huggingfaceAccount ? reads.huggingfaceAccount() : resolveHuggingfaceAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Hugging Face usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds Hugging Face' }
    }
    const limitedWindow = (reads?.huggingfaceLimited ?? huggingfaceLimitWindow)()
    const rate = reads?.huggingfaceRate ? reads.huggingfaceRate() : huggingfaceObservedRate()
    const facts = reads?.huggingfaceAccountFacts ? reads.huggingfaceAccountFacts() : huggingfaceObservedAccountFacts()
    const factsFailure = reads?.huggingfaceAccountFactsFailure ? reads.huggingfaceAccountFactsFailure() : huggingfaceAccountFactsFailure()
    const figures: UsageFigureView[] = [
      ...(rate
        ? [
            {
              key: 'rate-remaining',
              label: 'requests remaining (stated by the last response)',
              value: String(rate.remaining),
              observedAtMs: rate.observedAtMs,
              ...(rate.resetsAtMs !== undefined ? { resetsAtMs: rate.resetsAtMs } : {}),
              source: 'headers' as const,
            },
          ]
        : []),
      ...huggingfacePlanFigures(facts),
    ]
    const planNote =
      factsFailure !== null && (facts === null || factsFailure.atMs > facts.observedAtMs)
        ? huggingfaceAccountFactsFailureWords(factsFailure)
        : undefined
    return {
      provider,
      sourceKind: account.kind === 'oauth' ? 'oauth' : 'api-key',
      label: account.kind === 'oauth' ? 'Hugging Face usage' : 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: CREDITS_UNREPORTED,
      spend,
      ...(figures.length > 0 ? { figures } : {}),
      absence: HUGGINGFACE_USAGE_ABSENCE_NOTE,
      tier: huggingfaceTier(account.kind, facts),
      ...(planNote !== undefined ? { readerNote: planNote, readerNoteCompact: planNote } : {}),
      ...(limitedWindow.state === 'limited' ? { limited: { resetsAtMs: limitedWindow.resetsAtMs } } : {}),
    }
  }

  if (provider === 'local') {
    const account = reads?.localAccount ? reads.localAccount() : resolveLocalAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Local usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'no local server — start one, or set MERCURY_LOCAL_BASE_URL' }
    }
    return {
      provider,
      sourceKind: account.kind === 'keyless' ? 'keyless' : 'api-key',
      label: 'Local usage',
      shape: 'none',
      windows: [],
      pools: [],
      spend,
      absence: 'local · no metering',
      tier: 'local · no metering',
    }
  }

  if (provider === 'moonshot') {
    const account = reads?.moonshotAccount ? reads.moonshotAccount() : liveMoonshotAccount()
    if (!account) {
      return { provider, sourceKind: 'none', label: 'Moonshot usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins moonshot adds Kimi or a key' }
    }
    if (account.kind === 'kimi-oauth') {
      const managed = reads?.kimiManagedUsage ? reads.kimiManagedUsage() : liveKimiManagedUsage()
      const error = reads?.kimiManagedError ? reads.kimiManagedError() : reads?.kimiManagedUsage ? undefined : (require('./moonshot/moonshotUsageState.js') as typeof import('./moonshot/moonshotUsageState.js')).kimiManagedUsageError()
      return {
        provider,
        sourceKind: 'oauth',
        label: 'Kimi usage',
        shape: 'subscription-windows',
        windows: kimiManagedWindowViews(managed),
        pools: [],
        credits: kimiManagedCredits(managed, error),
        carry: kimiExtraUsageCarry(managed, error),
        ...(error ? { readerNote: error, readerNoteCompact: error } : {}),
        spend,
        tier: 'Kimi sign-in',
      }
    }
    const record = reads?.moonshotBalance?.() ?? liveMoonshotBalance()
    const balance = record
      ? { display: `USD ${record.availableBalance}`, observedAtMs: record.observedAtMs }
      : undefined
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: polledBalanceCredits(balance),
      spend,
      tier: API_BILLING_TIER,
      ...(balance ? { balance } : {}),
    }
  }

  if (provider === 'xai') {
    const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
    if (!credentialed) return { provider, sourceKind: 'none', label: 'xAI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins xai adds a key' }
    const { resolveXaiAccount } = require('./xai/xaiAccounts.js') as typeof import('./xai/xaiAccounts.js')
    if ((reads?.xaiAccount ?? resolveXaiAccount)()?.kind === 'grok-subscription') {
      const { credits: pool, failure: poolFailure } = (reads?.xaiSubscriptionCredits ?? xaiObservedSubscriptionCredits)()
      const windows = xaiSubscriptionWindowViews(pool)
      const note = poolFailure ? xaiUsageFailureWords(poolFailure) : undefined
      return {
        provider, sourceKind: 'subscription-oauth', label: 'Grok subscription', shape: 'subscription-windows', windows, pools: [], spend,
        tier: pool?.tier ?? 'Grok subscription', credits: xaiSubscriptionCredits(pool, poolFailure !== null),
        carry: xaiPurchasedCreditsCarry(pool, poolFailure !== null),
        ...(pool && windows.length === 0 ? { absence: XAI_POOL_UNSTATED_WORDS } : {}),
        ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
      }
    }
    const management = reads?.xaiManagementKeyPresent?.() ?? resolveXaiManagementApiKey() !== undefined
    if (!management) return {
      provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
      credits: { state: 'unreported', reason: 'not read — a management key unlocks the team balance', compact: 'needs management key' },
      absence: XAI_MANAGEMENT_KEY_HINT,
    }
    const { usage, failure } = (reads?.xaiObserved ?? xaiObservedUsage)()
    const stamp = { source: 'endpoint' as const, observedAtMs: usage?.observedAtMs, freshForMs: usageStaleAfterMs() }
    const balance = usage ? { display: `USD ${usage.prepaidBalanceUsd.toFixed(2)} prepaid`, observedAtMs: usage.observedAtMs } : undefined
    const figures: UsageFigureView[] = []
    if (usage) {
      const cycle = `${usage.cycle.year}-${String(usage.cycle.month).padStart(2, '0')}`
      figures.push({ key: 'team-cycle', label: `team usage (${cycle}${usage.partial ? ', partial' : ''})`, value: `USD ${usage.usageUsd.toFixed(2)}`, ...stamp })
      if (usage.postpaidInvoiceUsd !== undefined) figures.push({ key: 'postpaid-preview', label: 'postpaid invoice preview (with VAT)', value: `USD ${usage.postpaidInvoiceUsd.toFixed(2)}`, ...stamp })
      if (usage.postpaidLimitUsd !== undefined) figures.push({ key: 'postpaid-limit', label: 'postpaid spending limit', value: `USD ${usage.postpaidLimitUsd.toFixed(2)}`, ...stamp })
    }
    const note = failure ? xaiUsageFailureWords(failure) : usage?.partial ? 'usage query returned only part of the results — this is not a spending-limit signal' : undefined
    return {
      provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
      credits: balance ? polledBalanceCredits(balance) : { state: 'unreported', reason: failure ? 'not read — see the usage reader note' : 'not read yet — /usage samples the Management API', compact: 'not read' },
      ...(balance ? { balance } : {}),
      ...(figures.length ? { figures } : {}),
      ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
    }
  }
  if (provider === 'meta') {
    const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
    const { META_USAGE_ABSENCE } = require('./meta/metaUsageState.js') as typeof import('./meta/metaUsageState.js')
    return credentialed
      ? { provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], credits: CREDITS_UNREPORTED, spend, tier: API_BILLING_TIER, absence: META_USAGE_ABSENCE }
      : { provider, sourceKind: 'none', label: 'Meta usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins meta adds a key' }
  }
  if (provider === 'mistral') {
    const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
    if (!credentialed) return { provider, sourceKind: 'none', label: 'Mistral usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins mistral adds a key' }
    const state = require('./mistral/mistralUsageState.js') as typeof import('./mistral/mistralUsageState.js')
    const { resolveMistralAdminApiKey } = require('./mistral/mistralAccounts.js') as typeof import('./mistral/mistralAccounts.js')
    const admin = reads?.mistralAdminKeyPresent?.() ?? resolveMistralAdminApiKey() !== undefined
    const observed = (reads?.mistralObserved ?? state.mistralObservedUsage)()
    const account = observed.identity?.email ?? observed.identity?.name
    const scope = [observed.identity?.organization, observed.identity?.workspace].filter((part): part is string => typeof part === 'string' && part !== '').join(' / ')
    const figures: UsageFigureView[] = []
    const identityNote = observed.failure?.endpoint === 'identity' ? state.mistralUsageFailureWords(observed.failure) : undefined
    if (account) figures.push({ key: 'account', label: 'account', value: scope ? `${account} (${scope})` : account })
    if (!admin) return {
      provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
      credits: { state: 'unreported', reason: 'not read — an Admin API key unlocks the organisation meter', compact: 'needs admin key' },
      absence: state.MISTRAL_ADMIN_KEY_HINT,
      ...(figures.length ? { figures } : {}),
      ...(identityNote ? { readerNote: identityNote, readerNoteCompact: identityNote } : {}),
    }
    const limits = observed.limits
    const stamp = { source: 'endpoint' as const, observedAtMs: limits?.observedAtMs, freshForMs: usageStaleAfterMs() }
    const spent = limits?.totalUsage ?? limits?.usage
    let balance: { display: string; observedAtMs: number } | undefined
    if (limits) {
      if (spent !== undefined) figures.push({ key: 'month-usage', label: 'organisation usage this month', value: `${limits.currency} ${spent.toFixed(2)}`, ...stamp })
      if (limits.vibeUsage !== undefined && limits.vibeUsage > 0) figures.push({ key: 'vibe-usage', label: 'of which Vibe Code usage', value: `${limits.currency} ${limits.vibeUsage.toFixed(2)}`, ...stamp })
      if (limits.noMonthlyLimit) figures.push({ key: 'month-limit', label: 'monthly spend limit', value: 'none set', ...stamp })
      else if (limits.usageLimit !== undefined) {
        figures.push({ key: 'month-limit', label: 'monthly spend limit', value: `${limits.currency} ${limits.usageLimit.toFixed(2)}${limits.monthlyLimitReached ? ' · reached' : ''}`, ...stamp })
        if (spent !== undefined) balance = { display: `${limits.currency} ${Math.max(0, limits.usageLimit - spent).toFixed(2)} left of the monthly limit`, observedAtMs: limits.observedAtMs }
      }
      if (limits.requestsPerSecond !== undefined) figures.push({ key: 'rate-limit', label: 'rate limit', value: `${limits.requestsPerSecond} requests/s`, ...stamp })
      if (limits.lastPaymentFailure) figures.push({ key: 'payment', label: 'last payment', value: 'failed — check admin.mistral.ai', ...stamp })
    }
    const adminNote = observed.failure?.endpoint === 'admin' ? state.mistralUsageFailureWords(observed.failure) : undefined
    const note = adminNote ?? identityNote
    return {
      provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER,
      credits: balance ? polledBalanceCredits(balance) : limits
        ? { state: 'unreported', reason: limits.noMonthlyLimit ? 'no monthly limit is set — usage is the figure' : 'the spend limit read states no figure', compact: limits.noMonthlyLimit ? 'no limit set' : 'not stated' }
        : { state: 'unreported', reason: adminNote ? 'not read — see the usage reader note' : 'not read yet — /usage samples the Admin API', compact: 'not read' },
      ...(balance ? { balance } : {}),
      ...(figures.length ? { figures } : {}),
      ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
    }
  }
  if (provider === 'deepseek' || provider === 'openai-compat') {
    const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
    const uncredentialedLabel = provider === 'deepseek' ? 'DeepSeek usage' : 'Endpoint usage'
    if (!credentialed) {
      const whyNot =
        provider === 'deepseek'
          ? 'not connected — /logins deepseek adds a key'
          : 'not configured — set MERCURY_COMPAT_BASE_URL'
      return { provider, sourceKind: 'none', label: uncredentialedLabel, shape: 'none', windows: [], pools: [], spend, whyNot }
    }
    const record = provider === 'deepseek' ? (reads?.deepseekBalance?.() ?? liveDeepseekBalance()) : null
    const primary = record?.balances[0]
    const balance =
      record && primary
        ? { display: `${primary.currency} ${primary.totalBalance}`, observedAtMs: record.observedAtMs }
        : undefined
    return {
      provider,
      sourceKind: 'api-key',
      label: 'API usage',
      shape: 'api-spend',
      windows: [],
      pools: [],
      credits: provider === 'deepseek' ? polledBalanceCredits(balance) : CREDITS_UNREPORTED,
      spend,
      tier: API_BILLING_TIER,
      ...(balance ? { balance } : {}),
      ...(record && !record.isAvailable
        ? { readerNote: 'the provider marks this account unavailable for inference' }
        : {}),
      ...(provider === 'openai-compat' ? { absence: COMPAT_USAGE_ABSENCE_NOTE } : {}),
    }
  }

  if (provider === 'unrecognised') {
    return {
      provider,
      sourceKind: 'none',
      label: 'Unrecognised model usage',
      shape: 'none',
      windows: [],
      pools: [],
      spend,
      whyNot: 'no provider family declares the session model — /model picks a listed row',
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
  } catch {
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
