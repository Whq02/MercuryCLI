import { getModelUsage, getUnpricedTurns } from '../../bootstrap/state.js'
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { modelPricingBasis } from '../../utils/modelCost.js'
import { buildRouterModelSnapshot, type RouterModelSnapshot } from '../../utils/router/modelRegistry.js'
import { resolveZaiApiKey } from '../../utils/router/providerDiscovery.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import { formatClock, formatCountdown, quotaWindows, type QuotaWindow } from '../../utils/cockpit/quota.js'
import {
  currentLimits,
  getRawUtilization,
  getUsageCredentialEpoch,
  getUsageRecordVersion,
  WEEKLY_POOL_CLAIMS,
  weeklyPoolClaimForModel,
  type RateLimitType,
  type WeeklyPoolClaim,
} from '../claudeAiLimits.js'
import { rateLimitWindowName } from '../rateLimitMessages.js'
import { subscribeSignInEpoch } from '../../utils/accounts/signInLedger.js'
import { activeWalletEntry, walletEntries, type WalletEntry } from '../wallet/wallet.js'
import { providerDisplayName } from './routeLaw.js'
import { declaredRouteOf, PROVIDER_ID_SPACES } from './callModelRouter.js'
import {
  NO_USAGE_READ_WORDS,
  usageFreshness,
  usagePollTtlMs,
  usageSourceWords,
  usageStaleAfterMs,
  usageStaleTail,
  type UsageFeed,
} from './usageFreshness.js'
import {
  openaiLimitWindow,
  openaiObservedUsage,
  type OpenaiLimitWindow,
  type OpenaiObservedUsage,
} from './openai/openaiLimitState.js'
import { resolveOpenrouterApiKey } from './openrouter/openrouterAccounts.js'
import {
  openrouterLimitWindow,
  openrouterObservedKeyUsage,
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
  huggingfaceLimitWindow,
  huggingfaceObservedRate,
  type HuggingfaceLimitWindow,
} from './huggingface/huggingfaceUsageState.js'
import { resolveLocalAccount, type LocalAccountRef } from './local/localAccounts.js'
import { refreshLocalDiscovery } from './local/localDiscovery.js'

export type UsageProvider = 'anthropic' | 'openai'

export interface ProviderSessionSpend {
  inputTokens: number
  outputTokens: number
  costUSD: number
  models: number
  pricing?: { estimatedModels: number; unpricedModels: number; unpricedTurns: number }
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
  presence: Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'>,
): string | undefined {
  if (!presence.credentialed) return undefined
  return presence.identity ?? presence.credentialLabel
}

function engineIdentityLive(id: RouterProviderId): string | undefined {
  try {
    if (id === 'openai') {
      const { resolveOpenaiAccount } =
        require('./openai/openaiAccounts.js') as typeof import('./openai/openaiAccounts.js')
      return resolveOpenaiAccount()?.email
    }
    if (id === 'huggingface') return resolveHuggingfaceAccount()?.username
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
    bearer.hasToken && bearer.source !== 'claude.ai' && bearer.source !== 'apiKeyHelper' && bearer.source !== 'none'
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
  const identity = subscriber ? readAnthropicEmail(reads) : undefined
  return {
    credentialed: credentialLabel !== undefined,
    ...(credentialLabel !== undefined ? { credentialLabel } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(expired ? { expired: true } : {}),
  }
}

function readAnthropicEmail(reads?: ProviderFamilyReads): string | undefined {
  try {
    const email = reads?.anthropicEmail ? reads.anthropicEmail() : getOauthAccountInfo()?.emailAddress
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
  const usage = getModelUsage()
  const unpriced = getUnpricedTurns()
  const spend: ProviderSessionSpend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
  let estimatedModels = 0
  let unpricedModels = 0
  let unpricedTurns = 0
  for (const [model, record] of Object.entries(usage)) {
    if ((declaredRouteOf(model) ?? 'unrecognised') !== route) continue
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
  openaiObserved?: () => OpenaiObservedUsage
  openaiLimited?: () => OpenaiLimitWindow
  zaiKeyPresent?: () => boolean
  openrouterKeyPresent?: () => boolean
  openrouterObserved?: () => { usage: OpenrouterKeyUsage | null; lastError?: string }
  openrouterLimited?: () => OpenrouterLimitWindow
  geminiAccount?: () => GeminiAccountRef | undefined
  geminiLimited?: () => GeminiLimitWindow
  huggingfaceAccount?: () => HuggingfaceAccountRef | undefined
  huggingfaceLimited?: () => HuggingfaceLimitWindow
  huggingfaceRate?: () => { remaining: number; resetsAtMs?: number; observedAtMs: number } | null
  localAccount?: () => LocalAccountRef | undefined
  laneCredentialed?: (provider: RouterProviderId) => boolean
  deepseekBalance?: () => DeepseekObservedBalanceView | null
  moonshotAccount?: () => { kind: 'kimi-oauth' | 'api-key' } | undefined
  moonshotBalance?: () => MoonshotObservedBalanceView | null
  kimiManagedUsage?: () => KimiManagedUsageView | null
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
  reason?: 'poll' | 'turn' | 'operator' | 'sign-in'
}

export async function refreshProviderUsage(provider: RouterProviderId, io?: UsageRefreshIo): Promise<void> {
  try {
    switch (provider) {
      case 'openrouter':
        await refreshOpenrouterKeyUsage(io)
        return
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
      default:
        return
    }
  } catch {
  }
}

let usagePoll: {
  timer: ReturnType<typeof setInterval>
  family: () => RouterProviderId | 'unrecognised'
  unsubscribeSignIns: () => void
} | null = null

export function armProviderUsagePoll(opts: { family: () => RouterProviderId | 'unrecognised' }): () => void {
  if (usagePoll !== null) {
    usagePoll.family = opts.family
  } else {
    const timer = setInterval(() => {
      const family = usagePoll?.family() ?? 'unrecognised'
      if (family === 'unrecognised') return
      void refreshProviderUsage(family, { reason: 'poll' })
    }, usagePollTtlMs())
    timer.unref?.()
    const unsubscribeSignIns = subscribeSignInEpoch(() => {
      const family = usagePoll?.family() ?? 'unrecognised'
      if (family === 'unrecognised') return
      void refreshProviderUsage(family, { reason: 'sign-in' })
    })
    usagePoll = { timer, family: opts.family, unsubscribeSignIns }
  }
  return () => {
    if (usagePoll === null) return
    clearInterval(usagePoll.timer)
    usagePoll.unsubscribeSignIns()
    usagePoll = null
  }
}

export function pokeProviderUsage(): void {
  if (usagePoll === null) return
  const family = usagePoll.family()
  if (family === 'unrecognised') return
  void refreshProviderUsage(family, { reason: 'turn' })
}

export function providerUsagePollArmed(): boolean {
  return usagePoll !== null
}

export interface MoonshotObservedBalanceView {
  observedAtMs: number
  availableBalance: number
}

export interface KimiManagedUsageView {
  observedAtMs: number
  quota?: KimiUsageWindowView
  windows: KimiUsageWindowView[]
}
export interface KimiUsageWindowView {
  name?: string
  windowMinutes?: number
  used: number
  limit: number
  resetsAtMs?: number
}

function laneCredentialedLive(provider: RouterProviderId): boolean {
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

export function kimiManagedWindowViews(usage: KimiManagedUsageView | null): UsageWindowView[] {
  if (!usage) return []
  const seen = new Map<string, number>()
  const view = (w: KimiUsageWindowView, fallbackLabel: string): UsageWindowView => {
    const label = w.windowMinutes !== undefined ? usageWindowLabel(w.windowMinutes) : fallbackLabel
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    return {
      key: count === 1 ? label : `${label}#${count}`,
      label,
      state: 'live',
      ...(w.limit > 0 ? { usedPct: Math.min(100, Math.max(0, (w.used / w.limit) * 100)) } : {}),
      ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}),
      observedAtMs: usage.observedAtMs,
      source: 'endpoint',
    }
  }
  const windows = [...usage.windows].sort(
    (a, b) => (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY),
  )
  const views = windows.map(w => view(w, 'win'))
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
  if (view.limited !== undefined) {
    const reset = usageResetWords(view.limited.resetsAtMs, now)
    parts.push(`limit reached${reset !== undefined ? ` · ${reset}` : ''}`)
  }
  return parts.join(' · ')
}

export function usageViewIsStale(view: UsageWindowView | UsageCreditsView, now: number = Date.now()): boolean {
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
      ? { state: 'unreported', reason: `not read — ${observed.lastError}`, compact: 'not read' }
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

function openaiWindowViews(reads?: ActiveUsageReads): UsageWindowView[] {
  const observed = (reads?.openaiObserved ?? openaiObservedUsage)()
  const bands = [observed.primary, observed.secondary].filter(
    (b): b is NonNullable<typeof b> => b !== undefined && b.usedPct !== undefined,
  )
  bands.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return bands.map(band => {
    const label = usageWindowLabel(band.windowMinutes)
    return {
      key: label,
      label,
      state: 'live' as const,
      usedPct: band.usedPct!,
      ...(band.resetsAtMs !== undefined ? { resetsAtMs: band.resetsAtMs } : {}),
      observedAtMs: band.observedAtMs,
      source: 'headers' as const,
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
    const model = opts?.model ?? getMainLoopModel()
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

const ZAI_USAGE_ABSENCE_NOTE =
  'Z.AI publishes no usage or balance endpoint (its API reference lists none, checked 2026-09-01) — the Z.AI console is the view'
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

function deriveActiveSourceUsage(opts?: {
  model?: string
  reads?: ActiveUsageReads
}): ActiveSourceUsage {
  const reads = opts?.reads
  const model = opts?.model ?? getMainLoopModel()
  const provider = (reads?.route ?? ((m: string) => declaredRouteOf(m) ?? 'unrecognised'))(model)
  const view = usageForProvider(provider, reads)
  const binding = bindingWindowOf(view, model)
  return binding !== undefined ? { ...view, binding } : view
}

export function usageForProvider(
  provider: RouterProviderId | 'unrecognised',
  reads?: ActiveUsageReads,
): ActiveSourceUsage {
  const spend = provider === 'unrecognised' ? spendForRoute(provider) : (reads?.spend ?? spendForRoute)(provider)

  if (provider === 'zai') {
    const keyPresent = reads?.zaiKeyPresent?.() ?? resolveZaiApiKey() !== undefined
    return keyPresent
      ? { provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: API_BILLING_TIER, absence: ZAI_USAGE_ABSENCE_NOTE, credits: CREDITS_UNREPORTED }
      : { provider, sourceKind: 'none', label: 'Z.AI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins zai adds a key' }
  }

  if (provider === 'openrouter') {
    const keyPresent = reads?.openrouterKeyPresent?.() ?? resolveOpenrouterApiKey() !== undefined
    if (!keyPresent) {
      return { provider, sourceKind: 'none', label: 'OpenRouter usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins adds OpenRouter' }
    }
    const limitedWindow = (reads?.openrouterLimited ?? openrouterLimitWindow)()
    const observed = (reads?.openrouterObserved ?? openrouterObservedKeyUsage)()
    const figures = openrouterFigures(observed.usage)
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
      ...(observed.usage === null && observed.lastError !== undefined
        ? { readerNote: `credit truth unavailable (${observed.lastError})` }
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
    const figures: UsageFigureView[] = rate
      ? [
          {
            key: 'rate-remaining',
            label: 'requests remaining (stated by the last response)',
            value: String(rate.remaining),
            observedAtMs: rate.observedAtMs,
            ...(rate.resetsAtMs !== undefined ? { resetsAtMs: rate.resetsAtMs } : {}),
            source: 'headers',
          },
        ]
      : []
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
      tier: account.kind === 'oauth' ? 'Hugging Face sign-in' : API_BILLING_TIER,
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
      return {
        provider,
        sourceKind: 'oauth',
        label: 'Kimi usage',
        shape: 'subscription-windows',
        windows: kimiManagedWindowViews(managed),
        pools: [],
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
