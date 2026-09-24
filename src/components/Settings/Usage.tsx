
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, measureElement, useInput, type DOMElement } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { recentSignIns } from '../../utils/model/computedDefault.js'
import type { RouterProviderId } from '../../utils/router/providers/types.js'
import {
  CREDITS_UNREPORTED_WORDS,
  anthropicPoolWindowViews,
  anthropicWindowViews,
  openaiObservedWindowViews,
  providerFamilyPresences,
  providerSessionSpend,
  providerUsageView,
  refreshProviderUsage,
  usageCreditsLine,
  usageForProvider,
  type ActiveSourceUsage,
  type ProviderFamilyPresence,
  type ProviderSessionSpend,
  type UsageWindowView,
} from '../../services/providers/providerUsage.js'
import { jevUsdLabel } from '../../services/jev/jevContract.js'
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
import { resolveHuggingfaceAccount } from '../../services/providers/huggingface/huggingfaceAccounts.js'
import { getHuggingfaceAvailability } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from '../../services/providers/huggingface/huggingfaceCallModel.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { resolveLocalAccount } from '../../services/providers/local/localAccounts.js'
import { LOCAL_SERVER_NAMES } from '../../services/providers/local/localCatalogue.js'
import { formatLaneSpend } from '../../cost-tracker.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

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

function spendLine(spend: ProviderSessionSpend, withCost: boolean): string {
  if (spend.models === 0) return 'This session: 0 tokens.'
  return `This session: ${spend.inputTokens.toLocaleString()} input · ${spend.outputTokens.toLocaleString()} output tokens${withCost ? ` · ${formatLaneSpend(spend)}` : ''}`
}

export function absentSlotLine(route: string): string {
  return `none — ${route} · n/a`
}
export const INACTIVE_SLOT_LINE = 'not the active billing source this session'

function ApiKeySlot({
  presentLabel,
  isActive,
  spend,
  note,
  creditsLine,
}: {
  presentLabel?: string
  isActive: boolean
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
          <Text dimColor>
            {isActive ? spendLine(spend, true) : INACTIVE_SLOT_LINE}
          </Text>
          {isActive && creditsLine !== undefined ? <Text dimColor>{creditsLine}</Text> : null}
          {isActive && note !== undefined ? <Text dimColor>{note}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

function useOwnerUsage(id: RouterProviderId, credentialed: boolean): ActiveSourceUsage {
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

function figuresLine(usage: ActiveSourceUsage): string | undefined {
  const figures = usage.figures ?? []
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
    limitsNote: 'Usage bills to your OpenAI account; no polled limit meter exists on this lane.',
  },
  zai: {
    title: 'Z.AI usage',
    connect: '/logins zai adds a Z.AI API key (general or GLM Coding Plan; ZAI_API_KEY works too)',
    limitsNote: 'Usage bills to your Z.AI account; no polled limit meter exists on this lane.',
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
  deepseek: {
    title: 'DeepSeek usage',
    connect: '/logins deepseek adds a DeepSeek API key (DEEPSEEK_API_KEY works too)',
    limitsNote: 'Usage bills to your DeepSeek account balance.',
  },
  'openai-compat': {
    title: 'Custom endpoint usage',
    connect: 'set MERCURY_COMPAT_BASE_URL (key optional — /router key compat)',
    limitsNote: 'Usage bills to the endpoint you configured; no polled limit meter exists on this lane.',
  },
  huggingface: {
    title: 'Hugging Face usage',
    connect: '/logins adds Hugging Face (device-code sign-in, or paste a token; HF_TOKEN works too)',
    limitsNote: 'Usage bills to your Hugging Face account; the connected section states what the provider publishes.',
  },
  local: {
    title: 'Local models usage',
    connect: 'start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL',
    limitsNote: 'local · no metering',
  },
}

export interface UsageSection {
  id: RouterProviderId
  kind: 'anthropic' | 'engine'
  title: string
  connect: string
  limitsNote: string
  family: ProviderFamilyPresence
}

export function orderUsageSections(plan: UsageSection[], recency: readonly string[]): UsageSection[] {
  const rank = new Map<string, number>(recency.map((family, index) => [family, index]))
  const byRecency = (a: UsageSection, b: UsageSection): number =>
    (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)
  const signedIn = plan.filter(section => section.family.credentialed).sort(byRecency)
  const absent = plan.filter(section => !section.family.credentialed)
  return [...signedIn, ...absent]
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
  const owner = usageForProvider('openai')
  const limited =
    view.limits.kind === 'openai-observed' && view.limits.window.state === 'limited'
      ? view.limits.window
      : null
  return (
    <Box flexDirection="column">
      <Text bold>OpenAI usage</Text>
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
                no usage signal observed from the account source yet — the weekly meter fills
                after the first GPT reply (no polled endpoint exists on this lane; meters
                derive live from response headers).
              </Text>
            )}
            {limited !== null ? (
              <Text dimColor>
                A usage window is reached — resets {new Date(limited.resetsAtMs).toLocaleString()}.
              </Text>
            ) : null}
            <Text dimColor>
              {active?.kind === 'subscription-oauth'
                ? spendLine(spend, false)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        spend={spend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
        {...(usageCreditsLine(owner.credits) !== undefined ? { creditsLine: usageCreditsLine(owner.credits)! } : {})}
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
  const entries = walletEntries().filter(e => e.provider === 'openrouter')
  const active = activeWalletEntry('openrouter')
  const spend = providerSessionSpend('openrouter')
  const oauth = entries.find(e => e.id === 'openrouter:oauth-key')
  const key = entries.find(e => e.id.startsWith('openrouter:api-key'))
  const usage = useOwnerUsage('openrouter', entries.length > 0)
  const windows = usage.windows
  const creditLine =
    figuresLine(usage) ??
    usage.readerNote ??
    (usage.sourceKind === 'none'
      ? 'no credential — nothing to poll'
      : 'fetching live credit truth from the key endpoint…')
  const balanceLine = usageCreditsLine(usage.credits)
  return (
    <Box flexDirection="column">
      <Text bold>OpenRouter usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="OAuth-minted key" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins openrouter mints a scoped key through the OpenRouter OAuth flow')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.id === oauth.id
                ? spendLine(spend, true)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot presentLabel={key?.label} isActive={active !== undefined && active.id === key?.id} spend={spend} />
      {windows.map(w => (
        <ObservedWindowMeter key={w.key} window={w} title="Key credit cap" {...(width !== undefined ? { maxWidth: width } : {})} />
      ))}
      <Text dimColor>{creditLine}</Text>
      {balanceLine !== undefined ? <Text dimColor>{balanceLine}</Text> : null}
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
  const key = entries.find(e => e.kind === 'api-key')
  const usage = usageForProvider('gemini')
  return (
    <Box flexDirection="column">
      <Text bold>Gemini usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Google account" />
        {oauth === undefined ? (
          <Text dimColor>{absentSlotLine('/logins gemini connects Google OAuth (needs your own OAuth client)')}</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{oauth.label}</Text>
            <Text dimColor>
              {active?.kind === 'oauth'
                ? spendLine(spend, true)
                : INACTIVE_SLOT_LINE}
            </Text>
          </Box>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={key?.label}
        isActive={active?.kind === 'api-key'}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
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
  const usage = usageForProvider('huggingface')
  const rateLine = figuresLine(usage)
  const rateReset = usage.figures?.[0]?.resetsAtMs
  return (
    <Box flexDirection="column">
      <Text bold>Hugging Face usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Sign-in" />
        {account?.kind === 'oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <Text dimColor>{spendLine(spend, false)}</Text>
          </Box>
        ) : (
          <Text dimColor>{absentSlotLine("/logins huggingface signs in with the Hub's device-code flow")}</Text>
        )}
      </Box>
      <ApiKeySlot
        presentLabel={account?.kind === 'api-key' ? account.label : undefined}
        isActive={account?.kind === 'api-key'}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      {account && (rateLine !== undefined || usage.limited !== undefined) ? (
        <Text dimColor>
          {rateLine !== undefined
            ? `${rateLine}${rateReset !== undefined ? ` · resets ${new Date(rateReset).toLocaleTimeString()}` : ''}`
            : ''}
          {usage.limited !== undefined ? ` A limit is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleTimeString()}.` : ''}
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
            <Text dimColor>{spendLine(spend, false)}</Text>
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
        <Text dimColor>not connected — {section.connect}.</Text>
      </Box>
    )
  }
  if (section.id === 'openai') return <OpenaiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'openrouter') return <OpenrouterUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'gemini') return <GeminiUsageSection {...(width !== undefined ? { width } : {})} />
  if (section.id === 'huggingface') return <HuggingfaceUsageSection />
  if (section.id === 'moonshot') return <MoonshotUsageSection />
  if (section.id === 'local') return <LocalUsageSection />
  const spend = providerSessionSpend(section.id)
  return (
    <Box flexDirection="column">
      <Text bold>{section.title}</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        <Text dimColor>{absentSlotLine('this family connects by API key')}</Text>
      </Box>
      <ApiKeySlot
        presentLabel={section.family.credentialLabel}
        isActive={section.family.credentialed}
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      {section.family.credentialed && usage.readerNote !== undefined ? (
        <Text dimColor>{usage.readerNote}</Text>
      ) : null}
      <Text dimColor>
        {section.family.credentialed ? (usage.absence ?? section.limitsNote) : `Not connected — ${section.connect}.`}
      </Text>
    </Box>
  )
}

function MoonshotUsageSection(): React.ReactNode {
  const account = resolveMoonshotAccount()
  const key = resolveMoonshotApiKey()
  const spend = providerSessionSpend('moonshot')
  const usage = useOwnerUsage('moonshot', account !== undefined)
  const windows = usage.windows
  const managedSourceWords = windows[0] !== undefined ? usageSourceWords(windows[0]) : undefined
  return (
    <Box flexDirection="column">
      <Text bold>Moonshot usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Kimi sign-in" />
        {account?.kind === 'kimi-oauth' ? (
          <Box flexDirection="column">
            <Text dimColor>{account.label}</Text>
            <Text dimColor>{spendLine(spend, false)}</Text>
            {windows.length > 0 ? (
              windows.map(window => (
                <Text key={window.key} dimColor>
                  {`${window.label}: ${window.usedPct !== undefined ? `${Math.round(window.usedPct)}% used` : 'no limit stated'}${window.resetsAtMs !== undefined ? ` · resets ${new Date(window.resetsAtMs).toLocaleString()}` : ''}`}
                </Text>
              ))
            ) : (
              <Text dimColor>Plan windows: not yet observed — the usage endpoint is asked on this tab.</Text>
            )}
            {managedSourceWords !== undefined ? (
              <Text dimColor>{`${managedSourceWords} (GET /usages on the coding base)`}</Text>
            ) : null}
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
        spend={spend}
        {...(usageCreditsLine(usage.credits) !== undefined ? { creditsLine: usageCreditsLine(usage.credits)! } : {})}
      />
      <Text dimColor>
        {account
          ? ENGINE_USAGE_PRESENTATION.moonshot!.limitsNote
          : `Not connected — ${ENGINE_USAGE_PRESENTATION.moonshot!.connect}.`}
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
      </Box>
    )
  })()

  const view = providerUsageView('anthropic')
  const keyEntry = view.entries.find(e => e.kind === 'api-key')
  const owner = usageForProvider('anthropic')
  return (
    <Box flexDirection="column">
      <Text bold>Anthropic usage</Text>
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {anthropicSection}
      </Box>
      <ApiKeySlot
        presentLabel={keyEntry?.label}
        isActive={view.activeEntry?.kind === 'api-key'}
        spend={view.sessionSpend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
        {...(usageCreditsLine(owner.credits) !== undefined ? { creditsLine: usageCreditsLine(owner.credits)! } : {})}
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

export const JEV_USAGE_LABEL = "JEV · Mercury's count"

export function jevUsageRow(session: JevSessionFacts = jevSessionFacts()): string {
  const settings = readJevSettings()
  const headword = JEV_STATUS_HEADWORDS[jevSessionStatus(session, settings).kind]
  const count = session.state === 'reported' ? `${jevUsdLabel(session.facts.spendUsd)} · ${session.facts.calls} call${session.facts.calls === 1 ? '' : 's'} (${session.facts.unconfirmedCharges} unconfirmed)` : jevSessionAbsenceWords(session)
  return `${JEV_USAGE_LABEL}: ${count} · allowance ${jevUsdLabel(settings.allowanceUsd)} · ${headword} · credits: ${CREDITS_UNREPORTED_WORDS}`
}

export function usageBodyRows(budget: number): { footerRows: number; jevRows: number; capacity: number } {
  const rows = Math.max(0, Math.floor(budget))
  const footerRows = rows > 1 ? 1 : 0
  const jevRows = rows > 2 ? 1 : 0
  return { footerRows, jevRows, capacity: rows - footerRows - jevRows }
}

export function Usage({ openToken, width = 146, rowBudget = 22 }: { openToken?: number; width?: number; rowBudget?: number }): React.ReactNode {
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency())
  const { perRow, colW, meterW, gap } = usageColumns(width, plan.length)
  const bands: UsageSection[][] = []
  for (let start = 0; start < plan.length; start += perRow) bands.push(plan.slice(start, start + perRow))
  const contentRef = useRef<DOMElement>(null)
  const [heights, setHeights] = useState<number[]>([])
  const [position, setPosition] = useState(0)
  const measure = useCallback(() => {
    const next = contentRef.current?.childNodes.map(node => node.nodeName === '#text' ? 0 : Math.ceil(measureElement(node).height)) ?? []
    setHeights(previous => previous.length === next.length && previous.every((height, index) => height === next[index]) ? previous : next)
  }, [])
  useLayoutEffect(measure)
  const budget = Math.max(0, Math.floor(rowBudget))
  const { footerRows, jevRows, capacity } = usageBodyRows(budget)
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const view = usageWindow(bands.map((band, index) => ({ height: heights[index] ?? 1, count: band.length })), capacity, position)
  useInput((_input, key, event) => {
    if (!key.upArrow && !key.downArrow) return
    event.stopImmediatePropagation()
    setPosition(key.upArrow ? view.previous : view.next)
  })
  const below = bands.slice(view.endBand).flat()
  const more = below.length ? `↓ ${below.length} more · ${below.map(section => section.title.replace(/ usage$/, '')).join(' · ')}` : ''
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
        {jevRows > 0 ? <Box height={1} flexShrink={0}><Text wrap="truncate-end">{jevUsageRow()}</Text></Box> : null}
        {footerRows > 0 ? <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{more}</Text></Box> : null}
      </Box>
    </UsageLayoutContext.Provider>
  )
}
