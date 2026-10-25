
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../services/anthropicLimits.js'
import { useSettingsPopupFrameIfAny } from './Settings.js'
import { usagePopupLine } from './usageLine.js'
import { Box, Text, measureElement, useInput, wrapText, type DOMElement } from '../../ink.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { recentSignIns, mostRecentSignInFamily } from '../../utils/model/computedDefault.js'
import { getEngineModel, renderModelName, getUserSpecifiedModelSetting, parseUserSpecifiedModel } from '../../utils/model/model.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import type { ProviderFamilyId } from '../../services/providers/providerAdapter.js'
import {
  CREDITS_UNREPORTED_WORDS,
  anthropicPoolWindowViews,
  anthropicWindowViews,
  openaiObservedWindowViews,
  metaMuseCodeUsage,
  providerFamilyPresences,
  providerSessionSpend,
  providerUsageView,
  refreshProviderUsage,
  sessionSpendByModel,
  sessionSpendOfFacts,
  usageCarryWords,
  usageCreditsLine,
  usageForProvider,
  usageWindowReached,
  zaiAccountFacts,
  type ActiveSourceUsage,
  type ProviderFamilyPresence,
  type ProviderSessionSpend,
  type UsageFigureView,
  type UsageWindowView,
  limitBindsWords,
} from '../../services/providers/providerUsage.js'
import { useFocusedServedEffort, useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { geminiLaneModelsByLastUse, geminiPlanQuotaFoldWords, geminiPlanQuotaUnreportedWords, geminiPlanQuotaView } from '../../services/providers/gemini/geminiPlanQuota.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { providerIdentityLine, providerIdentitySentence, shownIdentityWords } from '../../services/providers/providerIdentityLine.js'
import { openrouterSlots } from '../../services/providers/accountSlots.js'
import { jevRoadWords, jevUsdLabel } from '../../services/jev/jevContract.js'
import { jevCreditsWords } from './Jev.js'
import { type JevKeyPresence, jevKeyPresence } from '../../services/jev/jevKey.js'
import { type JevSessionFacts, jevSessionAbsenceWords, jevSessionFacts, jevSessionFactsStamp, jevSessionStatus, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import { readJevSettings } from '../../services/jev/jevSetting.js'
import { JEV_STATUS_HEADWORDS } from '../../services/jev/jevStatus.js'
import { usageSourceWords } from '../../services/providers/usageFreshness.js'
import { activeWalletEntry, walletEntries } from '../../services/wallet/wallet.js'
import { getGptSeatAvailability } from '../../services/providers/openai/openaiCatalogue.js'
import { readCatalogueIfPending } from '../../services/providers/catalogueOnDemand.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import {
  resolveMoonshotAccount,
  resolveMoonshotApiKey,
} from '../../services/providers/moonshot/moonshotAccounts.js'
import { resolveXaiAccount, resolveXaiApiKey } from '../../services/providers/xai/xaiAccounts.js'
import { resolveHuggingfaceAccount } from '../../services/providers/huggingface/huggingfaceAccounts.js'
import { getHuggingfaceAvailability } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from '../../services/providers/huggingface/huggingfaceCallModel.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { resolveLocalAccount } from '../../services/providers/local/localAccounts.js'
import { LOCAL_SERVER_NAMES } from '../../services/providers/local/localCatalogue.js'
import { LOCAL_SETUP_OFFER } from '../../commands/localsetup/words.js'
import { formatLaneSpend } from '../../cost-tracker.js'
import { usePopupMarker } from '../../context/popupFormContext.js'
import { settingsPopupMarker, settingsPopupWindow } from '../../utils/cockpit/settingsPopup.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { geminiStoredSourcesNote, liveGeminiStoredSourceFacts } from '../../services/providers/gemini/geminiLogin.js'
import { resolveMetaAccount, resolveMetaRawApiKey } from '../../services/providers/meta/metaAccounts.js'
import { liveMetaConnectFacts, metaMuseCodeTierWordsWithAge, metaStoredSourcesNote } from '../../services/providers/meta/metaLogin.js'

const WARN_PCT = 70
const ERROR_PCT = 90
const FULL_BAR_MIN_WIDTH = 62
const FULL_BAR_WIDTH = 50

const UsageLayoutContext = createContext<(() => void) | undefined>(undefined)

function useUsageLayout(): void {
  const measure = useContext(UsageLayoutContext)
  useLayoutEffect(() => { measure?.() })
}

export function humanizeUsageError(body: unknown): string | null {
  let parsed: unknown = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const type = (error as { type?: unknown }).type
  const message = (error as { message?: unknown }).message
  const typeText = typeof type === 'string' ? type : undefined
  const messageText = typeof message === 'string' ? message : undefined
  if (typeText === 'rate_limit_error') {
    return 'rate limited — usage data is temporarily unavailable, retry in a moment'
  }
  if (typeText === 'overloaded_error') {
    return 'the API is overloaded — usage data is temporarily unavailable, retry in a moment'
  }
  if (messageText !== undefined && typeText !== undefined) {
    return `${messageText} (${typeText})`
  }
  if (messageText !== undefined) return messageText
  if (typeText !== undefined) return typeText
  return null
}

function pctOf(limit: RateLimit | null | undefined): number | null {
  if (limit == null || limit.utilization === null) return null
  return Math.floor(limit.utilization)
}

function fillFor(pct: number, tokens: ReturnType<typeof useMercuryTokens>): string {
  if (pct >= ERROR_PCT) return tokens.failure
  if (pct >= WARN_PCT) return tokens.warning
  return tokens.success
}

function resetLineOf(resetsAt: string | null, hideTime: boolean): string | null {
  if (resetsAt === null) return null
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return null
  const text = hideTime
    ? date.toLocaleDateString()
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `resets ${text}`
}

function Meter({
  title,
  limit,
  subtext,
  hideResetTime = false,
  maxWidth,
}: {
  title: string
  limit: RateLimit
  subtext?: string
  hideResetTime?: boolean
  maxWidth?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const pct = pctOf(limit)
  if (pct === null) return null
  const available = Math.max(1, Math.min(maxWidth ?? 80, 80))
  const barWidth = available >= FULL_BAR_MIN_WIDTH ? FULL_BAR_WIDTH : available
  const fill = fillFor(pct, tokens)
  const reset = resetLineOf(limit.resets_at, hideResetTime)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={pct >= WARN_PCT ? fill : undefined}>
        {title} <Text bold={false}>· {pct}%</Text>
      </Text>
      <ProgressBar
        ratio={pct / 100}
        width={barWidth}
        fillColor={fill}
        emptyColor={tokens.surface2}
      />
      {subtext !== undefined ? <Text dimColor>{subtext}</Text> : null}
      {reset !== null ? <Text dimColor>{reset}</Text> : null}
    </Box>
  )
}


function SlotHeading({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return <Text bold color={tokens.textSecondary}>{text}</Text>
}

function IdentityLine({ family }: { family: ProviderFamilyId }): React.ReactNode {
  return <Box flexDirection="column">
    <Text dimColor wrap="truncate-end">{providerIdentitySentence(providerIdentityLine(family))}</Text>
    <UsageCredits usage={usageForProvider(family)} />
  </Box>
}

export const SESSION_SPEND_LABEL = 'This session'
export const SCHEDULED_SPEND_LABEL = 'Scheduled'
export const ADVISOR_SPEND_LABEL = 'Advisor'
export const SESSION_SPEND_NONE = `${SESSION_SPEND_LABEL}: 0 tokens.`

function tokensLine(label: string, spend: ProviderSessionSpend, withCost: boolean): string {
  return `${label}: ${spend.inputTokens.toLocaleString()} input · ${spend.outputTokens.toLocaleString()} output tokens${withCost ? ` · ${formatLaneSpend(spend)}` : ''}`
}

function workloadLines(spend: ProviderSessionSpend, withCost: boolean): string[] {
  const lines: string[] = []
  if (spend.scheduled !== undefined) lines.push(tokensLine(SCHEDULED_SPEND_LABEL, spend.scheduled, withCost))
  if (spend.advisor !== undefined) lines.push(tokensLine(ADVISOR_SPEND_LABEL, spend.advisor, withCost))
  return lines
}

export const MODEL_ROW_INDENT = '  '

export function sessionSpendLines(route: ProviderFamilyId, screenSpend: ProviderSessionSpend, withCost: boolean): string[] {
  const facts = getFocusedSessionConnector().usage()
  const session = sessionSpendOfFacts(facts, route)
  if (session === null) return workloadLines(screenSpend, withCost)
  if (session.models === 0) return [SESSION_SPEND_NONE, ...workloadLines(session, withCost)]
  const perModel = sessionSpendByModel(facts, route).map(entry => `${MODEL_ROW_INDENT}${tokensLine(renderModelName(entry.model), entry.spend, withCost)}`)
  return [tokensLine(SESSION_SPEND_LABEL, session, withCost), ...perModel, ...workloadLines(session, withCost)]
}

function SlotSpend({ active, route, spend, withCost }: { active: boolean; route: ProviderFamilyId; spend: ProviderSessionSpend; withCost: boolean }): React.ReactNode {
  if (!active) return <Text dimColor>{INACTIVE_SLOT_LINE}</Text>
  const lines = sessionSpendLines(route, spend, withCost)
  return lines.length === 0 ? null : <Text dimColor>{lines.join('\n')}</Text>
}

export function absentSlotLine(route: string): string {
  return `none — ${route} · n/a`
}
export const INACTIVE_SLOT_LINE = 'not the active billing source this session'

function ApiKeySlot({
  presentLabel,
  isActive,
  route,
  spend,
  note,
  creditsLine,
}: {
  presentLabel?: string
  isActive: boolean
  route: ProviderFamilyId
  spend: ProviderSessionSpend
  note?: string
  creditsLine?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SlotHeading text="API key" />
      {presentLabel === undefined ? (
        <Text dimColor>{absentSlotLine('a pasted key attaches one')}</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{presentLabel}</Text>
          <SlotSpend active={isActive} route={route} spend={spend} withCost />
          {isActive && creditsLine !== undefined ? <Text dimColor>{creditsLine}</Text> : null}
          {isActive && note !== undefined ? <Text dimColor>{note}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

export function UsageCredits({ usage }: { usage: Pick<ActiveSourceUsage, 'credits'> }): React.ReactNode {
  const line = usageCreditsLine(usage.credits)
  return line === undefined ? null : <Text dimColor>{line}</Text>
}

export function carryTail(usage: Pick<ActiveSourceUsage, 'carry'>): string {
  const words = usageCarryWords(usage.carry)
  return words === undefined ? '' : ` · ${words}`
}

export function fullWindowLine(usage: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited' | 'carry'>, model: string = focusedSessionModelFacts()?.effective ?? getEngineModel()): string | undefined {
  const reached = usageWindowReached(usage)
  if (reached === 'wall' && usage.limited !== undefined) {
    const window = usage.limited.windowName !== undefined ? `The ${usage.limited.windowName}` : 'A usage window'
    return `${window} is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleString()} · ${limitBindsWords(usage.limited.claim, model)}${carryTail(usage)}.`
  }
  return reached === 'full' ? `A usage window reads 100%${carryTail(usage)}.` : undefined
}

function FullWindowLine({ usage }: { usage: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited' | 'carry'> }): React.ReactNode {
  const line = fullWindowLine(usage)
  return line === undefined ? null : <Text dimColor>{line}</Text>
}

function useOwnerUsage(id: ProviderFamilyId, credentialed: boolean): ActiveSourceUsage {
  useUsageLayout()
  const [, setSample] = useState(0)
  useEffect(() => {
    if (!credentialed) return
    let disposed = false
    void refreshProviderUsage(id, { reason: 'open' }).then(() => {
      if (!disposed) setSample(s => s + 1)
    })
    return () => {
      disposed = true
    }
  }, [id, credentialed])
  return usageForProvider(id)
}

function geminiPlanFiguresInOrder(figures: readonly UsageFigureView[]): UsageFigureView[] {
  if (!figures.some(figure => figure.key.startsWith('plan-quota:'))) return [...figures]
  const facts = focusedSessionModelFacts()
  const view = geminiPlanQuotaView(figures, { ...(facts?.effective !== undefined ? { model: facts.effective } : {}), ...(typeof facts?.effort === 'string' ? { effort: facts.effort } : {}), usedModels: geminiLaneModelsByLastUse() })
  const ordered: UsageFigureView[] = figures.filter(figure => !figure.key.startsWith('plan-quota:'))
  if (view.active !== undefined) ordered.push({ ...view.active, label: `${view.active.label} (the session's model)` })
  for (const figure of view.used) ordered.push({ ...figure, label: `${figure.label} (used this session)` })
  for (const entry of view.unreported) ordered.push({ key: `plan-quota-unreported:${entry.model}`, label: `${entry.model} (${entry.active ? "the session's model" : 'used this session'})`, value: 'no quota reported for', source: 'endpoint', freshForMs: 5 * 60 * 1000 })
  if (view.others.length > 0) ordered.push({ key: 'plan-quota-others', label: `other roster model${view.others.length === 1 ? '' : 's'}`, value: String(view.others.length), source: 'endpoint', freshForMs: 5 * 60 * 1000 })
  return ordered
}

function figuresLine(usage: ActiveSourceUsage): string | undefined {
  const figures = usage.provider === 'gemini' ? geminiPlanFiguresInOrder(usage.figures ?? []) : usage.figures ?? []
  if (figures.length === 0) return undefined
  const parts = figures.map(f => `${f.value} ${f.label}`)
  const stamp = figures[0] !== undefined ? usageSourceWords(figures[0]) : undefined
  return `${parts.join(' · ')}${stamp !== undefined ? ` · ${stamp}` : ''}`
}

function ObservedWindowMeter({
  window: w,
  title,
  maxWidth,
}: {
  window: UsageWindowView
  title?: string
  maxWidth?: number
}): React.ReactNode {
  if (w.usedPct === undefined) return null
  const observed = usageSourceWords(w)
  return (
    <Meter
      title={title ?? (w.label === 'wk' ? 'Current week' : `Window (${w.label})`)}
      limit={{
        utilization: w.usedPct,
        resets_at: w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null,
      }}
      {...(observed !== undefined ? { subtext: observed } : {})}
      {...(maxWidth !== undefined ? { maxWidth } : {})}
    />
  )
}


const ENGINE_USAGE_PRESENTATION: Record<
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
    connect: '/logins minimax adds a MiniMax API key or M Plan Subscription Key (MINIMAX_API_KEY works too)',
    limitsNote: 'A pay-as-you-go key draws the Open Platform balance shown at platform.minimax.io; an M Plan Subscription Key meters its 5-hour and weekly windows here.',
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

function liveSessionFamily(): string | undefined {
  const setting = getUserSpecifiedModelSetting()
  if (setting !== null) return declaredRouteOf(parseUserSpecifiedModel(setting)) ?? undefined
  try {
    return mostRecentSignInFamily()
  } catch {
    return undefined
  }
}

function liveSignInRecency(): string[] {
  try {
    return recentSignIns().map(credential => credential.family)
  } catch {
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

function OpenaiUsageSection({ width }: { width?: number }): React.ReactNode {
  useCatalogueEpoch()
  useUsageLayout()
  useEffect(() => {
    void readCatalogueIfPending('openai')
  }, [])
  const view = providerUsageView('openai')
  const active = view.activeEntry
  const spend = view.sessionSpend
  const seat = getGptSeatAvailability()
  const sub = view.entries.find(e => e.kind === 'subscription-oauth')
  const key = view.entries.find(e => e.kind === 'api-key')
  const windows = openaiObservedWindowViews()
  const owner = useOwnerUsage('openai', sub !== undefined || key !== undefined)
  const limited =
    view.limits.kind === 'openai-observed' && view.limits.window.state === 'limited'
      ? view.limits.window
      : null
  return (
    <Box flexDirection="column">
      <Text bold>OpenAI usage</Text>
      <IdentityLine family="openai" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {sub === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openai adds a ChatGPT account')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{sub.label}</Text>
            {windows.length > 0 ? (
              windows.map(w => (
                <ObservedWindowMeter key={w.key} window={w} {...(width !== undefined ? { maxWidth: width } : {})} />
              ))
            ) : (
              <Text dimColor>
                no usage signal observed yet — this tab reads the ChatGPT usage endpoint;
                GPT replies also update the meter.
              </Text>
            )}
            {owner.readerNote !== undefined ? <Text dimColor>{owner.readerNote}</Text> : null}
            {limited !== null ? (
              <Text dimColor>
                A usage window is reached — resets {new Date(limited.resetsAtMs).toLocaleString()}{carryTail(owner)}.
              </Text>
            ) : (
              <FullWindowLine usage={owner} />
            )}
            <SlotSpend active={active?.kind === 'subscription-oauth'} route="openai" spend={spend} withCost={false} />
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        route="openai"
        spend={spend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
      />
      <Text dimColor>
        {seat.state === 'ready'
          ? `Models: ${seat.ids.length} qualified via the live catalogue.`
          : `Models: ${seat.reason}.`}
      </Text>
    </Box>
  )
}

function OpenrouterUsageSection({ width }: { width?: number }): React.ReactNode {
  const slots = openrouterSlots()
  const spend = providerSessionSpend('openrouter')
  const oauth = slots.find(slot => slot.id === 'openrouter:oauth-key')
  const keys = slots.filter(slot => slot.kind === 'api-key')
  const usage = useOwnerUsage('openrouter', slots.length > 0)
  const windows = usage.windows
  const creditLine =
    figuresLine(usage) ??
    usage.readerNote ??
    (usage.sourceKind === 'none'
      ? 'no credential — nothing to poll'
      : 'fetching live credit truth from the key endpoint…')
  return (
    <Box flexDirection="column">
      <Text bold>OpenRouter usage</Text>
      <IdentityLine family="openrouter" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OAuth-minted key" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openrouter mints a scoped key through the OpenRouter OAuth flow')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{shownIdentityWords('openrouter', oauth.identity)}</Text>
            {oauth.stateNote !== undefined ? <Text dimColor>{oauth.stateNote}</Text> : null}
            <SlotSpend active={oauth.active} route="openrouter" spend={spend} withCost />
          </Box>
        )}
      </Box>
      {keys.length === 0 ? <ApiKeySlot isActive={false} route="openrouter" spend={spend} /> : keys.map(key => (
        <Box key={key.id} flexDirection="column" marginTop={1}>
          <SlotHeading text={`${key.kindLabel}${key.active ? ' · active' : ''}`} />
          <Text dimColor>{shownIdentityWords('openrouter', key.identity)}</Text>
          {key.stateNote !== undefined ? <Text dimColor>{key.stateNote}</Text> : null}
          <SlotSpend active={key.active} route="openrouter" spend={spend} withCost />
        </Box>
      ))}
      {windows.map(w => (
        <ObservedWindowMeter key={w.key} window={w} title="Key credit cap" {...(width !== undefined ? { maxWidth: width } : {})} />
      ))}
      <Text dimColor>{creditLine}</Text>
      {usage.readerNote !== undefined && usage.readerNote !== creditLine ? <Text dimColor>{usage.readerNote}</Text> : null}
      <Text dimColor>One credential serves the whole OpenRouter multi-model catalogue.</Text>
    </Box>
  )
}

function GeminiUsageSection({ width }: { width?: number }): React.ReactNode {
  void width
  const entries = walletEntries().filter(e => e.provider === 'gemini')
  const active = activeWalletEntry('gemini')
  const spend = providerSessionSpend('gemini')
  const oauth = entries.find(e => e.kind === 'oauth')
  const plan = entries.find(e => e.kind === 'subscription-oauth')
  const key = entries.find(e => e.kind === 'api-key')
  const geminiSourcesNote = geminiStoredSourcesNote(liveGeminiStoredSourceFacts())
  const usage = usageForProvider('gemini')
  const planActive = active?.kind === 'subscription-oauth'
  const tierFigure = planActive ? usage.figures?.find(f => f.key === 'plan-tier') : undefined
  const tierStamp = tierFigure !== undefined ? usageSourceWords(tierFigure) : undefined
  const sessionModel = useFocusedServedModel()
  const sessionEffort = useFocusedServedEffort()
  const quota = planActive ? geminiPlanQuotaView(usage.figures ?? [], { ...(sessionModel !== null ? { model: sessionModel } : {}), ...(sessionEffort !== null ? { effort: sessionEffort } : {}), usedModels: geminiLaneModelsByLastUse() }) : { used: [], others: [], unreported: [] }
  const [othersOpen, setOthersOpen] = useState(false)
  useInput((_input, key, event) => {
    if (!key.return || quota.others.length === 0) return
    event.stopImmediatePropagation()
    setOthersOpen(open => !open)
  })
  const quotaLine = (figure: UsageFigureView, tail?: string): string => [`${figure.label}: ${figure.value}`, ...(figure.resetsAtMs !== undefined ? [`resets ${new Date(figure.resetsAtMs).toLocaleString()}`] : []), ...(usageSourceWords(figure) !== undefined ? [usageSourceWords(figure)!] : []), ...(tail !== undefined ? [tail] : [])].join(' · ')
  return (
    <Box flexDirection="column">
      <Text bold>Gemini usage</Text>
      <IdentityLine family="gemini" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google sign-in" />
        {plan === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini → Sign in with Google rides your plan\'s quota')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{plan.identity?.email !== undefined ? `${plan.label} · ${plan.identity.email}` : plan.label}</Text>
            {tierFigure !== undefined ? <Text dimColor>{[`${tierFigure.label}: ${tierFigure.value}`, ...(tierStamp !== undefined ? [tierStamp] : [])].join(' · ')}</Text> : null}
            {quota.active !== undefined ? <Text dimColor>{quotaLine(quota.active, `the session's model${quota.activeRow !== undefined && sessionModel !== null && quota.activeRow !== sessionModel.toLowerCase() ? ` (${sessionModel} ▸ ${quota.activeRow})` : ''}`)}</Text> : null}
            {quota.used.map(figure => (
              <Text key={figure.key} dimColor>{quotaLine(figure, 'used this session')}</Text>
            ))}
            {quota.unreported.map(entry => (
              <Text key={`plan-quota-unreported:${entry.model}`} dimColor>{`${geminiPlanQuotaUnreportedWords(entry.model)} · ${entry.active ? "the session's model" : 'used this session'}`}</Text>
            ))}
            {quota.others.length > 0 ? <Text dimColor>{geminiPlanQuotaFoldWords(quota.others.length, othersOpen)}</Text> : null}
            {othersOpen ? quota.others.map(figure => (
              <Text key={figure.key} dimColor>{quotaLine(figure)}</Text>
            )) : null}
            {planActive && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <SlotSpend active={planActive} route="gemini" spend={spend} withCost={false} />
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google account" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini connects Google OAuth (needs your own OAuth client)')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <SlotSpend active={active?.kind === 'oauth'} route="gemini" spend={spend} withCost />
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        route="gemini"
        spend={spend}
      />
      {geminiSourcesNote !== undefined ? <Text dimColor>{geminiSourcesNote}</Text> : null}
      <Text dimColor>{usage.absence ?? ENGINE_USAGE_PRESENTATION.gemini!.limitsNote}</Text>
    </Box>
  )
}

function HuggingfaceUsageSection(): React.ReactNode {
  useCatalogueEpoch()
  useUsageLayout()
  useEffect(() => {
    void readCatalogueIfPending('huggingface')
  }, [])
  const account = resolveHuggingfaceAccount()
  const spend = providerSessionSpend('huggingface')
  const availability = getHuggingfaceAvailability()
  const usage = useOwnerUsage('huggingface', account !== undefined)
  const rate = usage.figures?.find(f => f.key === 'rate-remaining')
  const plan = usage.figures?.find(f => f.key === 'plan')
  const rateLine = rate !== undefined ? figuresLine({ ...usage, figures: [rate] }) : undefined
  const rateReset = rate?.resetsAtMs
  const planStamp = plan !== undefined ? usageSourceWords(plan) : undefined
  const planLine =
    plan !== undefined
      ? [
          `${plan.value} ${plan.label}`,
          ...(plan.resetsAtMs !== undefined ? [`period ends ${new Date(plan.resetsAtMs).toLocaleDateString()}`] : []),
          ...(planStamp !== undefined ? [planStamp] : []),
        ].join(' · ')
      : undefined
  const planRow = [planLine, usage.readerNote].filter((line): line is string => line !== undefined).join(' · ')
  return (
    <Box flexDirection="column">
      <Text bold>Hugging Face usage</Text>
      <IdentityLine family="huggingface" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Sign-in" />
        {account?.kind === 'oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{shownIdentityWords('huggingface', account.label)}</Text>
            <SlotSpend active route="huggingface" spend={spend} withCost={false} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine("/logins huggingface signs in with the Hub's device-code flow")}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={account?.kind === 'api-key' ? shownIdentityWords('huggingface', account.label) : undefined}
        isActive={account?.kind === 'api-key'}
        route="huggingface"
        spend={spend}
      />
      {account && planRow !== '' ? <Text dimColor>{planRow}</Text> : null}
      {account && (rateLine !== undefined || usage.limited !== undefined) ? (
        <Text dimColor>
          {rateLine !== undefined
            ? `${rateLine}${rateReset !== undefined ? ` · resets ${new Date(rateReset).toLocaleTimeString()}` : ''}`
            : ''}
          {usage.limited !== undefined ? ` A limit is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleTimeString()}${carryTail(usage)}.` : ''}
        </Text>
      ) : null}
      <Text dimColor>
        {account
          ? `Billing: ${usage.absence ?? ENGINE_USAGE_PRESENTATION.huggingface!.limitsNote}.`
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.huggingface!.connect}.`}
      </Text>
      <Text dimColor>
        {availability.state === 'ready'
          ? `Models: ${availability.modelCount > 0 ? `${availability.modelCount} live via the router catalogue` : (availability.catalogueNote ?? 'catalogue pending')} · ${HUGGINGFACE_UNVERIFIED_NOTE}.`
          : `Models: ${availability.liveIds.length > 0 ? `${availability.liveIds.length} live-listed (sign in to select)` : availability.reason} · ${HUGGINGFACE_UNVERIFIED_NOTE}.`}
      </Text>
    </Box>
  )
}

function LocalUsageSection(): React.ReactNode {
  const usage = useOwnerUsage('local', true)
  const account = resolveLocalAccount()
  const snapshot = getCachedLocalDiscovery()
  const spend = providerSessionSpend('local')
  return (
    <Box flexDirection="column">
      <Text bold>Local models usage</Text>
      <IdentityLine family="local" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Servers" />
        {account && snapshot ? (
          <Box flexDirection="column">
            {snapshot.servers.map(server => (
              <Text key={`${server.kind}:${server.root}`} dimColor>
                {server.label} · {LOCAL_SERVER_NAMES[server.kind]} at {server.root} · {server.models.length} model
                {server.models.length === 1 ? '' : 's'}
                {server.models.some(m => m.toolsDeclared === false) ? ' · some declare no tool support' : ''}
              </Text>
            ))}
            <SlotSpend active route="local" spend={spend} withCost={false} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine(ENGINE_USAGE_PRESENTATION.local!.connect)}</Text>
        )}
      </Box>
      <Text dimColor>
        {account
          ? `${usage.absence ?? 'local · no metering'} — ${account.kind === 'keyless' ? 'keyless' : `key (${account.keySource})`}.`
          : `local · no metering · probes ${snapshot ? `ran ${new Date(snapshot.probedAtMs).toLocaleTimeString()}` : 'pending'}.`}
      </Text>
    </Box>
  )
}

function EngineUsageSection({ section, width }: { section: UsageSection; width?: number }): React.ReactNode {
  const usage = useOwnerUsage(section.id, section.family.credentialed)
  if (!section.family.credentialed) {
    return (
      <Box flexDirection="column">
        <Text bold>{section.title}</Text>
        <IdentityLine family={section.id} />
        <Text dimColor>not connected — {section.connect}.</Text>
      </Box>
    )
  }
  if (section.id === 'openai') return <OpenaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'openrouter') return <OpenrouterUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'gemini') return <GeminiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'huggingface') return <HuggingfaceUsageSection />
  if (section.id === 'moonshot') return <MoonshotUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'zai') return <ZaiUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} />
  if (section.id === 'xai') return <XaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'meta') return <MetaUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'zen') return <ZenUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} credentialed={section.family.credentialed} />
  if (section.id === 'minimax') return <MinimaxUsageSection {...(width !== undefined ? { width } : {})} {...(section.family.credentialLabel !== undefined ? { credentialLabel: section.family.credentialLabel } : {})} credentialed={section.family.credentialed} />
  if (section.id === 'local') return <LocalUsageSection />
  const spend = providerSessionSpend(section.id)
  return (
    <Box flexDirection="column">
      <Text bold>{section.title}</Text>
      <IdentityLine family={section.id} />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        <Text dimColor>{absentSlotLine('this family connects by API key')}</Text>
      </Box>
      <ApiKeySlot
        presentLabel={section.family.credentialLabel}
        isActive={section.family.credentialed}
        route={section.id}
        spend={spend}
      />
      {figuresLine(usage) !== undefined ? <Text dimColor>{figuresLine(usage)}</Text> : null}
      {section.family.credentialed && usage.readerNote !== undefined ? (
        <Text dimColor>{usage.readerNote}</Text>
      ) : null}
      <Text dimColor>
        {section.family.credentialed ? (usage.absence ?? section.limitsNote) : `Not connected — ${section.connect}.`}
      </Text>
    </Box>
  )
}

function MoonshotUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveMoonshotAccount()
  const key = resolveMoonshotApiKey()
  const spend = providerSessionSpend('moonshot')
  const usage = useOwnerUsage('moonshot', account !== undefined)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>Moonshot usage</Text>
      <IdentityLine family="moonshot" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Kimi sign-in" />
        {account?.kind === 'kimi-oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <SlotSpend active route="moonshot" spend={spend} withCost={false} />
            {windows.length > 0 ? (
              windows.map(window => window.usedPct !== undefined ? (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(window.label === '7d' ? { title: 'Current week (7d)' } : {})}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ) : (
                <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
              ))
            ) : (
              <Text dimColor>Plan windows: not yet observed — the usage endpoint is asked on this tab.</Text>
            )}
            <FullWindowLine usage={usage} />
          </Box>
        ) : (
          <Text dimColor>none — /logins moonshot signs in with a device code · n/a</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={
          key ? (key.source === 'env' ? 'MOONSHOT_API_KEY (env)' : 'Moonshot API key (stored, auth-scoped)') : undefined
        }
        isActive={account?.kind === 'api-key'}
        route="moonshot"
        spend={spend}
      />
      <Text dimColor>
        {account
          ? ENGINE_USAGE_PRESENTATION.moonshot!.limitsNote
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.moonshot!.connect}.`}
      </Text>
    </Box>
  )
}

function MinimaxUsageSection({ width, credentialLabel, credentialed }: { width?: number; credentialLabel?: string; credentialed: boolean }): React.ReactNode {
  const spend = providerSessionSpend('minimax')
  const usage = useOwnerUsage('minimax', credentialed)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>MiniMax usage</Text>
      <IdentityLine family="minimax" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="M Plan" />
        {credentialed && windows.length > 0 ? (
          windows.map(window => window.usedPct !== undefined ? (
            <ObservedWindowMeter key={window.key} window={window} {...(width !== undefined ? { maxWidth: width } : {})} />
          ) : (
            <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
          ))
        ) : (
          <Text dimColor>{credentialed ? (usage.readerNote ?? 'none stated for this key — the plan endpoint is asked on this tab') : absentSlotLine('an M Plan meters here once its key is stored')}</Text>
        )}
      </Box>
      <ApiKeySlot presentLabel={credentialLabel} isActive={credentialed} route="minimax" spend={spend} />
      <Text dimColor>
        {credentialed ? (usage.absence ?? ENGINE_USAGE_PRESENTATION.minimax!.limitsNote) : `Not connected — ${ENGINE_USAGE_PRESENTATION.minimax!.connect}.`}
      </Text>
    </Box>
  )
}

function ZenUsageSection({ width, credentialLabel, credentialed }: { width?: number; credentialLabel?: string; credentialed: boolean }): React.ReactNode {
  const spend = providerSessionSpend('zen')
  const usage = useOwnerUsage('zen', credentialed)
  const windows = usage.windows
  return (
    <Box flexDirection="column">
      <Text bold>OpenCode Zen usage</Text>
      <IdentityLine family="zen" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OpenCode Go plan" />
        {credentialed && windows.length > 0 ? (
          windows.map(window => window.usedPct !== undefined ? (
            <ObservedWindowMeter key={window.key} window={window} {...(width !== undefined ? { maxWidth: width } : {})} />
          ) : (
            <Text key={window.key} dimColor>{`${window.label}: no limit stated`}</Text>
          ))
        ) : (
          <Text dimColor>{credentialed ? (usage.readerNote ?? 'none stated for this key — the usage endpoint is asked on this tab') : absentSlotLine('a Go plan meters here once its key is stored')}</Text>
        )}
      </Box>
      <ApiKeySlot presentLabel={credentialLabel} isActive={credentialed} route="zen" spend={spend} />
      <Text dimColor>
        {credentialed ? (usage.absence ?? ENGINE_USAGE_PRESENTATION.zen!.limitsNote) : `Not connected — ${ENGINE_USAGE_PRESENTATION.zen!.connect}.`}
      </Text>
    </Box>
  )
}

function XaiUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveXaiAccount()
  const key = resolveXaiApiKey()
  const subscription = account?.kind === 'grok-subscription'
  const spend = providerSessionSpend('xai')
  const usage = useOwnerUsage('xai', account !== undefined)
  const windows = usage.windows
  const figures = figuresLine(usage)
  return (
    <Box flexDirection="column">
      <Text bold>xAI usage</Text>
      <IdentityLine family="xai" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Grok subscription" />
        {subscription ? (
          <Box flexDirection="column">
            <Text dimColor>{[account.label, usage.tier !== account.label ? usage.tier : undefined].filter((part): part is string => part !== undefined).join(' · ')}</Text>
            <SlotSpend active route="xai" spend={spend} withCost={false} />
            {usage.absence !== undefined ? (
              <Text dimColor>{usage.absence}</Text>
            ) : windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{usage.readerNote ?? 'Included pool: not yet observed — the Grok pool endpoint is asked on this tab.'}</Text>
            )}
            {windows.length > 0 && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <FullWindowLine usage={usage} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins xai signs in with a device code')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key ? (key.source === 'env' ? 'XAI_API_KEY (env)' : 'xAI API key (stored, auth-scoped)') : undefined}
        isActive={account?.kind === 'api-key'}
        route="xai"
        spend={spend}
      />
      {!subscription && figures !== undefined ? <Text dimColor>{figures}</Text> : null}
      {!subscription && account !== undefined && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.xai!.connect}.`
          : subscription
            ? ENGINE_USAGE_PRESENTATION.xai!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.xai!.limitsNote)}
      </Text>
    </Box>
  )
}

function MetaUsageSection({ width }: { width?: number }): React.ReactNode {
  const account = resolveMetaAccount()
  const key = resolveMetaRawApiKey()
  const subscription = account?.kind === 'muse-code'
  const spend = providerSessionSpend('meta')
  const usage = useOwnerUsage('meta', account !== undefined)
  const planUsage = metaMuseCodeUsage(spend)
  const windows = planUsage?.windows ?? []
  const facts = liveMetaConnectFacts()
  const storedNote = metaStoredSourcesNote(facts)
  const tierWithAge = metaMuseCodeTierWordsWithAge(facts)
  return (
    <Box flexDirection="column">
      <Text bold>Meta usage</Text>
      <IdentityLine family="meta" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Muse Code subscription" />
        {planUsage !== undefined ? (
          <Box flexDirection="column">
            <Text dimColor>{[facts.museCodeEmail ? shownIdentityWords('meta', facts.museCodeEmail) : undefined, tierWithAge].filter((part): part is string => part !== undefined && part !== '').join(' · ')}</Text>
            {!subscription ? <Text dimColor>not active — ↵ on its /logins row makes it active</Text> : null}
            <SlotSpend active={subscription} route="meta" spend={spend} withCost={false} />
            {windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{planUsage.readerNote ?? (subscription ? 'Plan windows: not yet observed — the key endpoint is asked on this tab.' : planUsage.absence)}</Text>
            )}
            {windows.length > 0 && planUsage.readerNote !== undefined ? <Text dimColor>{planUsage.readerNote}</Text> : null}
            <FullWindowLine usage={planUsage} />
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins meta signs in with a device code')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key ? (key.source === 'env' ? `${key.envName!} (env)` : 'Meta API key (stored, auth-scoped)') : undefined}
        isActive={account?.kind === 'api-key'}
        route="meta"
        spend={spend}
      />
      {storedNote !== undefined ? <Text dimColor>{storedNote}</Text> : null}
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.meta!.connect}.`
          : subscription
            ? ENGINE_USAGE_PRESENTATION.meta!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.meta!.limitsNote)}
      </Text>
    </Box>
  )
}

function ZaiUsageSection({ width, credentialLabel }: { width?: number; credentialLabel?: string }): React.ReactNode {
  const account = zaiAccountFacts()
  const coding = account?.plan === 'coding'
  const spend = providerSessionSpend('zai')
  const usage = useOwnerUsage('zai', account !== undefined)
  const windows = usage.windows
  const figures = figuresLine(usage)
  return (
    <Box flexDirection="column">
      <Text bold>Z.AI usage</Text>
      <IdentityLine family="zai" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="GLM Coding Plan" />
        {coding ? (
          <Box flexDirection="column">
            <Text dimColor>{[credentialLabel ?? 'GLM Coding Plan key', usage.tier].filter((part): part is string => part !== undefined).join(' · ')}</Text>
            <SlotSpend active route="zai" spend={spend} withCost={false} />
            {usage.absence !== undefined ? (
              <Text dimColor>{usage.absence}</Text>
            ) : windows.length > 0 ? (
              windows.map(window => (
                <ObservedWindowMeter
                  key={window.key}
                  window={window}
                  {...(window.label === '7d' ? { title: 'Current week (7d)' } : {})}
                  {...(width !== undefined ? { maxWidth: width } : {})}
                />
              ))
            ) : (
              <Text dimColor>{usage.readerNote ?? 'Plan windows: not yet observed — the quota endpoint is asked on this tab.'}</Text>
            )}
            {windows.length > 0 && usage.readerNote !== undefined ? <Text dimColor>{usage.readerNote}</Text> : null}
            <FullWindowLine usage={usage} />
            {figures !== undefined ? <Text dimColor>{figures}</Text> : null}
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine('/logins zai adds a GLM Coding Plan key')}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={!coding && account !== undefined ? credentialLabel ?? 'Z.AI API key' : undefined}
        isActive={!coding && account !== undefined}
        route="zai"
        spend={spend}
      />
      <Text dimColor>
        {account === undefined
          ? `Not connected — ${ENGINE_USAGE_PRESENTATION.zai!.connect}.`
          : coding
            ? ENGINE_USAGE_PRESENTATION.zai!.limitsNote
            : (usage.absence ?? ENGINE_USAGE_PRESENTATION.zai!.limitsNote)}
      </Text>
    </Box>
  )
}

const askedOpens = new Set<number>()
function markOpenAsked(token: number): boolean {
  if (askedOpens.has(token)) return false
  askedOpens.add(token)
  if (askedOpens.size > 64) {
    const oldest = askedOpens.values().next().value
    if (oldest !== undefined) askedOpens.delete(oldest)
  }
  return true
}

function AnthropicUsageSection({ width, openToken }: { width?: number; openToken?: number }): React.ReactNode {
  useUsageLayout()
  const tokens = useMercuryTokens()
  const subscriber = isClaudeAISubscriber()
  const [state, setState] = useState<{
    loading: boolean
    error: unknown
    data: Utilization | null
  }>({ loading: subscriber, error: null, data: null })

  const disposedRef = useRef(false)
  useEffect(() => () => {
    disposedRef.current = true
  }, [])

  const settle = useCallback((): void => {
    if (disposedRef.current) return
    const note = usageForProvider('anthropic').readerNote
    setState(note !== undefined ? { loading: false, error: note, data: null } : { loading: false, error: null, data: {} })
  }, [])
  const load = useCallback((): void => {
    if (!subscriber) return
    setState(previous => ({ ...previous, loading: true, error: null }))
    void refreshProviderUsage('anthropic', { reason: 'operator' }).then(settle)
  }, [subscriber, settle])
  useEffect(() => {
    if (!subscriber) return
    if (openToken !== undefined && !markOpenAsked(openToken)) {
      void refreshProviderUsage('anthropic', { reason: 'open' }).then(settle)
      return
    }
    load()
  }, [load, subscriber, openToken, settle])

  const showingError = !state.loading && state.error !== null
  useKeybinding(
    'settings:retry',
    () => {
      load()
    },
    { context: 'Settings', isActive: showingError },
  )

  const anthropicSection = ((): React.ReactNode => {
    if (!subscriber) {
      return <Text dimColor>{absentSlotLine('/logins anthropic connects a subscription account')}</Text>
    }
    if (state.loading) {
      return <Text dimColor>loading usage…</Text>
    }
    if (showingError) {
      const readerWords = typeof state.error === 'string' ? state.error : (humanizeUsageError(state.error) ?? '')
      const raw = state.error instanceof Error ? state.error.message : ''
      const isWait = usageForProvider('anthropic').readerWait === true
      return (
        <Box flexDirection="column">
          <Text color={isWait ? tokens.warning : tokens.failure}>
            {readerWords !== '' ? readerWords : `Failed to load usage${raw !== '' ? `: ${raw}` : ''}`}
          </Text>
          <Text dimColor>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            {' · '}
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="esc"
              description="cancel"
            />
          </Text>
        </Box>
      )
    }

    const ownerWindows = anthropicWindowViews().filter(w => w.state === 'live')
    const fiveHourView = ownerWindows.find(w => w.key === '5h')
    const sevenDayView = ownerWindows.find(w => w.key === '7d')
    const poolViews = anthropicPoolWindowViews().filter(w => w.state === 'live')
    const hasAnyLimit = ownerWindows.length > 0 || poolViews.length > 0
    if (!hasAnyLimit) {
      return (
        <Text dimColor>
          Usage limits are only available on subscription plans.
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {fiveHourView !== undefined ? (
          <ObservedWindowMeter window={fiveHourView} title="Current session" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {sevenDayView !== undefined ? (
          <ObservedWindowMeter window={sevenDayView} title="Current week (all models)" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {poolViews.map(w => (
          <ObservedWindowMeter key={w.key} window={w} title={`Current week (${w.label})`} {...(width !== undefined ? { maxWidth: width } : {})} />
        ))}
        <FullWindowLine usage={usageForProvider('anthropic')} />
      </Box>
    )
  })()

  const view = providerUsageView('anthropic')
  const keyEntry = view.entries.find(e => e.kind === 'api-key')
  const owner = usageForProvider('anthropic')
  return (
    <Box flexDirection="column">
      <Text bold>Anthropic usage</Text>
      <IdentityLine family="anthropic" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {anthropicSection}
        {subscriber ? <SlotSpend active={view.activeEntry?.kind === 'subscription-oauth'} route="anthropic" spend={view.sessionSpend} withCost={false} /> : null}
      </Box>
      <ApiKeySlot
        presentLabel={keyEntry?.label}
        isActive={view.activeEntry?.kind === 'api-key'}
        route="anthropic"
        spend={view.sessionSpend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
      />
    </Box>
  )
}

export function usageColumns(width: number, count: number): { perRow: number; colW: number; meterW: number; gap: number } {
  const inner = Math.max(1, Math.floor(width))
  const perRow = inner >= 120 ? Math.max(1, Math.min(3, count)) : 1
  const gap = 4
  const colW = Math.max(1, Math.floor((inner - gap * (perRow - 1)) / perRow))
  return { perRow, colW, meterW: Math.max(1, colW - (perRow > 1 ? 4 : 2)), gap }
}

export function usageWindow(bands: ReadonlyArray<{ height: number; count: number }>, capacity: number, position: number): {
  offset: number; height: number; endBand: number; previous: number; next: number
} {
  const rows = Math.max(0, Math.floor(capacity))
  const starts: number[] = []
  let end = 0
  for (const band of bands) {
    starts.push(end)
    end += Math.max(1, band.height) + 1
  }
  const viewAt = (offset: number) => {
    let height = 0
    let count = 0
    let endBand = 0
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index]!
      const bottom = starts[index]! + Math.max(1, band.height)
      if (bottom <= offset) { endBand = index + 1; continue }
      if (count + band.count > 6 || rows === 0) break
      const needed = bottom - offset
      if (count > 0 && needed > rows) break
      height = Math.min(rows, needed)
      count += band.count
      endBand = index + 1
      if (needed >= rows) break
    }
    return { offset, height, endBand }
  }
  let current = viewAt(0)
  let previous = 0
  let next = 0
  const target = Math.max(0, Math.floor(position))
  outer: for (let index = 0; index < bands.length && rows > 0; index++) {
    const start = starts[index]!
    const last = start + Math.max(0, bands[index]!.height - rows)
    for (let offset = start; offset <= last; offset++) {
      if (offset > target) { next = offset; break outer }
      previous = current.offset
      current = viewAt(offset)
      next = offset
      if (offset + current.height >= end - 1) break outer
    }
  }
  return { ...current, previous, next }
}

export const JEV_USAGE_LABEL = 'Jev'

export function jevUsageRowShown(session: JevSessionFacts = jevSessionFacts(), key: JevKeyPresence = jevKeyPresence()): boolean {
  return key.present || (session.state === 'reported' && (session.facts.calls > 0 || session.facts.attempts > 0))
}

export function jevUsageRow(session: JevSessionFacts = jevSessionFacts()): string {
  const settings = readJevSettings()
  const headword = JEV_STATUS_HEADWORDS[jevSessionStatus(session, settings).kind]
  const allowance = jevUsdLabel(settings.allowanceUsd)
  const count = session.state === 'reported' ? `${jevUsdLabel(session.facts.spendUsd)} of a ${allowance} allowance · ${session.facts.calls} call${session.facts.calls === 1 ? '' : 's'} (${session.facts.unconfirmedCharges} unconfirmed)` : `${jevSessionAbsenceWords(session)} · allowance ${allowance}`
  const stated = settings.road === 'openrouter' && session.state === 'reported' && session.facts.lastCostUsd != null ? ` · last stated $${session.facts.lastCostUsd}` : ''
  const road = settings.road === 'openrouter' ? ` · ${jevRoadWords(settings.road)}` : ''
  const credits = settings.road === 'openrouter' ? jevCreditsWords(settings.road) : CREDITS_UNREPORTED_WORDS
  return `${JEV_USAGE_LABEL} · second-opinion evaluator${road} · ${count}${stated} · ${headword} · credits: ${credits}`
}

export function usageBodyRows(budget: number, requestedJevRows = 1): { footerRows: number; jevRows: number; capacity: number } {
  const rows = Math.max(0, Math.floor(budget))
  const footerRows = rows > 1 ? 1 : 0
  const jevRows = rows > 2 && requestedJevRows > 0 ? Math.min(rows - 2, requestedJevRows) : 0
  return { footerRows, jevRows, capacity: rows - footerRows - jevRows }
}

export type UsageCompactLine = { text: string; heading: boolean }

export type UsageCompactReads = {
  identity: (family: ProviderFamilyId) => string
  usage: (family: ProviderFamilyId) => ActiveSourceUsage
  anthropicWindows: () => UsageWindowView[]
  anthropicPools: () => UsageWindowView[]
  openaiWindows: () => UsageWindowView[]
  jev: () => string | undefined
}

function compactWindowLine(w: UsageWindowView, title: string): string | undefined {
  if (w.usedPct === undefined) return undefined
  const reset = resetLineOf(w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null, false)
  return `  ${title} · ${Math.floor(w.usedPct)}%${reset !== null ? ` · ${reset}` : ''}`
}

export function usageCompactLines(
  plan: UsageSection[],
  reads: UsageCompactReads = {
    identity: family => providerIdentitySentence(providerIdentityLine(family)),
    usage: usageForProvider,
    anthropicWindows: () => anthropicWindowViews().filter(w => w.state === 'live'),
    anthropicPools: () => anthropicPoolWindowViews().filter(w => w.state === 'live'),
    openaiWindows: openaiObservedWindowViews,
    jev: () => (jevUsageRowShown() ? jevUsageRow() : undefined),
  },
): UsageCompactLine[] {
  const lines: UsageCompactLine[] = []
  for (const section of plan) {
    lines.push({ text: `${section.title} · ${reads.identity(section.id)}`, heading: true })
    if (!section.family.credentialed) continue
    const usage = reads.usage(section.id)
    const windows: string[] = []
    if (section.id === 'anthropic') {
      for (const w of reads.anthropicWindows()) {
        const line = compactWindowLine(w, w.key === '5h' ? 'Current session' : w.key === '7d' ? 'Current week (all models)' : `Window (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
      for (const w of reads.anthropicPools()) {
        const line = compactWindowLine(w, `Current week (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
    } else {
      for (const w of section.id === 'openai' ? reads.openaiWindows() : usage.windows) {
        const line = compactWindowLine(w, w.label === 'wk' ? 'Current week' : w.label === '7d' ? 'Current week (7d)' : `Window (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
    }
    for (const line of windows) lines.push({ text: line, heading: false })
    const credits = usageCreditsLine(usage.credits) ?? figuresLine(usage)
    if (credits !== undefined) lines.push({ text: `  ${credits}`, heading: false })
    if ((section.id === 'openrouter' || section.id === 'gemini') && usage.readerNote !== undefined) {
      for (const note of usage.readerNote.split('; ')) lines.push({ text: `  ${note}`, heading: false })
    }
    const full = fullWindowLine(usage)
    if (full !== undefined) lines.push({ text: `  ${full}`, heading: false })
  }
  const jev = reads.jev()
  if (jev !== undefined) lines.push({ text: jev, heading: false })
  return lines
}

function UsageCompact({ openToken, width, rowBudget }: { openToken?: number; width: number; rowBudget: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  useCatalogueEpoch()
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency(), liveSessionFamily())
  const [, setSample] = useState(0)
  const asks = plan.filter(section => section.family.credentialed).map(section => section.id).join('|')
  useEffect(() => {
    let disposed = false
    for (const id of asks.split('|').filter(Boolean) as ProviderFamilyId[]) {
      const operator = id === 'anthropic' && isClaudeAISubscriber() && openToken !== undefined && markOpenAsked(openToken)
      void refreshProviderUsage(id, { reason: operator ? 'operator' : 'open' }).then(() => {
        if (!disposed) setSample(s => s + 1)
      })
    }
    return () => {
      disposed = true
    }
  }, [openToken, asks])
  const lines = usageCompactLines(plan)
  const rows = Math.max(0, Math.floor(rowBudget))
  const [cursor, setCursor] = useState(0)
  const [offset, setOffset] = useState(0)
  const view = settingsPopupWindow(cursor, offset, lines.length, rows)
  useEffect(() => {
    if (view.cursor !== cursor) setCursor(view.cursor)
    if (view.offset !== offset) setOffset(view.offset)
  }, [view.cursor, view.offset, cursor, offset])
  usePopupMarker(rows > 0 ? settingsPopupMarker(view.cursor + 1, lines.length) : null)
  usePopupListPaging(view.cursor, lines.length, rows, setCursor)
  useInput((_input, key, event) => {
    if (!key.upArrow && !key.downArrow) return
    event.stopImmediatePropagation()
    const next = settingsPopupWindow(view.cursor + (key.upArrow ? -1 : 1), view.offset, lines.length, rows)
    setCursor(next.cursor)
    setOffset(next.offset)
  })
  const columns = Math.max(1, Math.floor(width))
  return (
    <Box flexDirection="column" width={columns} height={rows} flexShrink={0} overflow="hidden">
      {lines.slice(view.offset, view.offset + rows).map((line, index) => {
        const at = view.offset + index
        const current = at === view.cursor
        return (
          <Box key={at} height={1} flexShrink={0}>
            <Text bold={line.heading} color={current ? tokens.textPrimary : line.heading ? undefined : tokens.textSecondary} wrap="truncate-end">
              {current ? `${GLYPH.chevronRight} ` : '  '}
              {line.text}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function Usage({ openToken, width = 146, rowBudget = 22, compact = false }: { openToken?: number; width?: number; rowBudget?: number; compact?: boolean }): React.ReactNode {
  const frame = useSettingsPopupFrameIfAny()
  const usageVersion = useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  useEffect(() => {
    frame?.setLine(usagePopupLine())
    frame?.setHint('↑↓ scroll · pgup/pgdn page · esc or click outside closes')
  }, [frame, usageVersion])
  return compact ? <UsageCompact {...(openToken !== undefined ? { openToken } : {})} width={width} rowBudget={rowBudget} /> : <UsageFull {...(openToken !== undefined ? { openToken } : {})} width={width} rowBudget={rowBudget} />
}

function UsageFull({ openToken, width, rowBudget }: { openToken?: number; width: number; rowBudget: number }): React.ReactNode {
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency(), liveSessionFamily())
  const { perRow, colW, meterW, gap } = usageColumns(width, plan.length)
  const bands: UsageSection[][] = []
  for (let start = 0; start < plan.length; start += perRow) bands.push(plan.slice(start, start + perRow))
  const contentRef = useRef<DOMElement>(null)
  const [heights, setHeights] = useState<number[]>([])
  const [cardHeights, setCardHeights] = useState<number[][]>([])
  const [position, setPosition] = useState(0)
  const measure = useCallback(() => {
    const rows = contentRef.current?.childNodes ?? []
    const next = rows.map(node => node.nodeName === '#text' ? 0 : Math.ceil(measureElement(node).height))
    const cards = rows.map(node => node.nodeName === '#text' ? [] : node.childNodes.map(column => {
      if (column.nodeName === '#text') return 0
      const card = column.childNodes[0]
      return Math.ceil(measureElement(card !== undefined && card.nodeName !== '#text' ? card : column).height)
    }))
    setHeights(previous => previous.length === next.length && previous.every((height, index) => height === next[index]) ? previous : next)
    setCardHeights(previous => previous.length === cards.length && previous.every((band, index) => band.length === cards[index]!.length && band.every((height, card) => height === cards[index]![card])) ? previous : cards)
  }, [])
  useLayoutEffect(measure)
  const budget = Math.max(0, Math.floor(rowBudget))
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const jevLine = jevUsageRowShown() ? jevUsageRow() : undefined
  const routerRoad = readJevSettings().road === 'openrouter'
  const requestedJevRows = jevLine === undefined ? 0 : routerRoad ? wrapText(jevLine, Math.max(1, Math.floor(width)), 'wrap').split('\n').length : 1
  const { footerRows, jevRows, capacity } = usageBodyRows(budget, requestedJevRows)
  const view = usageWindow(bands.map((band, index) => ({ height: heights[index] ?? 1, count: band.length })), capacity, position)
  const totalRows = bands.reduce((sum, _, index) => sum + (heights[index] ?? 1) + 1, 0) - 1
  usePopupListPaging(view.offset, Math.max(1, totalRows - capacity + 1), capacity, setPosition)
  useInput((_input, key, event) => {
    if (!key.upArrow && !key.downArrow) return
    event.stopImmediatePropagation()
    setPosition(key.upArrow ? view.previous : view.next)
  })
  let bandTop = 0
  const above: UsageSection[] = []
  bands.forEach((band, bandIndex) => {
    band.forEach((section, index) => {
      if (bandTop + Math.max(1, cardHeights[bandIndex]?.[index] ?? heights[bandIndex] ?? 1) <= view.offset) above.push(section)
    })
    bandTop += Math.max(1, heights[bandIndex] ?? 1) + 1
  })
  const below = bands.slice(view.endBand).flat()
  const more = [above.length ? `↑ ${above.length} more` : '', below.length ? `↓ ${below.length} more · ${below.map(section => section.title.replace(/ usage$/, '')).join(' · ')}` : ''].filter(Boolean).join(' · ')
  return (
    <UsageLayoutContext.Provider value={measure}>
      <Box flexDirection="column" width={Math.max(1, Math.floor(width))} height={budget} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" height={capacity} flexShrink={0} overflow="hidden">
          <Box flexDirection="column" height={view.height} flexShrink={0} overflow="hidden">
            <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-view.offset}>
              {bands.map((band, bandIndex) => (
                <Box key={band.map(section => section.id).join('|')} flexDirection="row" flexShrink={0} marginTop={bandIndex > 0 ? 1 : 0}>
                  {band.map((section, index) => (
                    <Box key={section.id} flexDirection="column" width={colW} flexShrink={0} marginRight={index < band.length - 1 ? gap : 0}>
                      {section.kind === 'anthropic' ? (
                        <AnthropicUsageSection width={meterW} openToken={openToken} />
                      ) : (
                        <EngineUsageSection section={section} width={meterW} />
                      )}
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        {jevRows > 0 ? <Box height={jevRows} flexShrink={0} overflow="hidden"><Text wrap={routerRoad ? 'wrap' : 'truncate-end'}>{jevLine}</Text></Box> : null}
        {footerRows > 0 ? <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{more}</Text></Box> : null}
      </Box>
    </UsageLayoutContext.Provider>
  )
}
